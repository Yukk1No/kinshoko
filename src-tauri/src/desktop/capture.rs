//! 框选截图（F1）：冻结光标所在的显示器，在上面框选区域，钉住或复制。
//!
//! 流程（#7 原型）：抓取整台显示器 → 记下截取时的显示器配置文件 → 在显示器的物理矩形上
//! 建一个隐藏的框选窗口 → 页面载入冻结屏幕后调用 `capture_ready` 才显示，免得先闪一下空窗口。
//! 选区以相对显示器的物理像素传回；落在未遮挡参考图内时保留来源，否则裁下后存入截图历史。

use std::sync::atomic::Ordering;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use kinshoko_core::desktop::{
    CaptureAction, CaptureOutcome, CaptureReferenceFrame, CaptureSelection, CaptureSurface,
    FrozenScreen, Placement, Region, SavedPin, ScreenRect, Screenshot,
};
use kinshoko_core::reference_groups::ReferenceSource;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

use super::{clipboard::PreparedImage, history_changed, lock, pins, state};

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
    safe_generation: u64,
}

pub(super) struct ReferenceSurface {
    pub window: String,
    pub selection: CaptureSurface,
}

/// Only one one-shot native request can receive a WebView reply. HWND is part of its identity.
#[derive(Default)]
pub(super) struct FrameChannel {
    pending: Mutex<Option<FrameRequest>>,
    changed: Condvar,
}
struct FrameRequest {
    token: String,
    window: isize,
    frame: Option<CaptureReferenceFrame>,
}
impl FrameChannel {
    pub(super) fn invalidate(&self) {
        *lock(&self.pending) = None;
        self.changed.notify_all();
    }
}

#[tauri::command]
pub fn report_capture_references(
    app: AppHandle,
    window: tauri::WebviewWindow,
    request: String,
    frame: CaptureReferenceFrame,
) -> Result<(), String> {
    if window.label() != "main" || !frame.dpr.is_finite() || frame.dpr <= 0.0 {
        return Err("参考图范围报告无效".into());
    }
    let identity = window_identity(&window)?;
    let channel = &state(&app).capture_frames;
    let mut pending = lock(&channel.pending);
    if let Some(pending) = pending.as_mut()
        && pending.token == request
        && pending.window == identity
        && pending.frame.is_none()
    {
        pending.frame = Some(frame);
        channel.changed.notify_all();
    }
    Ok(())
}

fn window_identity(window: &tauri::WebviewWindow) -> Result<isize, String> {
    #[cfg(windows)]
    {
        Ok(window.hwnd().map_err(|e| e.to_string())?.0 as isize)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(0)
    }
}

#[derive(PartialEq)]
struct MainMetrics {
    identity: isize,
    origin: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    dpi: u64,
}
fn main_metrics(app: &AppHandle) -> Result<Option<MainMetrics>, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(None);
    };
    if !window.is_visible().map_err(|e| e.to_string())?
        || window.is_minimized().map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    Ok(Some(MainMetrics {
        identity: window_identity(&window)?,
        origin: window.inner_position().map_err(|e| e.to_string())?,
        size: window.inner_size().map_err(|e| e.to_string())?,
        dpi: window.scale_factor().map_err(|e| e.to_string())?.to_bits(),
    }))
}
fn request_main_frame(
    app: &AppHandle,
    metrics: &MainMetrics,
) -> Result<CaptureReferenceFrame, String> {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let channel = &state(app).capture_frames;
    *lock(&channel.pending) = Some(FrameRequest {
        token: token.clone(),
        window: metrics.identity,
        frame: None,
    });
    app.emit_to(
        "main",
        "capture-reference-request",
        serde_json::json!({ "request": token }),
    )
    .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut pending = lock(&channel.pending);
    loop {
        let Some(request) = pending.as_mut().filter(|p| p.token == token) else {
            return Err("主窗口已重建，请重新框选".into());
        };
        if let Some(frame) = request.frame.take() {
            *pending = None;
            return Ok(frame);
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            *pending = None;
            return Err("无法确认当前可见参考图，请重新框选".into());
        };
        pending = channel
            .changed
            .wait_timeout(pending, remaining)
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
}

fn references(
    app: &AppHandle,
    main: Option<(&MainMetrics, &CaptureReferenceFrame)>,
) -> Result<Vec<ReferenceSurface>, String> {
    let mut surfaces = pins::capture_surfaces(app);
    if let Some((metrics, frame)) = main {
        for source in &frame.references {
            let library =
                crate::library::visible_source(app, &source.library_id, &source.image_id)?;
            let image = library.image(&source.image_id).map_err(|e| e.to_string())?;
            let pin = SavedPin::reference(
                &format!("wall-{}-{}", source.library_id, source.image_id),
                &source.library_id,
                &kinshoko_core::library::ReferenceImage {
                    id: source.image_id.clone(),
                    width: image.width,
                    height: image.height,
                    sealed: false,
                },
                None,
                Placement::default(),
            )
            .map_err(|e| e.to_string())?;
            let screen = |r: ScreenRect| ScreenRect {
                x: metrics.origin.x + r.x,
                y: metrics.origin.y + r.y,
                ..r
            };
            surfaces.push(ReferenceSurface {
                window: "main".into(),
                selection: CaptureSurface {
                    pin,
                    shown: screen(source.shown),
                    visible: screen(source.visible),
                    covered: source.covered.iter().copied().map(screen).collect(),
                },
            });
        }
    }
    surfaces.retain_mut(|surface| freeze_visibility(app, surface));
    Ok(surfaces)
}

fn same_surfaces(before: &[ReferenceSurface], after: &[ReferenceSurface]) -> bool {
    before.len() == after.len()
        && before.iter().zip(after).all(|(a, b)| {
            a.window == b.window
                && a.selection.pin == b.selection.pin
                && a.selection.shown == b.selection.shown
                && a.selection.visible == b.selection.visible
                && a.selection.covered == b.selection.covered
        })
}

// 与图像一起固定遮挡关系；框选窗口出现后，当前 Z 序已不再代表被冻结的屏幕。
fn freeze_visibility(app: &AppHandle, surface: &mut ReferenceSurface) -> bool {
    let Some(window) = app.get_webview_window(&surface.window) else {
        return false;
    };
    if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(true) {
        return false;
    }
    #[cfg(windows)]
    {
        let Ok(hwnd) = window.hwnd() else {
            return false;
        };
        let Some(covered) = super::win32::covering_windows(hwnd.0 as isize) else {
            return false;
        };
        surface.selection.covered.extend(covered);
        true
    }
    #[cfg(not(windows))]
    {
        window.is_focused().unwrap_or(false)
    }
}

/// 开始截图：已经在框选时把框选窗口叫到前面，否则在别的线程上抓屏。
pub fn start(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(CAPTURE_WINDOW) {
        let _ = window.set_focus();
        return;
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    {
        let mut session = lock(&state(app).capture);
        if !matches!(*session, Session::Idle) {
            return;
        }
        *session = Session::Grabbing(token.clone());
    }
    let worker = app.clone();
    let worker_token = token.clone();
    let spawned = std::thread::Builder::new()
        .name("kinshoko-capture".into())
        .spawn(move || {
            if let Err(e) = grab_and_show(&worker, &worker_token) {
                eprintln!("截图失败：{e}");
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
        let _ = window.destroy();
    }
}

fn grab_and_show(app: &AppHandle, token: &str) -> Result<(), String> {
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let monitor = xcap::Monitor::from_point(cursor.x.floor() as i32, cursor.y.floor() as i32)
        .map_err(|e| e.to_string())?;
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
        let image = monitor.capture_image().map_err(|e| e.to_string())?;
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
    let (image, references) = frozen.ok_or_else(|| "参考图正在移动，请重新框选".to_owned())?;
    let origin = (
        monitor.x().map_err(|e| e.to_string())?,
        monitor.y().map_err(|e| e.to_string())?,
    );
    let icc = monitor.name().ok().and_then(|name| display_profile(&name));
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
    .additional_browser_args(crate::diagnostics::browser_args())
    .build()
    .map_err(|e| e.to_string())?;
    // 先移到目标显示器再定尺寸：跨越缩放比例不同的显示器时，移动会先按新比例改一次尺寸。
    window
        .set_position(PhysicalPosition::new(origin.0, origin.1))
        .map_err(|e| e.to_string())?;
    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
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
    match &*lock(&state(&app).capture) {
        Session::Ready(p) => Some(FrozenScreen {
            width: p.screen.image.width(),
            height: p.screen.image.height(),
            image: format!("screen/{}", p.token),
        }),
        _ => None,
    }
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
    }
}

#[tauri::command]
pub async fn cancel_capture(app: AppHandle, token: String) {
    close_owned(&app, &token);
}

/// Recheck the frozen source after decoding, while the final visibility permit is held.
/// The frozen geometry remains authoritative; later scrolling does not change its crop.
fn validate_source(app: &AppHandle, pending: &Pending, selected: ScreenRect) -> Result<(), String> {
    let mut candidates = pending
        .references
        .iter()
        .filter(|surface| surface.selection.reference_region(selected).is_some());
    let surface = match (candidates.next(), candidates.next()) {
        (Some(surface), None) => surface,
        _ => return Ok(()), // Ordinary screen selection, as in CaptureSelection::finish.
    };
    let kinshoko_core::desktop::PinContent::Reference {
        library_id,
        image_id,
        source_width,
        source_height,
    } = &surface.selection.pin.content
    else {
        return Err("参考图来源已变化，请重新框选".into());
    };
    if surface.window == "main" {
        // Includes the strictest rating of every known byte-identical provider.
        crate::library::visible_source(app, library_id, image_id)?;
    } else if app.get_webview_window(&surface.window).is_none() {
        return Err("参考图已关闭，请重新框选".into());
    }
    let image = crate::library::with_references(app, |sources| sources.image(library_id, image_id))
        .map_err(|error| error.to_string())?;
    if image.width != *source_width || image.height != *source_height {
        return Err("参考图来源已变化，请重新框选".into());
    }
    let safe = crate::library::safe_mode_on(app);
    let mut veils = lock(&state(app).veils);
    // Event delivery may lag the committed setting. Never authorize against an old event.
    veils.set_safe_mode(safe);
    if veils.veiled(&surface.selection.pin, Some(image.sealed)) {
        return Err("参考图已被遮蔽，请重新框选".into());
    }
    Ok(())
}

/// 框选完成。`region` 是相对显示器的物理像素。
#[tauri::command]
pub async fn finish_capture(
    app: AppHandle,
    region: Region,
    action: CaptureAction,
    token: String,
) -> Result<(), String> {
    let pending = {
        let mut session = lock(&state(&app).capture);
        match std::mem::replace(&mut *session, Session::Grabbing(token.clone())) {
            Session::Ready(p) if p.token == token => p,
            other => {
                *session = other;
                return Err("没有进行中的截图".to_owned());
            }
        }
    };
    close_owned(&app, &token);
    tauri::async_runtime::spawn_blocking(move || {
        let references: Vec<_> = pending
            .references
            .iter()
            .map(|s| s.selection.clone())
            .collect();
        let selection = CaptureSelection {
            screen: &pending.screen,
            origin: pending.origin,
            region,
            references: &references,
        };
        let at = selection.screen_rect().map_err(|e| e.to_string())?;
        if crate::library::capture_generation(&app) != pending.safe_generation {
            return Err("安全模式已变化，请重新框选".into());
        }
        validate_source(&app, &pending, at)?;
        let draft = crate::library::with_references(&app, |sources| {
            selection.prepare(
                action,
                &uuid::Uuid::new_v4().simple().to_string(),
                sources,
                &lock(&state(&app).veils),
            )
        })
        .map_err(|e| e.to_string())?;
        // PNG compression and DIBV5 conversion finish before taking visibility authority.
        // Revocation can return while these expensive, discardable preparations are running.
        let clipboard = draft
            .clipboard_image()
            .map(PreparedImage::prepare)
            .transpose()?;
        // Mode/settings, source edits, providers and automatic ratings share this commit gate.
        // Only history persistence and the actual OS/pin side effect occur within it.
        crate::library::with_visibility_commit(&app, |generation| {
            if generation != pending.safe_generation {
                return Err("安全模式已变化，请重新框选".into());
            }
            validate_source(&app, &pending, at)?;
            let outcome = draft
                .commit(&mut lock(&state(&app).history))
                .map_err(|error| error.to_string())?;
            match outcome {
                CaptureOutcome::PinReference(pin) => pins::open_reference_selection(&app, pin, at),
                CaptureOutcome::CopyReference(_) => clipboard
                    .expect("copy draft prepared clipboard formats")
                    .commit(&app),
                CaptureOutcome::PinCapture(entry) => {
                    history_changed(&app);
                    pins::open(
                        &app,
                        &entry,
                        ScreenRect {
                            width: entry.width,
                            height: entry.height,
                            ..at
                        },
                    )
                }
                CaptureOutcome::CopyCapture(_) => {
                    history_changed(&app);
                    clipboard
                        .expect("copy draft prepared clipboard formats")
                        .commit(&app)
                }
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
