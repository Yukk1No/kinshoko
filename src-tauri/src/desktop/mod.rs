//! Desktop：截图、截图历史、桌面钉图、贴边隐藏与托盘（内联插件 `desktop`，前端以 `plugin:desktop|<命令>` 调用）。
//! 规则在 `kinshoko_core::desktop`，这里只接系统：抓屏、剪贴板、窗口、托盘与全局快捷键。
//!
//! 线程规则（沿用 #7 钉图原型）：**持有 [`DesktopState`] 里任何一把锁时都不调用窗口 API**。
//! 窗口调用会派发到主线程，而主线程上的回调（快捷键、窗口事件、菜单）也会来拿这些锁。
//! 抓屏、读写剪贴板与收藏都在别的线程上做。
//!
//! - 截图历史、冻结屏幕与参考组自带的截图走自定义协议 `capture`：`screen/<标记>`、`<截图 id>`、
//!   `group/<参考组 id>/<成员>`；
//! - 资料库事件（安全模式开关、分级变化）到达时，资料库钉图重新核对要不要遮蔽；
//! - 截图历史变化时向所有窗口推送 `capture-history`（截图列表，从新到旧）；
//! - 参考组（#66）：桌面上的资料库钉图存成参考组、打开参考组把成员钉到桌面（[`groups`]）；
//! - 钉图的右键菜单（#106）：与主窗口同样式，由独立的置顶无边框菜单窗口承载（[`menu`]）；
//! - 复制图片、在资源管理器中显示、从剪贴板导入（#105，[`image_actions`]）。

use kinshoko_core::CommandError;

mod capture;
mod clipboard;
mod edge;
mod groups;
mod image_actions;
mod menu;
mod pins;
mod tray;
pub use tray::*;
#[cfg(windows)]
pub(crate) mod win32;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use kinshoko_core::ShortcutAction;
use kinshoko_core::desktop::{
    CaptureEntry, CaptureHistory, CollectedCapture, EdgeHide, OpenInKinshoko, PinMenuOpen,
    PinStore, PinVeils,
};
use kinshoko_core::reference_groups::ReferenceGroups;
use tauri::http::{Response, StatusCode, header};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Listener, Manager, Wry};

use crate::{library, shell};

/// 框选计时（#127、#129）：设置了 [`TIMING_ENV`] 时，把 `capture.timing <阶段> at=<epoch 毫秒>` 追加到那个文件，
/// 供 `scripts/perf/capture-timing.mjs` 算出按键到框选可用、确认到结果可用的各段耗时；未设置时什么也不做。
pub(crate) fn timing(stage: &str) {
    static LOG: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    let Some(path) = LOG.get_or_init(|| std::env::var_os(TIMING_ENV).map(PathBuf::from)) else {
        return;
    };
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as f64
        / 1000.0;
    use std::io::Write as _;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "capture.timing {stage} at={at:.1}");
    }
}
const TIMING_ENV: &str = "KINSHOKO_CAPTURE_TIMING_LOG";

const HISTORY_DIR: &str = "captures";
/// 参考组独立于资料库，放在应用数据目录（ADR-0002）。
const GROUPS_DIR: &str = "reference-groups";
const HISTORY_EVENT: &str = "capture-history";
/// 资料库插件转发给窗口的事件。
const LIBRARY_EVENT: &str = "library-event";

pub struct DesktopState {
    history: Mutex<CaptureHistory>,
    pending_collection: Mutex<Option<String>>,
    /// 钉图菜单“在 Kinshoko 中打开”留给主窗口的请求（#106）。
    pending_open: Mutex<Option<OpenInKinshoko>>,
    /// 钉图的菜单窗口（#106）。
    menu: Mutex<menu::MenuState>,
    capture: Mutex<capture::Session>,
    capture_frames: capture::FrameChannel,
    /// 框选结束前等新钉图显示（#127）。
    pin_shown: pins::ShownWaiters,
    capture_geometry_generation: AtomicU64,
    /// 本次运行中打开着的钉图。
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
        state.capture_frames.invalidate();
        state
            .capture_geometry_generation
            .fetch_add(1, Ordering::SeqCst);
    }
}

/// Native geometry changes are causal even when a window returns to exactly the same rectangle.
pub fn capture_geometry_changed<R: tauri::Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    if label == "main"
        && let Some(state) = app.try_state::<DesktopState>()
    {
        state
            .capture_geometry_generation
            .fetch_add(1, Ordering::SeqCst);
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
            capture::report_capture_references,
            capture::frozen_screen,
            capture::capture_readout,
            capture::capture_ready,
            capture::finish_capture,
            capture::cancel_capture,
            pins::pin_clipboard,
            pins::pin_capture,
            pins::pin_menu_action,
            desktop_menu,
            desktop_menu_shown,
            close_desktop_menu,
            take_open_request,
            copy_capture,
            pins::pin_reference,
            image_actions::copy_reference_image,
            image_actions::reveal_reference_image,
            image_actions::reveal_library,
            image_actions::reveal_import_source,
            image_actions::clipboard_has_image,
            image_actions::stage_clipboard_import,
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
            let dir = crate::data_dirs::app_data(app).device().to_path_buf();
            let history = CaptureHistory::open(&dir.join(HISTORY_DIR))?;
            let store = PinStore::open(&dir)?;
            let groups = ReferenceGroups::open(&dir.join(GROUPS_DIR))?;
            // 启动时清掉一天前暂存的剪贴板图片（取消了导入、之后没再粘贴的也不会一直留着）。
            let staged = dir.join(image_actions::CLIPBOARD_IMPORT_DIR);
            std::thread::spawn(move || {
                kinshoko_core::library::forget_staged_clipboard_images(&staged)
            });
            app.manage(DesktopState {
                history: Mutex::new(history),
                pending_collection: Mutex::new(None),
                pending_open: Mutex::new(None),
                menu: Mutex::default(),
                capture: Mutex::new(capture::Session::Idle),
                capture_frames: capture::FrameChannel::default(),
                pin_shown: pins::ShownWaiters::default(),
                capture_geometry_generation: AtomicU64::new(0),
                pins: Mutex::default(),
                store: Mutex::new(store),
                dirty: AtomicBool::new(false),
                edge: Mutex::default(),
                // 先按开启处理（主线程上不读应用壳设置）；恢复钉图的线程再按保存的设置核对。
                veils: Mutex::new(PinVeils::new(true)),
                groups: Mutex::new(groups),
            });
            let handle = app.clone();
            app.listen_any(LIBRARY_EVENT, move |event| {
                on_library_event(&handle, event.payload());
            });
            // 安全模式是应用设置：开关或调整范围（#223）时不论有没有打开资料库都到这里。
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
                std::thread::spawn(move || pins::refresh_all(&app));
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

/// 设置里的“增强钉图边缘”开关了（#239）：已经钉着的钉图立即重画。不要持有设置的锁调用。
pub fn pin_edge_contrast_changed(app: &AppHandle) {
    pins::refresh_all(app);
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

/// 冻结屏幕现场编码；历史中的截图与参考组自带的截图直接读文件，都是内嵌显示器配置文件的 PNG。
fn capture_response(app: &AppHandle, path: &str) -> Response<Vec<u8>> {
    let body = if let Some(token) = path.strip_prefix("screen/") {
        timing("png.begin");
        let png = capture::frozen_png(app, token);
        timing(&format!(
            "png.end bytes={}",
            png.as_ref().map_or(0, Vec::len)
        ));
        png
    } else if let Some((group, member)) =
        path.strip_prefix("group/").and_then(|p| p.split_once('/'))
    {
        // 参考组自带的截图（#270），参考组面板的缩略图用。
        let file = lock(&state(app).groups).capture_path(group, member);
        file.and_then(|f| std::fs::read(f).ok())
    } else {
        let file = lock(&state(app).history).file(path);
        file.and_then(|f| std::fs::read(f).ok())
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

/// 钉图菜单“在 Kinshoko 中打开”（#106）：打开主窗口，请它显示参考图（查看器）或截图历史。
/// 主窗口可能还没建好，请求先留着，由它用 `take_open_request` 取走。
fn request_open(app: &AppHandle, request: OpenInKinshoko) {
    *lock(&state(app).pending_open) = Some(request);
    shell::open_main_window(app);
    let _ = app.emit("open-in-kinshoko", ());
}

#[tauri::command]
async fn take_open_request(app: AppHandle) -> Option<OpenInKinshoko> {
    lock(&state(&app).pending_open).take()
}

/// 菜单窗口此刻要显示的菜单（窗口第一次建好、页面加载完时取）。
#[tauri::command]
async fn desktop_menu(app: AppHandle) -> Option<PinMenuOpen> {
    menu::current(&app)
}

/// 菜单画好了：显示菜单窗口并给它焦点。
#[tauri::command]
async fn desktop_menu_shown(app: AppHandle, generation: u32) {
    menu::shown(&app, generation);
}

/// 菜单关掉了（Esc、点外部、失去焦点）：隐藏菜单窗口。
#[tauri::command]
async fn close_desktop_menu(app: AppHandle, generation: u32) {
    menu::close(&app, generation);
}

/// 截图历史条目菜单“复制”（#106）：把截图复制到剪贴板。
#[tauri::command]
async fn copy_capture(app: AppHandle, id: String) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || pins::copy_capture_image(&app, &id))
        .await
        .map_err(CommandError::system)?
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
) -> Result<CollectedCapture, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let collected = library::with_destination_published(&app, &destination, |library| {
            let pending = lock(&state(&app).history)
                .prepare_collect(&id)
                .map_err(CommandError::from)?;
            let collected = pending.import(library).map_err(CommandError::from)?;
            lock(&state(&app).history)
                .finish_collect(collected)
                .map_err(CommandError::from)
        })?;
        history_changed(&app);
        groups::capture_collected(&app, &id, &collected);
        Ok(collected)
    })
    .await
    .map_err(CommandError::system)?
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
async fn delete_capture(app: AppHandle, id: String) -> Result<(), CommandError> {
    lock(&state(&app).history)
        .delete(&id)
        .map_err(CommandError::from)?;
    history_changed(&app);
    Ok(())
}

/// 全局快捷键按下时在主线程上调用。不能阻塞，也不能加 [`shell::ShellState`] 的锁；
/// 耗时的工作（截图、读剪贴板）放到别的线程。
pub fn on_shortcut(app: &AppHandle, action: ShortcutAction) {
    match action {
        ShortcutAction::Capture => capture::start(app),
        ShortcutAction::PinClipboard => pins::pin_clipboard_in_background(app),
        ShortcutAction::HideAllPins => edge::toggle_in_background(app),
    }
}

/// Update reveal authority during the actual mode commit, before emitting delayed events.
/// Caller holds visibility_commit; this performs no window operations or dispatch.
pub fn safe_mode_committed<R: tauri::Runtime>(app: &AppHandle<R>, safe: bool) {
    if let Some(state) = app.try_state::<DesktopState>() {
        lock(&state.veils).set_safe_mode(safe);
    }
}

/// 同 [`safe_mode_committed`]，在安全模式范围（#223）提交时调用：收紧时之前的确认显示
/// 当即作废，放宽时保留。
pub fn safe_mode_scope_committed<R: tauri::Runtime>(
    app: &AppHandle<R>,
    scope: kinshoko_core::library::SafeModeScope,
) {
    if let Some(state) = app.try_state::<DesktopState>() {
        lock(&state.veils).set_scope(scope);
    }
}

/// Revoke previous configuration views immediately, including same-mode explicit pin reveals.
/// Caller holds visibility_commit. Native destruction callbacks only dispatch background cleanup.
pub fn settings_restored<R: tauri::Runtime>(
    app: &AppHandle<R>,
    safe: kinshoko_core::library::SafeMode,
) {
    let state = app.state::<DesktopState>();
    let mut veils = PinVeils::new(safe.on);
    veils.set_scope(safe.scope);
    *lock(&state.veils) = veils;
    clear_viewer_reference(app);
    *lock(&state.capture) = capture::Session::Idle;
    if let Some(window) = app.get_webview_window(capture::CAPTURE_WINDOW) {
        let _ = window.destroy();
    }
    let _ = app.emit("application-settings-restored", ());
}
