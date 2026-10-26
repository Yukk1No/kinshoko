//! 钉图的命令：钉剪贴板、钉截图与参考图，以及菜单动作共用的缩放、旋转与确认显示。

use super::*;

/// 光标处的一个点，作为钉剪贴板和从历史钉住时的“原位置”。
pub(super) fn at_cursor(app: &AppHandle, width: u32, height: u32) -> Result<ScreenRect, String> {
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    Ok(ScreenRect {
        x: cursor.x.floor() as i32,
        y: cursor.y.floor() as i32,
        width,
        height,
    })
}

/// 把剪贴板里的图片存进截图历史并钉在光标旁。
pub(super) fn pin_from_clipboard(app: &AppHandle) -> Result<(), String> {
    let image = arboard::Clipboard::new()
        .and_then(|mut c| c.get_image())
        .map_err(|_| "剪贴板里没有图片".to_owned())?;
    let image = RgbaImage::from_raw(
        image.width as u32,
        image.height as u32,
        image.bytes.into_owned(),
    )
    .ok_or("剪贴板里的图片无法识别")?;
    // 剪贴板图片不带显示器配置文件，按 sRGB 解释。
    let prepared =
        kinshoko_core::desktop::CaptureHistory::prepare(&Screenshot { image, icc: None })
            .map_err(|e| e.to_string())?;
    let entry = lock(&state(app).history)
        .add_prepared(prepared)
        .map_err(|e| e.to_string())?;
    history_changed(app);
    open(app, &entry, at_cursor(app, entry.width, entry.height)?).map(|_| ())
}

/// F3：在别的线程上读剪贴板并钉住。
pub fn pin_clipboard_in_background(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = logged(PinSource::Clipboard, || pin_from_clipboard(&app)) {
            crate::run_log::warn("钉剪贴板失败", e);
        }
    });
}

pub fn copy_to_clipboard(app: &AppHandle, image: &RgbaImage) -> Result<(), String> {
    super::super::clipboard::PreparedImage::prepare(image)?.commit(app)
}

#[tauri::command]
pub async fn pin_clipboard(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        logged(PinSource::Clipboard, || pin_from_clipboard(&app))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 从截图历史钉住一张截图，放在光标旁。
#[tauri::command]
pub async fn pin_capture(app: AppHandle, id: String) -> Result<(), String> {
    logged(PinSource::Capture, || {
        let entry = lock(&state(&app).history)
            .entries()
            .into_iter()
            .find(|e| e.id == id)
            .ok_or("截图已不在截图历史中")?;
        let at = at_cursor(&app, entry.width, entry.height)?;
        open(&app, &entry, at).map(|_| ())
    })
}

/// 钉住一张图；成功时在运行日志里记下用了多久（#219）。
fn logged(from: PinSource, pin: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let started = Instant::now();
    let result = pin();
    if result.is_ok() {
        crate::run_log::record(LogEvent::Pinned {
            from,
            ms: crate::run_log::ms_since(started),
        });
    }
    result
}

/// 从查看器钉整图或局部（见 [`pin_reference_here`]）。
#[tauri::command]
pub async fn pin_reference(
    app: AppHandle,
    window: tauri::Window,
    library_id: String,
    image_id: String,
    crop: Option<Region>,
    shown: ScreenRect,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        logged(PinSource::Reference, || {
            pin_reference_here(&app, &window, &library_id, &image_id, crop, shown)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 画师确认显示这一张被遮蔽的参考图：遮蔽淡出，直到安全模式再次开启或钉图关闭。
pub(super) fn reveal_here(app: &AppHandle, pin: &str) -> Result<(), String> {
    crate::library::with_visibility_commit(app, |_| {
        if !capture_source_open(app, pin) {
            return Err(CLOSED.to_owned());
        }
        let safe = crate::library::safe_mode_on(app);
        let mut veils = lock(&state(app).veils);
        veils.set_safe_mode(safe);
        veils.set_scope(crate::library::safe_mode_scope(app));
        veils.reveal(pin);
        Ok(())
    })?;
    refresh(app, pin);
    Ok(())
}

/// 唤醒 [`wait_shown`]：钉图已显示，或已不在。
pub(super) fn stop_waiting(app: &AppHandle, pin: &str) {
    let waiters = &state(app).pin_shown;
    if let Some(shown) = lock(&waiters.pins).get_mut(pin) {
        *shown = true;
        waiters.changed.notify_all();
    }
}

/// 从钉图此刻的位置出发改它：滑出中的钉图改完就留在这里，不再算收起。
/// `f` 返回 `None`（锁定）时什么都不改。
pub(super) fn change_here(
    app: &AppHandle,
    pin: &str,
    f: impl FnOnce(&mut SavedPin) -> bool,
) -> Result<ScreenRect, String> {
    let at = content_of(app, pin).ok_or(CLOSED)?;
    let rect = edit(app, pin, |p| {
        let before = p.placement;
        p.placement.x = at.x;
        p.placement.y = at.y;
        if f(p) {
            Some(p.rect())
        } else {
            p.placement = before;
            None
        }
    })
    .ok_or(CLOSED)?
    .ok_or(LOCKED)?;
    lock(&state(app).edge).release(pin);
    Ok(rect)
}

/// 以钉图中心为锚点缩放到 `scale`（菜单“原始大小”）。锁定的钉图不缩放。内容以动画到达。
pub(super) fn zoom(app: &AppHandle, pin: &str, scale: f64) -> Result<(), String> {
    let rect = change_here(app, pin, |p| {
        let r = p.rect();
        let centre = (
            f64::from(r.x) + f64::from(r.width) / 2.0,
            f64::from(r.y) + f64::from(r.height) / 2.0,
        );
        p.zoom(scale, centre)
    })?;
    show(app, pin, rect, PinMotion::Zoom, false)
}

/// 翻转或旋转钉图（中心不动）。
pub(super) fn turn_here(app: &AppHandle, pin: &str, turn: Turn) -> Result<(), String> {
    let rect = change_here(app, pin, |p| {
        p.turn(turn);
        true
    })?;
    show(app, pin, rect, PinMotion::Jump, false)
}
