//! 框选截图（F1）：冻结光标所在的显示器，在上面框选区域，钉住或复制。
//!
//! 流程（#7 原型）：抓取整台显示器 → 记下截取时的显示器配置文件 → 在显示器的物理矩形上
//! 建一个隐藏的框选窗口 → 页面载入冻结屏幕后调用 `capture_ready` 才显示，免得先闪一下空窗口。
//! 选区以相对显示器的物理像素传回；落在未遮挡参考图内时保留来源，否则裁下后存入截图历史。

use std::sync::Arc;

use kinshoko_core::desktop::{
    CaptureAction, CaptureReference, FrozenScreen, Placement, Region, SavedPin, ScreenRect,
    Screenshot,
};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use super::{history_changed, lock, pins, state};

pub const CAPTURE_WINDOW: &str = "capture";

/// 一次截图的进度。同一时间只有一次。
pub enum Session {
    Idle,
    /// 正在抓屏、建窗口。
    Grabbing,
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
}

pub(super) struct ReferenceSurface {
    pub window: String,
    pub pin: SavedPin,
    pub shown: ScreenRect,
    pub visible: ScreenRect,
    pub covered: Vec<ScreenRect>,
}

/// 查看器只报告已经画出的图；坐标相对客户区，截图冻结时才换成屏幕坐标。
#[tauri::command]
pub fn set_capture_reference(
    app: AppHandle,
    window: tauri::WebviewWindow,
    reference: Option<CaptureReference>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有主查看器能报告参考图范围".into());
    }
    *lock(&state(&app).viewer_reference) = reference;
    Ok(())
}

fn references(app: &AppHandle) -> Vec<ReferenceSurface> {
    let mut surfaces = pins::capture_surfaces(app);
    let viewer = lock(&state(app).viewer_reference).clone();
    let main = (|| -> Option<ReferenceSurface> {
        let viewer = viewer?;
        let window = app.get_webview_window("main")?;
        if !window.is_visible().ok()? {
            return None;
        }
        let image = crate::library::current(app, &viewer.library_id)
            .ok()?
            .image(&viewer.image_id)
            .ok()?;
        let pin = SavedPin::reference(
            "viewer",
            &viewer.library_id,
            &kinshoko_core::library::ReferenceImage {
                id: viewer.image_id,
                width: image.width,
                height: image.height,
                sealed: false,
            },
            None,
            Placement::default(),
        )
        .ok()?;
        let origin = window.inner_position().ok()?;
        let screen = |r: ScreenRect| ScreenRect {
            x: origin.x + r.x,
            y: origin.y + r.y,
            ..r
        };
        Some(ReferenceSurface {
            window: "main".into(),
            pin,
            shown: screen(viewer.shown),
            visible: screen(viewer.visible),
            covered: Vec::new(),
        })
    })();
    surfaces.extend(main);
    surfaces.retain_mut(|surface| freeze_visibility(app, surface));
    surfaces
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
        surface.covered = covered;
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
    {
        let mut session = lock(&state(app).capture);
        if !matches!(*session, Session::Idle) {
            return;
        }
        *session = Session::Grabbing;
    }
    let worker = app.clone();
    let spawned = std::thread::Builder::new()
        .name("kinshoko-capture".into())
        .spawn(move || {
            if let Err(e) = grab_and_show(&worker) {
                eprintln!("截图失败：{e}");
                close(&worker);
            }
        });
    if spawned.is_err() {
        *lock(&state(app).capture) = Session::Idle;
    }
}

/// 结束截图，关掉框选窗口。
fn close(app: &AppHandle) {
    *lock(&state(app).capture) = Session::Idle;
    if let Some(window) = app.get_webview_window(CAPTURE_WINDOW) {
        let _ = window.destroy();
    }
}

fn grab_and_show(app: &AppHandle) -> Result<(), String> {
    let references = references(app);
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let monitor = xcap::Monitor::from_point(cursor.x.floor() as i32, cursor.y.floor() as i32)
        .map_err(|e| e.to_string())?;
    let image = monitor.capture_image().map_err(|e| e.to_string())?;
    let origin = (
        monitor.x().map_err(|e| e.to_string())?,
        monitor.y().map_err(|e| e.to_string())?,
    );
    let icc = monitor.name().ok().and_then(|name| display_profile(&name));
    let (width, height) = image.dimensions();
    *lock(&state(app).capture) = Session::Ready(Pending {
        screen: Arc::new(Screenshot { image, icc }),
        origin,
        token: uuid::Uuid::new_v4().simple().to_string(),
        references,
    });

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
pub async fn capture_ready(app: AppHandle) {
    if let Some(window) = app.get_webview_window(CAPTURE_WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub async fn cancel_capture(app: AppHandle) {
    close(&app);
}

/// 框选完成。`region` 是相对显示器的物理像素。
#[tauri::command]
pub async fn finish_capture(
    app: AppHandle,
    region: Region,
    action: CaptureAction,
) -> Result<(), String> {
    let pending = {
        let mut session = lock(&state(&app).capture);
        match std::mem::replace(&mut *session, Session::Grabbing) {
            Session::Ready(p) => p,
            other => {
                *session = other;
                return Err("没有进行中的截图".to_owned());
            }
        }
    };
    close(&app);
    let selected = ScreenRect {
        x: pending.origin.0 + region.x as i32,
        y: pending.origin.1 + region.y as i32,
        width: region.width,
        height: region.height,
    };
    for surface in &pending.references {
        if !surface.visible.contains(&selected)
            || surface
                .covered
                .iter()
                .any(|r| r.intersect(&selected).is_some())
        {
            continue;
        }
        if let Some(crop) = surface.pin.reference_region(surface.shown, selected) {
            return match action {
                CaptureAction::Pin => pins::open_reference_crop(&app, &surface.pin, crop, selected),
                CaptureAction::Copy => {
                    let shot = pending.screen.crop(region).ok_or("选区是空的")?;
                    pins::copy_to_clipboard(&shot.image)
                }
            };
        }
    }
    let shot = pending.screen.crop(region).ok_or("选区是空的")?;
    let entry = lock(&state(&app).history)
        .add(&shot)
        .map_err(|e| e.to_string())?;
    history_changed(&app);
    match action {
        CaptureAction::Pin => {
            let at = ScreenRect {
                x: pending.origin.0 + region.x as i32,
                y: pending.origin.1 + region.y as i32,
                width: entry.width,
                height: entry.height,
            };
            pins::open(&app, &entry, at)
        }
        CaptureAction::Copy => pins::copy_to_clipboard(&shot.image),
    }
}
