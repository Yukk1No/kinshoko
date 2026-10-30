//! 框选开始时登记哪些参考图：钉图，以及主窗口里画出的参考图（向页面要一帧当前几何）。
//! 截图前后各要一次，两帧一致才冻结；遮挡关系与图像一起固定。

use kinshoko_core::CommandError;
use kinshoko_core::command_error::ErrorKind;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use kinshoko_core::desktop::{
    CaptureReferenceFrame, CaptureSurface, Placement, SavedPin, ScreenRect,
};
use tauri::{AppHandle, Emitter, Manager};

use super::ReferenceSurface;
use crate::desktop::{lock, pins, state};

/// Only one one-shot native request can receive a WebView reply. HWND is part of its identity.
#[derive(Default)]
pub(crate) struct FrameChannel {
    pending: Mutex<Option<FrameRequest>>,
    changed: Condvar,
}
struct FrameRequest {
    token: String,
    window: isize,
    frame: Option<CaptureReferenceFrame>,
}
impl FrameChannel {
    pub(crate) fn invalidate(&self) {
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
) -> Result<(), CommandError> {
    if window.label() != "main" || !frame.dpr.is_finite() || frame.dpr <= 0.0 {
        return Err(CommandError::new(
            ErrorKind::CaptureInvalidReport,
            "参考图范围报告无效",
        ));
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

fn window_identity(window: &tauri::WebviewWindow) -> Result<isize, CommandError> {
    #[cfg(windows)]
    {
        Ok(window.hwnd().map_err(CommandError::message)?.0 as isize)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(0)
    }
}

#[derive(PartialEq)]
pub(super) struct MainMetrics {
    identity: isize,
    origin: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    dpi: u64,
}
pub(super) fn main_metrics(app: &AppHandle) -> Result<Option<MainMetrics>, CommandError> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(None);
    };
    if !window.is_visible().map_err(CommandError::message)?
        || window.is_minimized().map_err(CommandError::message)?
    {
        return Ok(None);
    }
    Ok(Some(MainMetrics {
        identity: window_identity(&window)?,
        origin: window.inner_position().map_err(CommandError::message)?,
        size: window.inner_size().map_err(CommandError::message)?,
        dpi: window
            .scale_factor()
            .map_err(CommandError::message)?
            .to_bits(),
    }))
}
pub(super) fn request_main_frame(
    app: &AppHandle,
    metrics: &MainMetrics,
) -> Result<CaptureReferenceFrame, CommandError> {
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
    .map_err(CommandError::message)?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut pending = lock(&channel.pending);
    loop {
        let Some(request) = pending.as_mut().filter(|p| p.token == token) else {
            return Err(CommandError::new(
                ErrorKind::CaptureWindowRebuilt,
                "主窗口已重建，请重新框选",
            ));
        };
        if let Some(frame) = request.frame.take() {
            *pending = None;
            return Ok(frame);
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            *pending = None;
            return Err(CommandError::new(
                ErrorKind::CaptureUnconfirmed,
                "无法确认当前可见参考图，请重新框选",
            ));
        };
        pending = channel
            .changed
            .wait_timeout(pending, remaining)
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
}

pub(super) fn references(
    app: &AppHandle,
    main: Option<(&MainMetrics, &CaptureReferenceFrame)>,
) -> Result<Vec<ReferenceSurface>, CommandError> {
    let mut surfaces = pins::capture_surfaces(app);
    if let Some((metrics, frame)) = main {
        for source in &frame.references {
            let library =
                crate::library::visible_source(app, &source.library_id, &source.image_id)?;
            let image = library
                .image(&source.image_id)
                .map_err(CommandError::from)?;
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
            .map_err(CommandError::from)?;
            let screen = |r: ScreenRect| ScreenRect {
                x: metrics.origin.x + r.x,
                y: metrics.origin.y + r.y,
                ..r
            };
            surfaces.push(ReferenceSurface {
                window: "main".into(),
                hwnd: None,
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

pub(super) fn same_surfaces(before: &[ReferenceSurface], after: &[ReferenceSurface]) -> bool {
    before.len() == after.len()
        && before.iter().zip(after).all(|(a, b)| {
            a.window == b.window
                && a.hwnd == b.hwnd
                && a.selection.pin == b.selection.pin
                && a.selection.shown == b.selection.shown
                && a.selection.visible == b.selection.visible
                && a.selection.covered == b.selection.covered
        })
}

// 与图像一起固定遮挡关系；框选窗口出现后，当前 Z 序已不再代表被冻结的屏幕。
fn freeze_visibility(app: &AppHandle, surface: &mut ReferenceSurface) -> bool {
    #[cfg(windows)]
    if let Some(hwnd) = surface.hwnd {
        let Some(covered) = crate::desktop::win32::covering_windows(hwnd) else {
            return false;
        };
        surface.selection.covered.extend(covered);
        return true;
    }
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
        let Some(covered) = crate::desktop::win32::covering_windows(hwnd.0 as isize) else {
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
