//! Desktop：截图、截图历史、桌面钉图、贴边隐藏与托盘（内联插件 `desktop`，前端以 `plugin:desktop|<命令>` 调用）。
//! 规则在 `kinshoko_core::desktop`，这里只接系统：抓屏、剪贴板、窗口、托盘与全局快捷键。
//!
//! 线程规则（沿用 #7 钉图原型）：**持有 [`DesktopState`] 里任何一把锁时都不调用窗口 API**。
//! 窗口调用会派发到主线程，而主线程上的回调（快捷键、窗口事件、菜单）也会来拿这些锁。
//! 抓屏、读写剪贴板与收藏都在别的线程上做。
//!
//! - 截图历史、冻结屏幕与资料库钉图的图走自定义协议 `capture`：`screen/<标记>`、`<截图 id>`，
//!   或 `pin/<钉图 id>/full|fit-<像素>`（#65，经参考视角，只给已钉住的图）；
//! - 资料库事件（安全模式开关、分级变化）到达时，资料库钉图重新核对要不要遮蔽；
//! - 截图历史变化时向所有窗口推送 `capture-history`（截图列表，从新到旧）；
//! - 参考组（#66）：桌面上的资料库钉图存成参考组、打开参考组把成员钉到桌面（[`groups`]）。

mod capture;
mod edge;
mod groups;
mod pins;
#[cfg(windows)]
pub(crate) mod win32;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, MutexGuard};

use kinshoko_core::ShortcutAction;
use kinshoko_core::desktop::{
    CaptureEntry, CaptureHistory, CollectedCapture, EdgeHide, PinStore, PinVeils,
};
use kinshoko_core::diagnostics::UsageEvent;
use kinshoko_core::reference_groups::ReferenceGroups;
use tauri::http::{Response, StatusCode, header};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Listener, Manager, Wry};

use crate::{library, shell};

/// 与资料库插件相同：设置时截图历史也放进这个目录，WebDriver 测试用它隔离数据。
const DATA_DIR_ENV: &str = "KINSHOKO_DATA_DIR";
const HISTORY_DIR: &str = "captures";
/// 参考组独立于资料库，放在应用数据目录（ADR-0002）。
const GROUPS_DIR: &str = "reference-groups";
const HISTORY_EVENT: &str = "capture-history";
/// 资料库插件转发给窗口的事件。
const LIBRARY_EVENT: &str = "library-event";

pub struct DesktopState {
    history: Mutex<CaptureHistory>,
    pending_collection: Mutex<Option<String>>,
    capture: Mutex<capture::Session>,
    viewer_reference: Mutex<Option<capture::ViewerReport>>,
    /// 本次运行中打开着的钉图窗口。
    pins: Mutex<HashMap<String, pins::PinRecord>>,
    /// 钉图状态（`pins.json`），重新打开后恢复。
    store: Mutex<PinStore>,
    /// 钉图状态改了还没写回文件。
    dirty: AtomicBool,
    edge: Mutex<EdgeHide>,
    /// 安全模式开关与逐张确认显示的资料库钉图（#65）。
    veils: Mutex<PinVeils>,
    /// 本设备的参考组（#66）。改动在锁里串行完成。
    groups: Mutex<ReferenceGroups>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn state(app: &AppHandle) -> &DesktopState {
    app.state::<DesktopState>().inner()
}

/// 原生主窗口销毁或重建时也必须清除来源；WebView 销毁不运行 React 的 unmount。
pub fn clear_viewer_reference<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<DesktopState>() {
        *lock(&state.viewer_reference) = None;
    }
}

/// 在参考组的锁里做事（永久删除用，#67）：预览与执行之间、执行期间参考组不会被改。
/// 桌面插件还没装好时为 `None`。会读文件，不要在主线程上调用。
pub fn with_groups<R: tauri::Runtime, T>(
    app: &tauri::AppHandle<R>,
    f: impl FnOnce(&ReferenceGroups) -> T,
) -> Option<T> {
    let state = app.try_state::<DesktopState>()?;
    let groups = lock(&state.groups);
    Some(f(&groups))
}

/// 通知各窗口参考组成员的状态可能变了（例如成员的图被永久删除），重新读取。
pub fn reference_groups_changed<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let _ = app.emit(groups::CHANGED_EVENT, ());
}

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("desktop")
        .invoke_handler(tauri::generate_handler![
            capture::start_capture,
            capture::set_capture_reference,
            capture::frozen_screen,
            capture::capture_ready,
            capture::finish_capture,
            capture::cancel_capture,
            pins::pin_clipboard,
            pins::pin_capture,
            pins::pin_frame,
            pins::pin_ready,
            pins::pin_menu,
            pins::close_pin,
            pins::move_pin,
            pins::zoom_pin,
            pins::turn_pin,
            pins::settle_pin,
            pins::set_pin_opacity,
            pins::set_pin_locked,
            pins::pin_reference,
            pins::reveal_pin,
            groups::reference_groups,
            groups::reference_group,
            groups::group_save_captures,
            groups::save_reference_group,
            groups::save_pins_to_group,
            groups::open_reference_group,
            groups::rename_reference_group,
            groups::delete_reference_group,
            groups::remove_group_member,
            groups::export_reference_group_package,
            groups::import_reference_group_package,
            edge_hide,
            capture_history,
            collect_capture,
            take_collection_request,
            delete_capture,
        ])
        .setup(|app, _api| {
            let dir = match std::env::var_os(DATA_DIR_ENV) {
                Some(dir) => PathBuf::from(dir),
                None => app.path().app_data_dir()?,
            };
            let history = CaptureHistory::open(&dir.join(HISTORY_DIR))?;
            let store = PinStore::open(&dir)?;
            let groups = ReferenceGroups::open(&dir.join(GROUPS_DIR))?;
            app.manage(DesktopState {
                history: Mutex::new(history),
                pending_collection: Mutex::new(None),
                capture: Mutex::new(capture::Session::Idle),
                viewer_reference: Mutex::default(),
                pins: Mutex::default(),
                store: Mutex::new(store),
                dirty: AtomicBool::new(false),
                edge: Mutex::default(),
                // 先按开启处理（主线程上不读应用壳设置）；恢复钉图的线程再按保存的设置核对。
                veils: Mutex::new(PinVeils::new(true)),
                groups: Mutex::new(groups),
            });
            app.on_menu_event(pins::on_menu_event);
            let handle = app.clone();
            app.listen_any(LIBRARY_EVENT, move |event| {
                on_library_event(&handle, event.payload());
            });
            // 安全模式是应用设置：开关时不论有没有打开资料库都到这里。
            let handle = app.clone();
            app.listen_any(library::SAFE_MODE_EVENT, move |event| {
                if let Ok(on) = serde_json::from_str::<bool>(event.payload()) {
                    let app = handle.clone();
                    std::thread::spawn(move || pins::safe_mode_changed(&app, on));
                }
            });
            let settings_handle = app.clone();
            app.listen_any("application-settings-restored", move |_| {
                let app = settings_handle.clone();
                std::thread::spawn(move || pins::references_changed(&app));
            });
            edge::start(app);
            // 恢复上次的钉图：建窗口要等事件循环跑起来，放到别的线程。
            let handle = app.clone();
            std::thread::spawn(move || pins::restore(&handle));
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

/// 资料库转发给窗口的事件里，影响钉图遮蔽的几种：安全模式开关、分级变化（列表过期）。
fn on_library_event(app: &AppHandle, payload: &str) {
    let Ok(event) = serde_json::from_str::<serde_json::Value>(payload) else {
        return;
    };
    let safe_mode = match event.get("kind").and_then(|k| k.as_str()) {
        Some("safeModeChanged") => event.get("on").and_then(|on| on.as_bool()),
        Some("listStale" | "imagesChanged") => None,
        _ => return,
    };
    let app = app.clone();
    std::thread::spawn(move || match safe_mode {
        Some(on) => pins::safe_mode_changed(&app, on),
        None => pins::references_changed(&app),
    });
}

/// 冻结屏幕现场编码；历史中的截图直接读文件，两者都是内嵌显示器配置文件的 PNG。
/// 资料库钉图的图是 [`Library::display`](kinshoko_core::Library::display) 给出的文件。
fn capture_response(app: &AppHandle, path: &str) -> Response<Vec<u8>> {
    let mut content_type = "image/png";
    let body = if let Some(token) = path.strip_prefix("screen/") {
        capture::frozen_png(app, token)
    } else if let Some((pin, size)) = path.strip_prefix("pin/").and_then(|p| p.split_once('/')) {
        pins::reference_file(app, pin, size).and_then(|f| {
            content_type = library::image_content_type(&f);
            std::fs::read(f).ok()
        })
    } else {
        let file = lock(&state(app).history).file(path);
        file.and_then(|f| std::fs::read(f).ok())
    };
    match body {
        Some(bytes) => Response::builder()
            .header(header::CONTENT_TYPE, content_type)
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

/// Native pin menus request a visible destination in the main window before saving.
fn request_collection(app: &AppHandle, id: &str) {
    *lock(&state(app).pending_collection) = Some(id.into());
    shell::open_main_window(app);
    let _ = app.emit("capture-collection-request", ());
}

#[tauri::command]
async fn take_collection_request(app: AppHandle) -> Option<String> {
    lock(&state(&app).pending_collection).take()
}

#[tauri::command]
async fn capture_history(app: AppHandle) -> Vec<CaptureEntry> {
    lock(&state(&app).history).entries()
}

#[tauri::command]
async fn collect_capture(
    app: AppHandle,
    id: String,
    destination: kinshoko_core::library::SaveDestination,
) -> Result<CollectedCapture, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let collected = library::with_destination_published(&app, &destination, |library| {
            lock(&state(&app).history)
                .collect(&id, library)
                .map_err(|e| e.to_string())
        })?;
        history_changed(&app);
        Ok(collected)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 贴边隐藏全部钉图，或让它们回到原位（与全局快捷键相同）。
#[tauri::command]
async fn edge_hide(app: AppHandle) {
    edge::toggle_in_background(&app);
}

/// 退出前把钉图状态写回文件。
pub fn on_exit(app: &AppHandle) {
    edge::flush(app);
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
    crate::diagnostics::record(
        app,
        match action {
            ShortcutAction::Capture => UsageEvent::CaptureStarted,
            ShortcutAction::PinClipboard => UsageEvent::PinnedClipboard,
            ShortcutAction::HideAllPins => UsageEvent::PinsHidden,
        },
    );
    match action {
        ShortcutAction::Capture => capture::start(app),
        ShortcutAction::PinClipboard => pins::pin_clipboard_in_background(app),
        ShortcutAction::HideAllPins => edge::toggle_in_background(app),
    }
}

const MENU_OPEN: &str = "open-main-window";
const MENU_CAPTURE: &str = "capture";
const MENU_PIN_CLIPBOARD: &str = "pin-clipboard";
const MENU_EDGE_HIDE: &str = "edge-hide";
const MENU_QUIT: &str = "quit";

/// 常驻托盘：单击图标或菜单“打开 Kinshoko”回到主窗口，“退出”结束常驻进程。
pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, MENU_OPEN, "打开 Kinshoko", true, None::<&str>)?,
            &MenuItem::with_id(app, MENU_CAPTURE, "截图", true, None::<&str>)?,
            &MenuItem::with_id(app, MENU_PIN_CLIPBOARD, "钉剪贴板", true, None::<&str>)?,
            &MenuItem::with_id(
                app,
                MENU_EDGE_HIDE,
                "贴边隐藏／显示钉图",
                true,
                None::<&str>,
            )?,
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
            MENU_EDGE_HIDE => edge::toggle_in_background(app),
            // 今天还没备份时先备份再退出（#69）。
            MENU_QUIT => crate::backup::quit(app),
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

/// Revoke previous configuration views immediately, including same-mode explicit pin reveals.
pub fn settings_restored<R: tauri::Runtime>(app: &AppHandle<R>, safe: bool) {
    let state = app.state::<DesktopState>();
    *lock(&state.veils) = PinVeils::new(safe);
    clear_viewer_reference(app);
    *lock(&state.capture) = capture::Session::Idle;
    if let Some(window) = app.get_webview_window(capture::CAPTURE_WINDOW) {
        let _ = window.destroy();
    }
    let _ = app.emit("application-settings-restored", ());
}
