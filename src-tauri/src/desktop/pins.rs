//! 桌面钉图窗口：截图钉图、钉剪贴板（F3）、右键菜单（收藏、复制、关闭）。
//!
//! 每个钉图一个无边框、置顶、不进任务栏的窗口，尺寸等于图片的物理像素（未缩放）。
//! 窗口先隐藏建好、定好位置，页面画完第一帧后调用 `pin_ready` 才显示。
//! 缩放、翻转旋转、透明度与右键菜单的其余操作由 #64 接入，贴边隐藏与重开恢复由 #63 接入。

use image::RgbaImage;
use kinshoko_core::desktop::{CaptureEntry, PinInfo, ScreenRect, Screenshot, place_new_pin};
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

#[derive(Clone)]
pub struct PinRecord {
    capture_id: String,
    width: u32,
    height: u32,
}

fn label(pin: &str) -> String {
    format!("{LABEL_PREFIX}{pin}")
}

/// 显示器的矩形与缩放比例；找不到时按 `at` 自身和 1.0。
fn monitor_at(x: i32, y: i32) -> Option<(ScreenRect, f64)> {
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

/// 已有钉图窗口在屏幕上的位置。
fn pin_rects(app: &AppHandle) -> Vec<ScreenRect> {
    let ids: Vec<String> = lock(&state(app).pins).keys().cloned().collect();
    ids.iter()
        .filter_map(|id| app.get_webview_window(&label(id)))
        .filter_map(|w| {
            let (p, s) = (w.outer_position().ok()?, w.outer_size().ok()?);
            Some(ScreenRect {
                x: p.x,
                y: p.y,
                width: s.width,
                height: s.height,
            })
        })
        .collect()
}

/// 把截图历史中的一张截图钉到桌面。`at` 是图片原本在屏幕上的位置（物理像素）；
/// 新钉图略微偏离它，并避开已有钉图（[`place_new_pin`]）。
pub fn open(app: &AppHandle, capture: &CaptureEntry, at: ScreenRect) -> Result<(), String> {
    let center = (at.x + (at.width / 2) as i32, at.y + (at.height / 2) as i32);
    let (monitor, scale) = monitor_at(center.0, center.1)
        .or_else(|| monitor_at(at.x, at.y))
        .unwrap_or((at, 1.0));
    let step = (OFFSET * scale).round() as i32;
    let (x, y) = place_new_pin(at, monitor, &pin_rects(app), step);

    let id = uuid::Uuid::new_v4().simple().to_string();
    lock(&state(app).history).pin(&capture.id);
    lock(&state(app).pins).insert(
        id.clone(),
        PinRecord {
            capture_id: capture.id.clone(),
            width: capture.width,
            height: capture.height,
        },
    );
    history_changed(app);

    let built = WebviewWindowBuilder::new(
        app,
        label(&id),
        WebviewUrl::App(format!("index.html?view=pin&pin={id}").into()),
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
            closed(app, &id);
            return Err(format!("无法打开钉图窗口：{e}"));
        }
    };
    let app_for_events = app.clone();
    let pin_id = id.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            // 主线程上：截图历史的清理放到别的线程。
            let (app, pin) = (app_for_events.clone(), pin_id.clone());
            std::thread::spawn(move || closed(&app, &pin));
        }
    });
    window
        .set_position(PhysicalPosition::new(x, y))
        .and_then(|_| window.set_size(PhysicalSize::new(capture.width, capture.height)))
        .map_err(|e| e.to_string())
}

/// 钉图窗口关了：截图不再被它钉住，按截图历史的规则丢弃。
fn closed(app: &AppHandle, pin: &str) {
    let Some(record) = lock(&state(app).pins).remove(pin) else {
        return;
    };
    lock(&state(app).history).unpin(&record.capture_id);
    history_changed(app);
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

#[tauri::command]
pub async fn pin_info(app: AppHandle, pin: String) -> Option<PinInfo> {
    lock(&state(&app).pins).get(&pin).map(|r| PinInfo {
        capture_id: r.capture_id.clone(),
        width: r.width,
        height: r.height,
    })
}

/// 第一帧已画好：显示钉图。
#[tauri::command]
pub async fn pin_ready(app: AppHandle, pin: String) {
    if let Some(window) = app.get_webview_window(&label(&pin)) {
        let _ = window.show();
    }
}

/// 数位笔与触摸拖动：由程序移动窗口（Windows Ink 下没有系统拖动需要的鼠标事件，#7）。
#[tauri::command]
pub async fn move_pin(app: AppHandle, pin: String, x: i32, y: i32) {
    if let Some(window) = app.get_webview_window(&label(&pin)) {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
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
