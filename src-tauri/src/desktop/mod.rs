//! Desktop：截图、截图历史、桌面钉图、贴边隐藏与托盘（内联插件 `desktop`，前端以 `plugin:desktop|<命令>` 调用）。
//! 规则在 `kinshoko_core::desktop`，这里只接系统：抓屏、剪贴板、窗口、托盘与全局快捷键。
//!
//! 持有 [`DesktopState`] 的锁时不调用窗口 API：主线程回调也要拿锁。抓屏、剪贴板与收藏在后台做。
//!
//! - 截图历史、冻结屏幕与参考组自带的截图走自定义协议 `capture`：`screen/<标记>`、`<截图 id>`、
//!   `group/<参考组 id>/<成员>`；
//! - 资料库事件（安全模式开关、分级变化）到达时，资料库钉图重新核对要不要遮蔽；
//! - 截图历史变化时向所有窗口推送 `capture-history`（截图列表，从新到旧）；
//! - 参考组（#66、#588）：桌面上始终摆着一个参考组，钉图就是它的成员；切换、归档、并入等见
//!   [`desk_commands`]，参考组包与成员见 [`groups`]；
//! - 钉图的右键菜单（#106）：与主窗口同样式，由独立的置顶无边框菜单窗口承载（[`menu`]）；
//! - 复制图片、在资源管理器中显示、从剪贴板导入（#105，[`image_actions`]）。

use kinshoko_core::CommandError;

mod capture;
mod clipboard;
mod desk_commands;
mod edge;
mod events;
mod exit;
mod group_trash;
mod groups;
mod image_actions;
mod menu;
mod pin_state;
mod pins;
mod tray;

pub(crate) use capture::CAPTURE_WINDOW;
use events::{capture_response, history_changed, request_collection, request_open};
pub use exit::on_exit;
pub(crate) use menu::MENU_WINDOW;
pub use tray::*;
#[cfg(windows)]
pub(crate) mod win32;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use kinshoko_core::ShortcutAction;
use kinshoko_core::desktop::{
    CaptureEntry, CaptureHistory, CollectedCapture, EdgeHide, OpenInKinshoko, PinMenuOpen, PinVeils,
};
use kinshoko_core::reference_groups::{Desk, ReferenceGroups};
use tauri::http::{Response, StatusCode, header};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::app_notice::{AppNotice, publish};
use crate::sync::lock;
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
    /// 钉图状态（桌面上的参考组，#588），重新打开后恢复。
    store: Mutex<pin_state::PinState>,
    /// 钉图状态改了还没写回文件。
    dirty: AtomicBool,
    edge: Mutex<EdgeHide>,
    /// 安全模式开关与逐张确认显示的资料库钉图（#65）。
    veils: Mutex<PinVeils>,
    /// 本设备的参考组（#66）。改动在锁里串行完成。
    groups: Mutex<ReferenceGroups>,
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

/// 图库墙“加入参考组”（`pin` 是资料库里的一张图）：加进参考组 `group_id`，成为它的新成员。
/// 那个参考组正摆在桌面上时，把图钉到桌面上，以 `centre`（右键处）为中心，没有时在主显示器中间。
/// 桌面插件还没装好时为 `None`。
pub fn add_to_reference_group<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    group_id: &str,
    mut pin: kinshoko_core::desktop::SavedPin,
    centre: Option<(i32, i32)>,
) -> Option<Result<kinshoko_core::reference_groups::ReferenceGroup, CommandError>> {
    let state = app.try_state::<DesktopState>()?;
    let result = (|| -> Result<_, kinshoko_core::reference_groups::GroupError> {
        let _groups = lock(&state.groups);
        let mut store = lock(&state.store);
        let desk = store.desk();
        if let Some(group) = desk.add_member(group_id, &pin)? {
            return Ok(group);
        }
        let others: Vec<_> = desk.pins().iter().map(|p| p.rect()).collect();
        pins::place_around(&mut pin, centre, &others);
        desk.pin(pin, &mut lock(&state.history))?;
        state.dirty.store(true, Ordering::Relaxed);
        desk.group()
            .cloned()
            .ok_or(kinshoko_core::reference_groups::GroupError::UnknownGroup)
    })()
    .map_err(CommandError::from);
    if result.is_ok() {
        publish(app, AppNotice::DeskChanged);
    }
    Some(result)
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
            pins::show_pin_notice,
            desktop_menu,
            desktop_menu_shown,
            close_desktop_menu,
            take_open_request,
            copy_capture,
            pins::pin_reference,
            image_actions::copy_reference_image,
            image_actions::reveal_reference_image,
            image_actions::reveal_library,
            image_actions::clipboard_has_image,
            image_actions::stage_clipboard_import,
            image_actions::stage_dropped_image,
            groups::reference_groups,
            groups::reference_group,
            groups::rename_reference_group,
            group_trash::delete_reference_group,
            group_trash::restore_reference_group,
            group_trash::purge_deleted_reference_group,
            groups::remove_group_member,
            desk_commands::desk_reference_groups,
            desk_commands::switch_reference_group,
            desk_commands::new_reference_desk,
            desk_commands::repin_group_member,
            desk_commands::repin_all_group_members,
            desk_commands::show_group_member,
            desk_commands::prune_unpinned_members,
            desk_commands::undo_prune_unpinned,
            desk_commands::remove_desk_group_member,
            desk_commands::set_reference_group_favorite,
            desk_commands::duplicate_reference_group,
            desk_commands::fold_into_previous,
            desk_commands::split_off_reference_group,
            desk_commands::undo_split_off,
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
            let mut history = CaptureHistory::open(&dir.join(HISTORY_DIR))?;
            let groups = ReferenceGroups::open(&dir.join(GROUPS_DIR))?;
            // 桌面上的参考组（#588）。第一次打开时迁移：旧参考组都算收藏，`pins.json` 的钉图成为一个
            // 没有名称的参考组摆在桌面上。打不开时不启动（Lou 2026-11-22，#632）：说明原因，文件原样留着。
            let desk = match Desk::open(&dir, groups.clone(), &mut history) {
                Ok(desk) => desk,
                Err(e) => {
                    crate::run_log::error("无法打开桌面上的参考组", &e);
                    let message = crate::ui_text::fill(
                        crate::ui_text::Text::DeskUnreadable,
                        &[
                            ("path", &dir.join("desk.json").display().to_string()),
                            ("error", &e.to_string()),
                        ],
                    );
                    eprintln!("{message}");
                    #[cfg(windows)]
                    win32::show_error(
                        crate::ui_text::text(crate::ui_text::Text::StartupFailed),
                        &message,
                    );
                    std::process::exit(1);
                }
            };
            // 上次退出时撤销提示还没过期的已删除参考组，这里清掉。
            let _ = groups.purge_all_trashed();
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
                store: Mutex::new(pin_state::PinState::new(desk)),
                dirty: AtomicBool::new(false),
                edge: Mutex::default(),
                // 先按开启处理（主线程上不读应用壳设置）；恢复钉图的线程再按保存的设置核对。
                veils: Mutex::new(PinVeils::new(true)),
                groups: Mutex::new(groups),
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

pub(crate) use events::on_notice;
