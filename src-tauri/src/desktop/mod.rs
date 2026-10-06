//! Desktop：截图、截图历史、桌面钉图与托盘（内联插件 `desktop`，前端以 `plugin:desktop|<命令>` 调用）。
//! 规则在 `kinshoko_core::desktop`，这里只接系统：抓屏、剪贴板、窗口、托盘与全局快捷键。
//!
//! 线程规则（沿用 #7 钉图原型）：**持有 [`DesktopState`] 里任何一把锁时都不调用窗口 API**。
//! 窗口调用会派发到主线程，而主线程上的回调（快捷键、窗口事件、菜单）也会来拿这些锁。
//! 抓屏、读写剪贴板与收藏都在别的线程上做。
//!
//! - 截图历史与冻结屏幕走自定义协议 `capture`：`screen/<标记>` 或 `<截图 id>`；
//! - 截图历史变化时向所有窗口推送 `capture-history`（截图列表，从新到旧）。

mod capture;
mod pins;
#[cfg(windows)]
mod win32;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use kinshoko_core::ShortcutAction;
use kinshoko_core::desktop::{CaptureEntry, CaptureHistory, CollectedCapture};
use tauri::http::{Response, StatusCode, header};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::{library, shell};

/// 与资料库插件相同：设置时截图历史也放进这个目录，WebDriver 测试用它隔离数据。
const DATA_DIR_ENV: &str = "KINSHOKO_DATA_DIR";
const HISTORY_DIR: &str = "captures";
const HISTORY_EVENT: &str = "capture-history";

pub struct DesktopState {
    history: Mutex<CaptureHistory>,
    capture: Mutex<capture::Session>,
    pins: Mutex<HashMap<String, pins::PinRecord>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn state(app: &AppHandle) -> &DesktopState {
    app.state::<DesktopState>().inner()
}

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("desktop")
        .invoke_handler(tauri::generate_handler![
            capture::start_capture,
            capture::frozen_screen,
            capture::capture_ready,
            capture::finish_capture,
            capture::cancel_capture,
            pins::pin_clipboard,
            pins::pin_capture,
            pins::pin_info,
            pins::pin_ready,
            pins::pin_menu,
            pins::move_pin,
            capture_history,
            collect_capture,
            delete_capture,
        ])
        .setup(|app, _api| {
            let dir = match std::env::var_os(DATA_DIR_ENV) {
                Some(dir) => PathBuf::from(dir),
                None => app.path().app_data_dir()?,
            };
            let history = CaptureHistory::open(&dir.join(HISTORY_DIR))?;
            app.manage(DesktopState {
                history: Mutex::new(history),
                capture: Mutex::new(capture::Session::Idle),
                pins: Mutex::default(),
            });
            app.on_menu_event(pins::on_menu_event);
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("capture", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().trim_start_matches('/').to_owned();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(capture_response(&app, &path));
            });
        })
        .build()
}

/// 冻结屏幕现场编码；历史中的截图直接读文件。两者都是内嵌显示器配置文件的 PNG。
fn capture_response(app: &AppHandle, path: &str) -> Response<Vec<u8>> {
    let body = match path.strip_prefix("screen/") {
        Some(token) => capture::frozen_png(app, token),
        None => {
            let file = lock(&state(app).history).file(path);
            file.and_then(|f| std::fs::read(f).ok())
        }
    };
    match body {
        Some(bytes) => Response::builder()
            .header(header::CONTENT_TYPE, "image/png")
            .header(header::CACHE_CONTROL, "no-store")
            .body(bytes),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new()),
    }
    .expect("响应合法")
}

/// 截图历史变了：推送给所有窗口（主窗口的截图历史、钉图的收藏状态）。
fn history_changed(app: &AppHandle) {
    let entries = lock(&state(app).history).entries();
    let _ = app.emit(HISTORY_EVENT, entries);
}

/// 收藏：经资料库的普通导入入口，存进当前资料库。会等导入完成，不要在主线程上调用。
fn collect(app: &AppHandle, capture_id: &str) -> Result<(CollectedCapture, String), String> {
    let library = library::current_or_last(app)?;
    let collected = lock(&state(app).history)
        .collect(capture_id, &library)
        .map_err(|e| e.to_string())?;
    history_changed(app);
    Ok((collected, library.info().name.clone()))
}

#[tauri::command]
async fn capture_history(app: AppHandle) -> Vec<CaptureEntry> {
    lock(&state(&app).history).entries()
}

#[tauri::command]
async fn collect_capture(app: AppHandle, id: String) -> Result<CollectedCapture, String> {
    tauri::async_runtime::spawn_blocking(move || collect(&app, &id).map(|(c, _)| c))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_capture(app: AppHandle, id: String) -> Result<(), String> {
    lock(&state(&app).history)
        .delete(&id)
        .map_err(|e| e.to_string())?;
    history_changed(&app);
    Ok(())
}

/// 全局快捷键按下时在主线程上调用。不能阻塞，也不能加 [`shell::ShellState`] 的锁；
/// 耗时的工作（截图、读剪贴板）放到别的线程。
pub fn on_shortcut(app: &AppHandle, action: ShortcutAction) {
    match action {
        ShortcutAction::Capture => capture::start(app),
        ShortcutAction::PinClipboard => pins::pin_clipboard_in_background(app),
        // 贴边隐藏由 #63 接入。
        ShortcutAction::HideAllPins => {
            let _ = app.emit("shortcut-pressed", action);
        }
    }
}

const MENU_OPEN: &str = "open-main-window";
const MENU_CAPTURE: &str = "capture";
const MENU_PIN_CLIPBOARD: &str = "pin-clipboard";
const MENU_QUIT: &str = "quit";

/// 常驻托盘：单击图标或菜单“打开 Kinshoko”回到主窗口，“退出”结束常驻进程。
pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, MENU_OPEN, "打开 Kinshoko", true, None::<&str>)?,
            &MenuItem::with_id(app, MENU_CAPTURE, "截图", true, None::<&str>)?,
            &MenuItem::with_id(app, MENU_PIN_CLIPBOARD, "钉剪贴板", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Kinshoko")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => shell::open_main_window(app),
            MENU_CAPTURE => capture::start(app),
            MENU_PIN_CLIPBOARD => pins::pin_clipboard_in_background(app),
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                shell::open_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
