//! 桌面钉图窗口：截图钉图、钉剪贴板（F3）、拖动与缩放、翻转旋转、右键菜单（收藏、复制、关闭），
//! 以及重新打开后的恢复（#63）。
//!
//! 每个钉图一个无边框、置顶、不进任务栏的窗口，尺寸等于 [`SavedPin::window_size`]（物理像素）。
//! 窗口先隐藏建好、定好位置，页面画完第一帧后调用 `pin_ready` 才显示。
//! 钉图状态在 [`PinStore`]（`pins.json`）里：画师关闭的钉图从中删除；退出程序时窗口也会销毁，
//! 但这时不删，下次启动照原样恢复。
//!
//! 拖动和缩放都由页面的 pointer 事件驱动、由程序移动窗口（笔与鼠标同一套处理；Windows Ink 下
//! 没有系统拖动需要的鼠标事件，#7）。

use std::sync::atomic::Ordering;

use image::RgbaImage;
use kinshoko_core::desktop::{
    CaptureEntry, PinContent, Placement, SavedPin, ScreenRect, Screenshot, place_new_pin,
};
use serde::Deserialize;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

use super::{collect, history_changed, lock, state};

/// 新钉图相对原位置错开的距离，逻辑像素（按显示器缩放换算成物理像素）。
const OFFSET: f64 = 16.0;
const LABEL_PREFIX: &str = "pin-";
const NOTICE_EVENT: &str = "pin-notice";
const MENU_PREFIX: &str = "pin|";

/// 本次运行中打开着的钉图窗口。
pub struct PinRecord {
    capture_id: String,
    /// 画师正在关闭它（菜单或 Alt+F4）。窗口销毁时据此区分“关闭钉图”和“退出程序”。
    closing: bool,
}

pub fn label(pin: &str) -> String {
    format!("{LABEL_PREFIX}{pin}")
}

/// 显示器的矩形与缩放比例。
pub fn monitor_at(x: i32, y: i32) -> Option<(ScreenRect, f64)> {
    let m = xcap::Monitor::from_point(x, y).ok()?;
    Some((
        ScreenRect {
            x: m.x().ok()?,
            y: m.y().ok()?,
            width: m.width().ok()?,
            height: m.height().ok()?,
        },
        f64::from(m.scale_factor().ok()?),
    ))
}

/// 全部显示器的矩形。
pub fn monitors() -> Vec<ScreenRect> {
    xcap::Monitor::all()
        .unwrap_or_default()
        .iter()
        .filter_map(|m| {
            Some(ScreenRect {
                x: m.x().ok()?,
                y: m.y().ok()?,
                width: m.width().ok()?,
                height: m.height().ok()?,
            })
        })
        .collect()
}

/// 已打开钉图的状态（按 [`PinStore`] 的先后）。
pub fn open_pins(app: &AppHandle) -> Vec<SavedPin> {
    let open: Vec<String> = lock(&state(app).pins).keys().cloned().collect();
    lock(&state(app).store)
        .pins()
        .iter()
        .filter(|p| open.contains(&p.id))
        .cloned()
        .collect()
}

/// 改一个钉图的状态并安排保存。钉图不在时为 `None`。
fn edit<T>(app: &AppHandle, pin: &str, f: impl FnOnce(&mut SavedPin) -> T) -> Option<T> {
    let out = lock(&state(app).store).edit(pin, f);
    if out.is_some() {
        state(app).dirty.store(true, Ordering::Relaxed);
    }
    out
}

/// 把截图历史中的一张截图钉到桌面。`at` 是图片原本在屏幕上的位置（物理像素）；
/// 新钉图略微偏离它，并避开已有钉图（[`place_new_pin`]）。
pub fn open(app: &AppHandle, capture: &CaptureEntry, at: ScreenRect) -> Result<(), String> {
    let center = (at.x + (at.width / 2) as i32, at.y + (at.height / 2) as i32);
    let (monitor, scale) = monitor_at(center.0, center.1)
        .or_else(|| monitor_at(at.x, at.y))
        .unwrap_or((at, 1.0));
    let step = (OFFSET * scale).round() as i32;
    let others: Vec<ScreenRect> = open_pins(app).iter().map(SavedPin::rect).collect();
    let (x, y) = place_new_pin(at, monitor, &others, step);

    let pin = SavedPin {
        id: uuid::Uuid::new_v4().simple().to_string(),
        content: PinContent::Capture {
            capture_id: capture.id.clone(),
        },
        crop: None,
        width: capture.width,
        height: capture.height,
        placement: Placement {
            x,
            y,
            ..Placement::default()
        },
    };
    lock(&state(app).history).pin(&capture.id);
    {
        let mut store = lock(&state(app).store);
        store.put(pin.clone());
        let _ = store.save();
    }
    history_changed(app);
    open_window(app, &pin)
}

/// 为一个钉图建窗口（新钉的，或启动时恢复的）。截图历史此前已经记下它被钉住。
pub fn open_window(app: &AppHandle, pin: &SavedPin) -> Result<(), String> {
    let PinContent::Capture { capture_id } = &pin.content;
    lock(&state(app).pins).insert(
        pin.id.clone(),
        PinRecord {
            capture_id: capture_id.clone(),
            closing: false,
        },
    );
    let built = WebviewWindowBuilder::new(
        app,
        label(&pin.id),
        WebviewUrl::App(format!("index.html?view=pin&pin={}", pin.id).into()),
    )
    .title("Kinshoko 钉图")
    .decorations(false)
    .transparent(true)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .shadow(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible(false)
    .build();
    let window = match built {
        Ok(w) => w,
        Err(e) => {
            if let Some(record) = lock(&state(app).pins).get_mut(&pin.id) {
                record.closing = true;
            }
            closed(app, &pin.id);
            return Err(format!("无法打开钉图窗口：{e}"));
        }
    };
    let app_for_events = app.clone();
    let pin_id = pin.id.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { .. } => mark_closing(&app_for_events, &pin_id),
        WindowEvent::Resized(size) => keep_exact_size(&app_for_events, &pin_id, *size),
        WindowEvent::Destroyed => {
            // 主线程上：截图历史的清理放到别的线程。
            let (app, pin) = (app_for_events.clone(), pin_id.clone());
            std::thread::spawn(move || closed(&app, &pin));
        }
        _ => {}
    });
    let (w, h) = pin.window_size();
    // 先移到目标显示器再定尺寸：跨越缩放比例不同的显示器时，移动会先按新比例改一次尺寸。
    window
        .set_position(PhysicalPosition::new(pin.placement.x, pin.placement.y))
        .and_then(|_| window.set_size(PhysicalSize::new(w, h)))
        .map_err(|e| e.to_string())
}

fn mark_closing(app: &AppHandle, pin: &str) {
    if let Some(record) = lock(&state(app).pins).get_mut(pin) {
        record.closing = true;
    }
}

/// 拖到缩放比例不同的显示器上时系统会按新比例改窗口尺寸：改回钉图的物理像素尺寸，
/// 免得 canvas 被重新采样。
fn keep_exact_size(app: &AppHandle, pin: &str, size: PhysicalSize<u32>) {
    let Some((w, h)) = lock(&state(app).store).get(pin).map(SavedPin::window_size) else {
        return;
    };
    if (size.width, size.height) != (w, h)
        && let Some(window) = app.get_webview_window(&label(pin))
    {
        let _ = window.set_size(PhysicalSize::new(w, h));
    }
}

/// 钉图窗口销毁了。画师关闭的：不再恢复，截图不再被它钉住，按截图历史的规则丢弃。
/// 退出程序时销毁的：状态留着，下次启动恢复。
fn closed(app: &AppHandle, pin: &str) {
    let Some(record) = lock(&state(app).pins).remove(pin) else {
        return;
    };
    lock(&state(app).edge).release(pin);
    if !record.closing {
        return;
    }
    {
        let mut store = lock(&state(app).store);
        store.remove(pin);
        let _ = store.save();
    }
    lock(&state(app).history).unpin(&record.capture_id);
    history_changed(app);
}

/// 启动时恢复上次的钉图（位置、裁切、缩放、翻转与旋转）。在别的线程上调用。
pub fn restore(app: &AppHandle) {
    let monitors = monitors();
    let pins = {
        let mut history = lock(&state(app).history);
        let mut store = lock(&state(app).store);
        let pins = store.restore(&mut history, &monitors);
        let _ = store.save();
        pins
    };
    if pins.is_empty() {
        return;
    }
    history_changed(app);
    for pin in &pins {
        if let Err(e) = open_window(app, pin) {
            eprintln!("恢复钉图失败：{e}");
        }
    }
}

/// 光标处的一个点，作为钉剪贴板和从历史钉住时的“原位置”。
fn at_cursor(app: &AppHandle, width: u32, height: u32) -> Result<ScreenRect, String> {
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    Ok(ScreenRect {
        x: cursor.x.floor() as i32,
        y: cursor.y.floor() as i32,
        width,
        height,
    })
}

/// 把剪贴板里的图片存进截图历史并钉在光标旁。
fn pin_from_clipboard(app: &AppHandle) -> Result<(), String> {
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
    let entry = lock(&state(app).history)
        .add(&Screenshot { image, icc: None })
        .map_err(|e| e.to_string())?;
    history_changed(app);
    open(app, &entry, at_cursor(app, entry.width, entry.height)?)
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

pub fn copy_to_clipboard(image: &RgbaImage) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| {
            c.set_image(arboard::ImageData {
                width: image.width() as usize,
                height: image.height() as usize,
                bytes: image.as_raw().into(),
            })
        })
        .map_err(|e| format!("无法写入剪贴板：{e}"))
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
    open(&app, &entry, at)
}

/// 钉图窗口要画的内容与摆放。
#[tauri::command]
pub async fn pin_info(app: AppHandle, pin: String) -> Option<SavedPin> {
    lock(&state(&app).store).get(&pin).cloned()
}

/// 第一帧已画好：显示钉图。
#[tauri::command]
pub async fn pin_ready(app: AppHandle, pin: String) {
    if let Some(window) = app.get_webview_window(&label(&pin)) {
        let _ = window.show();
    }
}

/// 拖动钉图：移到屏幕物理像素 (x, y)，这里成为它的新原位。收起着的钉图被拖出后不再算收起。
#[tauri::command]
pub async fn move_pin(app: AppHandle, pin: String, x: i32, y: i32) {
    let moved = edit(&app, &pin, |p| {
        p.placement.x = x;
        p.placement.y = y;
    });
    if moved.is_none() {
        return;
    }
    lock(&state(&app).edge).release(&pin);
    if let Some(window) = app.get_webview_window(&label(&pin)) {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

/// 缩放钉图到 `scale`。窗口内的 (`anchor_x`, `anchor_y`)（物理像素，例如光标或按住的角）
/// 保持不动。返回缩放后的状态，页面据此按物理像素重画。
#[tauri::command]
pub async fn zoom_pin(
    app: AppHandle,
    pin: String,
    scale: f64,
    anchor_x: f64,
    anchor_y: f64,
) -> Result<SavedPin, String> {
    let window = app.get_webview_window(&label(&pin)).ok_or("钉图已关闭")?;
    // 以窗口当前的位置为准：滑出中的钉图在这里缩放后就留在这里。
    let at = window.outer_position().map_err(|e| e.to_string())?;
    let saved = edit(&app, &pin, |p| {
        p.placement.x = at.x;
        p.placement.y = at.y;
        p.zoom(
            scale,
            (f64::from(at.x) + anchor_x, f64::from(at.y) + anchor_y),
        );
        p.clone()
    })
    .ok_or("钉图已关闭")?;
    lock(&state(&app).edge).release(&pin);
    apply(&window, &saved)?;
    Ok(saved)
}

/// 翻转与旋转。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Turn {
    FlipHorizontal,
    FlipVertical,
    RotateClockwise,
    RotateCounterClockwise,
}

/// 翻转或旋转钉图（中心不动）。返回新的状态，页面据此重画。右键菜单由 #64 接入同一命令。
#[tauri::command]
pub async fn turn_pin(app: AppHandle, pin: String, turn: Turn) -> Result<SavedPin, String> {
    let window = app.get_webview_window(&label(&pin)).ok_or("钉图已关闭")?;
    let at = window.outer_position().map_err(|e| e.to_string())?;
    let saved = edit(&app, &pin, |p| {
        p.placement.x = at.x;
        p.placement.y = at.y;
        match turn {
            Turn::FlipHorizontal => p.flip(true),
            Turn::FlipVertical => p.flip(false),
            Turn::RotateClockwise => p.rotate(1),
            Turn::RotateCounterClockwise => p.rotate(-1),
        }
        p.clone()
    })
    .ok_or("钉图已关闭")?;
    lock(&state(&app).edge).release(&pin);
    apply(&window, &saved)?;
    Ok(saved)
}

/// 把窗口摆到钉图状态的原位与尺寸。
fn apply(window: &tauri::WebviewWindow, pin: &SavedPin) -> Result<(), String> {
    let (w, h) = pin.window_size();
    window
        .set_position(PhysicalPosition::new(pin.placement.x, pin.placement.y))
        .and_then(|_| window.set_size(PhysicalSize::new(w, h)))
        .map_err(|e| e.to_string())
}

const ACTION_COLLECT: &str = "collect";
const ACTION_COPY: &str = "copy";
const ACTION_CLOSE: &str = "close";

/// 钉图的右键菜单。#64 再加入翻转、旋转、透明度、锁定等。
#[tauri::command]
pub async fn pin_menu(app: AppHandle, pin: String) -> Result<(), String> {
    let window = app.get_webview_window(&label(&pin)).ok_or("钉图已关闭")?;
    let capture_id = lock(&state(&app).pins)
        .get(&pin)
        .map(|r| r.capture_id.clone())
        .ok_or("钉图已关闭")?;
    let collected = lock(&state(&app).history)
        .entries()
        .into_iter()
        .find(|e| e.id == capture_id)
        .map(|e| e.collected);
    // 历史里已删除的截图仍能收藏：文件还在，直到钉图关闭。
    let library = crate::library::current_name(&app);
    let (collect_text, collect_enabled) = match &library {
        None => ("收藏（还没有资料库）".to_owned(), false),
        Some((id, name)) => match collected {
            Some(c) if c.iter().any(|c| &c.library_id == id) => {
                (format!("已收藏到「{name}」"), false)
            }
            _ => (format!("收藏到「{name}」"), true),
        },
    };
    let item = |action: &str, text: &str, enabled: bool| {
        MenuItem::with_id(
            &app,
            format!("{MENU_PREFIX}{pin}|{action}"),
            text,
            enabled,
            None::<&str>,
        )
    };
    let menu = Menu::with_items(
        &app,
        &[
            &item(ACTION_COLLECT, &collect_text, collect_enabled).map_err(|e| e.to_string())?,
            &item(ACTION_COPY, "复制", true).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?,
            &item(ACTION_CLOSE, "关闭钉图", true).map_err(|e| e.to_string())?,
        ],
    )
    .map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

/// 菜单事件在主线程上到达：关闭直接做，收藏和复制放到别的线程。
pub fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let Some(rest) = event.id().as_ref().strip_prefix(MENU_PREFIX) else {
        return;
    };
    let Some((pin, action)) = rest.split_once('|') else {
        return;
    };
    let (app, pin, action) = (app.clone(), pin.to_owned(), action.to_owned());
    if action == ACTION_CLOSE {
        mark_closing(&app, &pin);
        if let Some(window) = app.get_webview_window(&label(&pin)) {
            let _ = window.destroy();
        }
        return;
    }
    std::thread::spawn(move || {
        let Some(capture_id) = lock(&state(&app).pins)
            .get(&pin)
            .map(|r| r.capture_id.clone())
        else {
            return;
        };
        let notice = match action.as_str() {
            ACTION_COLLECT => match collect(&app, &capture_id) {
                Ok((_, library)) => format!("已收藏到「{library}」"),
                Err(e) => e,
            },
            ACTION_COPY => match copy_capture(&app, &capture_id) {
                Ok(()) => "已复制".to_owned(),
                Err(e) => e,
            },
            _ => return,
        };
        let _ = app.emit_to(label(&pin), NOTICE_EVENT, notice);
    });
}

fn copy_capture(app: &AppHandle, capture_id: &str) -> Result<(), String> {
    let file = lock(&state(app).history)
        .file(capture_id)
        .ok_or("截图已不在截图历史中")?;
    let image = image::open(file).map_err(|e| e.to_string())?.to_rgba8();
    copy_to_clipboard(&image)
}
