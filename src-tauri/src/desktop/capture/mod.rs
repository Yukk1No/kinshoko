//! 框选截图（F1）：冻结光标所在的显示器，在上面框选区域，钉住或复制。
//!
//! 流程（#7 原型）：抓取整台显示器 → 记下截取时的显示器配置文件 → 把隐藏的框选窗口移到显示器的
//! 物理矩形上（让出最下面一行，ADR 0011）→ 页面载入冻结屏幕后调用 `capture_ready` 才显示，免得先闪一下空窗口。
//! 框选窗口第一次用时建好、结束时只隐藏，下次复用（#129，与钉图菜单窗口相同）：每次 F1 新建 WebView
//! 要 0.2～2 秒，主窗口关着时更要冷启动 WebView2，是按键后迟迟没有反应的主因。
//! 选区以相对显示器的物理像素传回；落在未遮挡参考图内时保留来源、按原始像素裁下，否则裁下屏幕像素。
//! 两种结果都存入截图历史（#227）。

use kinshoko_core::CommandError;

mod finish;
mod sources;

use std::sync::Arc;
use std::sync::atomic::Ordering;

use kinshoko_core::desktop::{
    CaptureSelection, CaptureSurface, FrozenScreen, OriginalPixels, Region, ScreenRect, Screenshot,
    overlay_window,
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

pub use finish::*;
pub use sources::*;
use sources::{main_metrics, references, request_main_frame, same_surfaces};

use super::{lock, state};
use crate::data_dirs::SharedWebview as _;
use kinshoko_core::diagnostics::{LogEvent, WindowKind};
use kinshoko_core::safe_mode::SafeModeSnapshot;

pub const CAPTURE_WINDOW: &str = "capture";

/// 一次截图的进度。同一时间只有一次。
pub enum Session {
    Idle,
    /// 正在抓屏、建窗口。
    Grabbing(String),
    /// 冻结屏幕已就绪，等画师框选。
    Ready(Pending),
}

pub struct Pending {
    screen: Arc<Screenshot>,
    /// 显示器左上角，物理像素。
    origin: (i32, i32),
    /// 冻结屏幕的一次性标记，防止页面拿到上一次的图。
    token: String,
    references: Vec<ReferenceSurface>,
    safe_generation: SafeModeSnapshot,
}

pub(super) struct ReferenceSurface {
    pub window: String,
    /// 原生钉图（没有 WebView 窗口）：看得见的槽的窗口句柄。
    pub hwnd: Option<isize>,
    pub selection: CaptureSurface,
}

/// 开始截图：已经在框选时把框选窗口叫到前面，否则在别的线程上抓屏。
pub fn start(app: &AppHandle) {
    super::timing("start");
    crate::run_log::record(LogEvent::CaptureStarted);
    let token = uuid::Uuid::new_v4().simple().to_string();
    {
        let mut session = lock(&state(app).capture);
        match *session {
            Session::Idle => {}
            Session::Ready(_) => {
                if let Some(window) = app.get_webview_window(CAPTURE_WINDOW) {
                    let _ = window.set_focus();
                }
                return;
            }
            Session::Grabbing(_) => return,
        }
        *session = Session::Grabbing(token.clone());
    }
    let worker = app.clone();
    let worker_token = token.clone();
    let spawned = std::thread::Builder::new()
        .name("kinshoko-capture".into())
        .spawn(move || {
            if let Err(e) = grab_and_show(&worker, &worker_token) {
                crate::run_log::error("截图失败", e);
                close_owned(&worker, &worker_token);
            }
        });
    if spawned.is_err() {
        *lock(&state(app).capture) = Session::Idle;
    }
}

fn close_owned(app: &AppHandle, token: &str) {
    let owns = {
        let mut session = lock(&state(app).capture);
        let owns = match &*session {
            Session::Ready(p) => p.token == token,
            Session::Grabbing(t) => t == token,
            Session::Idle => false,
        };
        if owns {
            *session = Session::Idle;
        }
        owns
    };
    if owns && let Some(window) = app.get_webview_window(CAPTURE_WINDOW) {
        // 留着给下一次（#129）：先隐藏，再让页面丢掉这次的冻结屏幕与选区。
        let _ = window.hide();
        crate::run_log::record(LogEvent::WindowHidden {
            window: WindowKind::Capture,
        });
        let _ = window.emit_to(CAPTURE_WINDOW, SESSION_EVENT, ());
    }
}

/// 离开作用域时 [`close_owned`]。
struct CloseOnDrop<'a>(&'a AppHandle, &'a str);

impl Drop for CloseOnDrop<'_> {
    fn drop(&mut self) {
        close_owned(self.0, self.1);
    }
}

/// 告诉框选页面：会话变了（有了新的冻结屏幕，或已结束），重新取 `frozen_screen`。
const SESSION_EVENT: &str = "capture-session";

fn capture_window(app: &AppHandle) -> Result<tauri::WebviewWindow, CommandError> {
    if let Some(window) = app.get_webview_window(CAPTURE_WINDOW) {
        return Ok(window);
    }
    let started = std::time::Instant::now();
    let window = WebviewWindowBuilder::new(
        app,
        CAPTURE_WINDOW,
        WebviewUrl::App("index.html?view=capture".into()),
    )
    .title("Kinshoko 截图")
    .decorations(false)
    .resizable(false)
    .shadow(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible(false)
    .shared_webview(app)
    .build()
    .map_err(CommandError::message)?;
    crate::run_log::window_created(WindowKind::Capture, started);
    Ok(window)
}

fn grab_and_show(app: &AppHandle, token: &str) -> Result<(), CommandError> {
    let cursor = app.cursor_position().map_err(CommandError::message)?;
    let monitor = xcap::Monitor::from_point(cursor.x.floor() as i32, cursor.y.floor() as i32)
        .map_err(CommandError::message)?;
    let safe_generation = crate::library::capture_generation(app);
    let mut frozen = None;
    for _ in 0..5 {
        let geometry_generation = state(app)
            .capture_geometry_generation
            .load(Ordering::SeqCst);
        let metrics = main_metrics(app)?;
        let before = metrics
            .as_ref()
            .map(|m| request_main_frame(app, m))
            .transpose()?;
        if main_metrics(app)? != metrics {
            continue;
        }
        let before_surfaces = references(app, metrics.as_ref().zip(before.as_ref()))?;
        let image = monitor.capture_image().map_err(CommandError::message)?;
        super::timing("grabbed");
        let after = metrics
            .as_ref()
            .map(|m| request_main_frame(app, m))
            .transpose()?;
        if main_metrics(app)? != metrics || before != after {
            continue;
        }
        let confirmed = references(app, metrics.as_ref().zip(after.as_ref()))?;
        if state(app)
            .capture_geometry_generation
            .load(Ordering::SeqCst)
            != geometry_generation
            || !same_surfaces(&before_surfaces, &confirmed)
        {
            continue;
        }
        if crate::library::capture_generation(app) != safe_generation {
            return Err("安全模式已变化，请重新框选".into());
        }
        frozen = Some((image, before_surfaces));
        break;
    }
    let (image, references) =
        frozen.ok_or_else(|| CommandError::from("参考图正在移动，请重新框选"))?;
    let origin = (
        monitor.x().map_err(CommandError::message)?,
        monitor.y().map_err(CommandError::message)?,
    );
    let icc = monitor.name().ok().and_then(|name| display_profile(&name));
    super::timing(&format!(
        "frozen references={} covered={}",
        references.len(),
        references
            .iter()
            .map(|r| r.selection.covered.len())
            .sum::<usize>()
    ));
    let (width, height) = image.dimensions();
    {
        let mut session = lock(&state(app).capture);
        if !matches!(&*session, Session::Grabbing(t) if t == token)
            || crate::library::capture_generation(app) != safe_generation
        {
            return Err("截图会话已失效，请重新框选".into());
        }
        *session = Session::Ready(Pending {
            screen: Arc::new(Screenshot { image, icc }),
            origin,
            token: token.to_owned(),
            references,
            safe_generation,
        });
    }

    let window = capture_window(app)?;
    super::timing("window.built");
    // 窗口让出显示器最下面一行，免得被当成全屏程序（#230，ADR 0011）；冻结屏幕仍是整台显示器，
    // 拖到最下面时选区补上这一行（页面的 `reachEdges`）。
    let rect = overlay_window(ScreenRect {
        x: origin.0,
        y: origin.1,
        width,
        height,
    });
    // 先移到目标显示器再定尺寸：跨越缩放比例不同的显示器时，移动会先按新比例改一次尺寸。
    window
        .set_position(PhysicalPosition::new(rect.x, rect.y))
        .map_err(CommandError::message)?;
    window
        .set_size(PhysicalSize::new(rect.width, rect.height))
        .map_err(CommandError::message)?;
    // 复用的页面早已载入：通知它取这次的冻结屏幕。新建的页面载入时自己会取。
    window
        .emit_to(CAPTURE_WINDOW, SESSION_EVENT, ())
        .map_err(CommandError::message)?;
    Ok(())
}

#[cfg(windows)]
fn display_profile(device: &str) -> Option<Vec<u8>> {
    super::win32::display_profile(device)
}

#[cfg(not(windows))]
fn display_profile(_device: &str) -> Option<Vec<u8>> {
    None
}

/// 冻结屏幕的 PNG，供自定义协议使用。标记不对（已是上一次的截图）时为 `None`。
pub fn frozen_png(app: &AppHandle, token: &str) -> Option<Vec<u8>> {
    let screen = match &*lock(&state(app).capture) {
        Session::Ready(p) if p.token == token => p.screen.clone(),
        _ => return None,
    };
    let mut png = Vec::new();
    screen.write_png(&mut png, true).ok()?;
    Some(png)
}

/// 开始截图（主窗口的“截图”按钮）。
#[tauri::command]
pub async fn start_capture(app: AppHandle) {
    start(&app);
}

/// 框选窗口要显示的冻结屏幕；没有进行中的截图时为 `None`。
#[tauri::command]
pub async fn frozen_screen(app: AppHandle) -> Option<FrozenScreen> {
    super::timing("frozen_screen");
    match &*lock(&state(&app).capture) {
        Session::Ready(p) => Some(FrozenScreen {
            width: p.screen.image.width(),
            height: p.screen.image.height(),
            image: format!("screen/{}", p.token),
        }),
        _ => None,
    }
}

/// 框选读数（#103）：选区（相对显示器的物理像素）得到参考视图时为结果的原始像素尺寸，
/// 普通截图为 `None`。只读冻结时的来源，与完成时的判断相同。
#[tauri::command]
pub async fn capture_readout(
    app: AppHandle,
    region: Region,
    token: String,
) -> Option<OriginalPixels> {
    let session = lock(&state(&app).capture);
    let Session::Ready(pending) = &*session else {
        return None;
    };
    if pending.token != token {
        return None;
    }
    let references: Vec<_> = pending
        .references
        .iter()
        .map(|s| s.selection.clone())
        .collect();
    CaptureSelection {
        screen: &pending.screen,
        origin: pending.origin,
        region,
        references: &references,
    }
    .original_pixels()
}

/// 冻结屏幕已经画好：显示框选窗口。
#[tauri::command]
pub async fn capture_ready(app: AppHandle, token: String) {
    if !matches!(&*lock(&state(&app).capture), Session::Ready(p) if p.token == token) {
        return;
    }
    if let Some(window) = app.get_webview_window(CAPTURE_WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
        super::timing("shown");
    }
}

#[tauri::command]
pub async fn cancel_capture(app: AppHandle, token: String) {
    close_owned(&app, &token);
}
