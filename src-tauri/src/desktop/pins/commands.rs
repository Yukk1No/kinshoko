//! 钉图的命令：钉剪贴板、钉截图与参考图，移动、缩放、旋转、透明度与锁定。

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
        if let Err(e) = pin_from_clipboard(&app) {
            eprintln!("钉剪贴板失败：{e}");
        }
    });
}

pub fn copy_to_clipboard(app: &AppHandle, image: &RgbaImage) -> Result<(), String> {
    super::super::clipboard::PreparedImage::prepare(image)?.commit(app)
}

#[tauri::command]
pub async fn pin_clipboard(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pin_from_clipboard(&app))
        .await
        .map_err(|e| e.to_string())?
}

/// 从截图历史钉住一张截图，放在光标旁。
#[tauri::command]
pub async fn pin_capture(app: AppHandle, id: String) -> Result<(), String> {
    let entry = lock(&state(&app).history)
        .entries()
        .into_iter()
        .find(|e| e.id == id)
        .ok_or("截图已不在截图历史中")?;
    let at = at_cursor(&app, entry.width, entry.height)?;
    open(&app, &entry, at).map(|_| ())
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
        pin_reference_here(&app, &window, &library_id, &image_id, crop, shown)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 画师确认显示这一张被遮蔽的参考图：遮蔽淡出，直到安全模式再次开启或钉图关闭。
#[tauri::command]
pub async fn reveal_pin(app: AppHandle, pin: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || reveal_here(&app, &pin))
        .await
        .map_err(|e| e.to_string())?
}

pub(super) fn reveal_here(app: &AppHandle, pin: &str) -> Result<(), String> {
    crate::library::with_visibility_commit(app, |_| {
        if !capture_source_open(app, pin) {
            return Err(CLOSED.to_owned());
        }
        let safe = crate::library::safe_mode_on(app);
        let mut veils = lock(&state(app).veils);
        veils.set_safe_mode(safe);
        veils.reveal(pin);
        Ok(())
    })?;
    refresh(app, pin);
    Ok(())
}

/// 钉图层（调用的窗口）要画的这个钉图、层窗口与内容的位置。钉图已关闭或不在这个层里时为 `None`。
#[tauri::command]
pub async fn pin_frame(
    app: AppHandle,
    window: tauri::WebviewWindow,
    pin: String,
) -> Option<PinFrame> {
    frames(&app, &pin, None)
        .into_iter()
        .find(|(layer, _)| layer == window.label())
        .map(|(_, f)| f)
}

/// 钉图层（调用的窗口）此刻画着的钉图。层的页面加载好时取一次，之后按帧与 `pin-gone` 更新。
#[tauri::command]
pub async fn pin_layer_pins(app: AppHandle, window: tauri::WebviewWindow) -> Vec<String> {
    lock(&state(&app).pins)
        .iter()
        .filter(|(_, r)| r.layers.iter().any(|l| l == window.label()))
        .map(|(id, _)| id.clone())
        .collect()
}

/// 按下了这个钉图：它到最上面。
#[tauri::command]
pub async fn raise_pin(app: AppHandle, pin: String) {
    let top = {
        let mut pins = lock(&state(&app).pins);
        let max = pins.values().map(|r| r.z).max().unwrap_or(0);
        match pins.get_mut(&pin) {
            Some(r) if r.z < max => {
                r.z = next_z();
                true
            }
            _ => false,
        }
    };
    if top {
        refresh(&app, &pin);
    }
}

/// Esc 只关闭光标下（或最近按过）的那个钉图，后续沿用关闭时的持久状态与截图历史清理。
#[tauri::command]
pub async fn close_pin(
    app: AppHandle,
    window: tauri::WebviewWindow,
    pin: String,
) -> Result<(), String> {
    let here = lock(&state(&app).pins)
        .get(&pin)
        .is_some_and(|r| r.layers.iter().any(|l| l == window.label()));
    if !here {
        return Err("只能关闭当前钉图".to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || close(&app, &pin))
        .await
        .map_err(|e| e.to_string())
}

/// 钉图层（调用的窗口）画好了这个钉图的第一帧：层还隐藏着时显示它；交接中的钉图等新层都画好了，
/// 旧层才放手。
#[tauri::command]
pub async fn pin_ready(app: AppHandle, window: tauri::WebviewWindow, pin: String) {
    super::super::timing("pin.ready");
    let layer = window.label().to_owned();
    let show_window = lock(&state(&app).layers)
        .by_label
        .get_mut(&layer)
        .is_some_and(|l| !std::mem::replace(&mut l.shown, true));
    if show_window {
        let _ = window.show();
    }
    let arranging = lock(&ARRANGING);
    let handed = {
        let mut pins = lock(&state(&app).pins);
        match pins.get_mut(&pin) {
            Some(r) => {
                r.shown = true;
                r.entering.retain(|l| *l != layer);
                if r.entering.is_empty() && !r.leaving.is_empty() {
                    let leaving = std::mem::take(&mut r.leaving);
                    r.layers.retain(|l| !leaving.contains(l));
                    remember_layers(&pin, &r.layers);
                    leaving
                } else {
                    Vec::new()
                }
            }
            None => Vec::new(),
        }
    };
    if !handed.is_empty() {
        finish(
            &app,
            &Touched {
                layers: Vec::new(),
                gone: handed.into_iter().map(|l| (l, pin.clone())).collect(),
            },
        );
    }
    drop(arranging);
    stop_waiting(&app, &pin);
}

/// 唤醒 [`wait_shown`]：钉图已显示，或已不在。
pub(super) fn stop_waiting(app: &AppHandle, pin: &str) {
    let waiters = &state(app).pin_shown;
    if let Some(shown) = lock(&waiters.pins).get_mut(pin) {
        *shown = true;
        waiters.changed.notify_all();
    }
}

/// 动画或手势结束、页面已画好：`generation` 仍是最新一帧时，钉图的区域缩回内容；离开了的层放手。
#[tauri::command]
pub async fn settle_pin(app: AppHandle, pin: String, generation: u32) {
    {
        let mut pins = lock(&state(&app).pins);
        let Some(r) = pins.get_mut(&pin) else {
            return;
        };
        if r.generation != generation || r.settled {
            return;
        }
        r.region = r.content;
        r.settled = true;
    }
    let _arranging = lock(&ARRANGING);
    match arrange(&app, &pin) {
        Ok(touched) => finish(&app, &touched),
        Err(e) => eprintln!("钉图层建不起来：{e}"),
    }
}

/// 拖动钉图：移到屏幕物理像素 (x, y)，这里成为它的新原位。收起着的钉图被拖出后不再算收起。
/// 锁定的钉图不动。
#[tauri::command]
pub async fn move_pin(app: AppHandle, pin: String, x: i32, y: i32) -> Result<(), String> {
    let rect = edit(&app, &pin, |p| p.move_to(x, y).then(|| p.rect()))
        .ok_or(CLOSED)?
        .ok_or(LOCKED)?;
    lock(&state(&app).edge).release(&pin);
    show(&app, &pin, rect, PinMotion::Drag, false)
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

/// 缩放钉图到 `scale`，屏幕上的 (`anchor_x`, `anchor_y`)（物理像素，例如光标或按住的角）
/// 保持不动。锁定的钉图不缩放。窗口里的内容以动画到达。
#[tauri::command]
pub async fn zoom_pin(
    app: AppHandle,
    pin: String,
    scale: f64,
    anchor_x: f64,
    anchor_y: f64,
) -> Result<(), String> {
    zoom(&app, &pin, scale, Some((anchor_x, anchor_y)))
}

/// `anchor` 为 `None` 时以钉图中心为锚点。
pub(super) fn zoom(
    app: &AppHandle,
    pin: &str,
    scale: f64,
    anchor: Option<(f64, f64)>,
) -> Result<(), String> {
    let rect = change_here(app, pin, |p| {
        let r = p.rect();
        let centre = (
            f64::from(r.x) + f64::from(r.width) / 2.0,
            f64::from(r.y) + f64::from(r.height) / 2.0,
        );
        p.zoom(scale, anchor.unwrap_or(centre))
    })?;
    show(app, pin, rect, PinMotion::Zoom, false)
}

/// 翻转或旋转钉图（中心不动）。快捷键与右键菜单共用。
#[tauri::command]
pub async fn turn_pin(app: AppHandle, pin: String, turn: Turn) -> Result<(), String> {
    turn_here(&app, &pin, turn)
}

pub(super) fn turn_here(app: &AppHandle, pin: &str, turn: Turn) -> Result<(), String> {
    let rect = change_here(app, pin, |p| {
        p.turn(turn);
        true
    })?;
    show(app, pin, rect, PinMotion::Jump, false)
}

/// 透明度（10%～100%）。Ctrl+滚轮与右键菜单共用。
#[tauri::command]
pub async fn set_pin_opacity(app: AppHandle, pin: String, opacity: f64) -> Result<(), String> {
    edit(&app, &pin, |p| p.set_opacity(opacity)).ok_or(CLOSED)?;
    refresh(&app, &pin);
    Ok(())
}

/// 锁定后钉图不响应拖动与缩放。
#[tauri::command]
pub async fn set_pin_locked(app: AppHandle, pin: String, locked: bool) -> Result<(), String> {
    edit(&app, &pin, |p| p.locked = locked).ok_or(CLOSED)?;
    refresh(&app, &pin);
    Ok(())
}
