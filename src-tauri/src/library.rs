//! 资料库的命令层（内联插件 `library`）：只做转发、类型转换和事件推送，领域逻辑在
//! `kinshoko_core::library`。前端以 `plugin:library|<命令>` 调用。
//!
//! - 命令都是 async，阻塞工作放进 `spawn_blocking`，不占用主线程；
//! - 本设备可登记多个资料库，同一时间一个活动资料库（#49）。保存命令固定库和目录；来源整理命令带明确来源。浏览命令带界面正在操作的
//!   资料库 id，切换后旧请求得到错误，不会落到新库上；
//! - 界面上没有“当前资料库”（ADR-0008，#112）：整理命令（文件夹、放入、回收站、标签）带资料库身份，
//!   由 [`writable`] 把唯一的可写句柄按需切过去；该库或当前持有者有导入在收尾时等它结束再执行，
//!   并推送 `organize-waiting` 作为轻提示；
//! - 资料库事件转发为窗口事件 `library-event`，按来源身份转发；导入回执独立保留任务所属库和目录；
//! - 缩略图走自定义协议 `thumb`：`<资料库 id>/<参考图 id>/<像素档位>`，缓存缺失时现场生成；
//! - 安全模式（#60）：开关保存在应用壳设置里，打开资料库与切换时设给当前资料库。这里的命令都是
//!   浏览视角；参考视角的句柄在装配（打开资料库）时取走，只交给参考组与桌面钉图，不经命令给前端。

use kinshoko_core::CommandError;
use kinshoko_core::command_error::ErrorKind;

mod approx;
mod groups;
mod import_preview;
mod name_migration;
mod names;
mod portable;
mod save_destination;
mod settings_backup;
pub use portable::{
    content_definitions, export_package as export_reference_package,
    import_package as import_reference_package, publish_definition_dependencies,
};
mod source_actions;
pub use save_destination::{with_destination, with_destination_published};
mod access;
mod workspace;
pub use access::*;
mod import_commands;
use import_commands::*;
mod organize_commands;
use organize_commands::*;
mod registry_commands;
use registry_commands::*;
mod search_commands;
use search_commands::*;
mod tag_commands;
use tag_commands::*;
mod thumbnails;
pub use thumbnails::*;
mod forward;
use forward::forward_events;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use kinshoko_core::approx::{ApproxRelation, BuiltinApproxTable};
use kinshoko_core::diagnostics::{LibraryNo, LogEvent};
use kinshoko_core::library::{
    EagleDiscoveryOptions, EagleLibraryCandidate, EagleTagMapping, ExternalVocabulary, ImageDetail,
    ImageEdit, ImageRating, ImageTags, ImportOptions, ImportSource, LibraryEvent, LibraryInfo,
    MappedExternal, PermanentDeletePreview, PersonalApproxEntry, RecoveryReport, ReferenceLens,
    SafeMode, SafeModeScope, Sidebar, TagAlias, TagEdit, TagGroupView, TagNamespace,
    TagTranslations, Vocabulary, discover_eagle_libraries as discover_eagle,
};
use kinshoko_core::library_batch::{
    LibraryBatchFailure, LibraryDeletePreview, LibraryDeleteToken, LibraryTarget, each_library,
    group_by_library,
};
use kinshoko_core::reference_groups::{DetachedLenses, References};
use kinshoko_core::safe_mode::{SafeModeSnapshot, SafeModeState};
use kinshoko_core::search::{
    Candidate, CatalogSearch, ConditionTree, RatingCandidate, SearchInput,
};
use kinshoko_core::tag_catalog::{
    CatalogCorrection, CatalogError, CatalogImageTags, TagCatalog, TagCatalogWorkspace,
};
use kinshoko_core::{
    DeviceLibraries, DeviceLibraryError, DeviceRegistry, Library, LibraryRegistration,
    WriterAccess, wait_for_writer,
};
use tauri::http::{Response, StatusCode, header};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::shell::ShellState;
use std::panic::Location;

use kinshoko_core::diagnostics::HeldLock;

const EVENT: &str = "library-event";
/// 连续的列表、图片与词表变化合并推送的窗口（#142）。
const EVENT_COALESCE: std::time::Duration = std::time::Duration::from_millis(500);
/// 安全模式（应用设置）开关或调整范围（#223）后推送，载荷为开关状态。不论有没有打开资料库都推送：
/// 桌面钉图据此重新核对遮蔽（#65）。
pub const SAFE_MODE_EVENT: &str = "safe-mode-setting";

/// 整理在等某个库的导入收尾（#112），载荷为 `OrganizeWaiting`；界面据此给轻提示。
const ORGANIZE_WAITING_EVENT: &str = "organize-waiting";
/// 整理时后端把唯一的可写句柄切到了另一个库（#112），载荷为它的 `LibraryInfo`。只给跟着可写库走的
/// 界面部分（自动标签）用；浏览范围与导入回执不随它变。
const WRITABLE_LIBRARY_EVENT: &str = "writable-library";
/// 等导入收尾时每次最多等这么久，然后重新检查（收尾结束会立即唤醒）。
const ORGANIZE_RECHECK: std::time::Duration = std::time::Duration::from_millis(500);
/// 等导入收尾的总上限：收尾一直不结束时，整理报错给界面，不让请求永远挂着。
const ORGANIZE_LIMIT: std::time::Duration = std::time::Duration::from_secs(120);

struct LibraryState {
    device_dir: PathBuf,
    /// 本设备登记表与活动资料库；第一次用到时读取登记表。
    libraries: Arc<Mutex<Option<DeviceLibraries>>>,
    /// 已在转发事件的活动资料库句柄；同一句柄只装配一次。
    forwarded: Mutex<Option<Weak<Library>>>,
    forwarded_handles: Mutex<Vec<Weak<Library>>>,
    /// 切换、恢复和取消登记串行完成，包括旧库打标退出。
    transition: Mutex<()>,
    /// 本设备安全模式的权威状态（#272）：启动时按设置初始化，设置命令经它提交。
    safe_mode: SafeModeState,
    /// 统一标签目录与其上的查找（#76、#272）：词表或图片变化、安全模式切换、切换资料库时
    /// 清掉查找缓存，下次查找时重建。
    search: Arc<CatalogSearch>,
    import_preview_generation: AtomicU64,
    /// Serialize visibility revocation with the final externally visible side effect.
    visibility_commit: Arc<Mutex<()>>,
    workspace: Mutex<Option<kinshoko_core::workspace::Workspace>>,
    /// 缩略图请求的放行（#313）：工作区每次取快照发布到这里，各登记的资料库在这里长期只读打开。
    /// 缩略图请求先问它，不拿上面三把锁；与 [`Self::detached`] 同时清掉，释放数据库文件。
    gate: Arc<kinshoko_core::workspace::ImageGate>,
    /// 活动资料库参考视角的句柄，装配时取走（每个打开的资料库一次）。只交给参考组（#66）
    /// 与桌面钉图（#65），不经任何命令交给前端。
    reference: Mutex<Option<ReferenceLens>>,
    /// 未激活资料库的只读参考视角（参考组跨库引用，#66）。切换、登记变化时清掉，释放数据库文件。
    detached: DetachedLenses,
    /// 随软件分发的翻译表（见 [`bundled_translations`]）：资料库首次进库的外部名称取它的
    /// 各语言名称，迁入向导也按它匹配 Eagle 标签。
    translations: Arc<TagTranslations>,
    /// 迁入向导的外部词表及它读自哪份模型词表；模型变了才重读。
    external_vocabulary: Mutex<Option<(Option<PathBuf>, ExternalVocabulary)>>,
}

impl LibraryState {
    fn new(device_dir: PathBuf, safe_mode: SafeMode) -> LibraryState {
        let translations = bundled_translations();
        LibraryState {
            search: Arc::new(CatalogSearch::new(
                device_dir.clone(),
                translations.clone(),
                BuiltinApproxTable::bundled(),
            )),
            device_dir,
            libraries: Arc::default(),
            forwarded: Mutex::new(None),
            forwarded_handles: Mutex::new(Vec::new()),
            transition: Mutex::new(()),
            safe_mode: SafeModeState::new(safe_mode),
            import_preview_generation: AtomicU64::new(0),
            visibility_commit: Arc::new(Mutex::new(())),
            workspace: Mutex::default(),
            gate: Arc::default(),
            reference: Mutex::new(None),
            detached: DetachedLenses::default(),
            translations: Arc::new(translations),
            external_vocabulary: Mutex::new(None),
        }
    }

    /// Configure shared writer policy before application actions: initial names and the
    /// same final visibility gate used by package/copy rating publication.
    fn configure_library(&self, library: &Library) {
        library.use_translations_for_new_tags((*self.translations).clone());
        library.use_package_publication_gate(self.visibility_commit.clone());
    }

    /// 放掉只读打开的资料库（参考视角与缩略图放行的句柄）：切换、登记变化、设置整份替换时。
    fn release_readers(&self) {
        self.detached.clear();
        self.gate.clear();
    }

    /// 活动资料库，不核对身份。只给不经界面请求的入口用（缩略图协议、安全模式开关）。
    #[track_caller]
    fn active(&self) -> Result<Arc<Library>, CommandError> {
        lock_libraries(self)
            .as_ref()
            .and_then(DeviceLibraries::current)
            .ok_or_else(|| CommandError::new(ErrorKind::LibraryNotOpen, "还没有打开资料库"))
    }
}

/// 本设备登记表与活动资料库；登记表第一次用到时才打开，打开时按设置里的安全模式范围设好。
#[track_caller]
/// 检查标签对应期间安全模式变了。
fn mapping_safe_mode_changed() -> CommandError {
    CommandError::new(
        ErrorKind::TagMappingSafeModeChanged,
        "安全模式已变化，请重新检查标签对应",
    )
}

fn groups_not_ready() -> CommandError {
    CommandError::new(ErrorKind::ReferenceGroupsNotReady, "参考组还没有准备好")
}

fn with_libraries<T>(
    state: &LibraryState,
    action: impl FnOnce(&mut DeviceLibraries) -> Result<T, DeviceLibraryError>,
) -> Result<T, CommandError> {
    with_libraries_at(state, Location::caller(), action)
}

/// 同 [`with_libraries`]；`site` 是记进运行日志的取锁处（#337）。
fn with_libraries_at<T>(
    state: &LibraryState,
    site: &'static Location<'static>,
    action: impl FnOnce(&mut DeviceLibraries) -> Result<T, DeviceLibraryError>,
) -> Result<T, CommandError> {
    let mut libraries = lock_libraries_at(state, site);
    if libraries.is_none() {
        let mut opened = DeviceLibraries::open(&state.device_dir).map_err(CommandError::from)?;
        // 刚打开，还没有句柄：只记下范围，不会失败。
        opened
            .set_safe_mode_scope(state.safe_mode.current().scope)
            .map_err(CommandError::from)?;
        *libraries = Some(opened);
    }
    action(libraries.as_mut().expect("登记表已打开")).map_err(CommandError::from)
}

#[track_caller]
fn with_catalog<T>(
    catalog: &CatalogSearch,
    action: impl FnOnce(&mut TagCatalog) -> Result<T, CatalogError>,
) -> Result<T, CommandError> {
    catalog
        .with_catalog_at(Location::caller(), action)
        .map_err(CommandError::from)
}

/// 登记表的锁，等锁、持锁久了记进运行日志（#337）。
struct LibrariesGuard<'a> {
    guard: std::sync::MutexGuard<'a, Option<DeviceLibraries>>,
    _held: HeldLock,
}

impl std::ops::Deref for LibrariesGuard<'_> {
    type Target = Option<DeviceLibraries>;
    fn deref(&self) -> &Self::Target {
        &self.guard
    }
}

impl std::ops::DerefMut for LibrariesGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.guard
    }
}

#[track_caller]
fn lock_libraries(state: &LibraryState) -> LibrariesGuard<'_> {
    lock_libraries_at(state, Location::caller())
}

fn lock_libraries_at<'a>(
    state: &'a LibraryState,
    site: &'static Location<'static>,
) -> LibrariesGuard<'a> {
    let waiting = std::time::Instant::now();
    let guard = lock(&state.libraries);
    LibrariesGuard {
        guard,
        _held: HeldLock::acquired("登记表", site, waiting),
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("library")
        .invoke_handler(tauri::generate_handler![
            settings_backup::pick_application_settings,
            settings_backup::export_application_settings,
            settings_backup::preview_application_settings,
            settings_backup::restore_application_settings,
            source_actions::workspace_preview_source_delete,
            source_actions::workspace_permanent_source_delete,
            source_actions::workspace_source_group,
            source_actions::workspace_source_inspection,
            source_actions::workspace_source_candidates,
            source_actions::workspace_edit_source,
            source_actions::workspace_edit_sources,
            source_actions::workspace_edit_source_tags,
            workspace::workspace_status,
            workspace::workspace_browse,
            workspace::workspace_resolve,
            workspace::workspace_candidates,
            workspace::workspace_image,
            workspace::workspace_card,
            workspace::workspace_sidebar,
            workspace::workspace_directories,
            workspace::workspace_tag_groups,
            workspace::workspace_local_tags,
            current_library,
            create_library,
            registered_libraries,
            register_library,
            switch_library,
            unregister_library,
            image,
            edit,
            preview_permanent_delete,
            permanent_delete,
            preview_empty_trash,
            preview_permanent_delete_batch,
            permanent_delete_batch,
            sidebar,
            create_folder,
            rename_folder,
            delete_folder,
            move_folder,
            recovery,
            start_import,
            save_destination::import_tasks,
            import_preview::open_import_preview,
            import_preview::read_import_preview,
            import_preview::close_import_preview,
            save_destination::dismiss_import,
            save_destination::workspace_copy_source,
            import_contains_eagle,
            cancel_import,
            pick_folder,
            pick_files,
            discover_eagle_libraries,
            confirm_eagle_location,
            image_tags,
            catalog_image_tags,
            inspect_tag_catalog,
            correct_tag_mapping,
            portable::publish_tag_definitions,
            names::edit_tag_name,
            groups::shared_tag_groups,
            approx::shared_personal_approx,
            approx::edit_shared_approx,
            groups::create_shared_tag_group,
            groups::edit_shared_tag_group,
            name_migration::plan_legacy_names,
            name_migration::preview_legacy_names,
            name_migration::confirm_legacy_names,
            edit_tags,
            vocabulary,
            tag_groups,
            add_tag_alias,
            remove_tag_alias,
            create_tag_group,
            rename_tag_group,
            delete_tag_group,
            add_to_tag_group,
            remove_from_tag_group,
            search_candidates,
            rating_candidates,
            resolve_search,
            set_tag_approx,
            remove_tag_approx,
            personal_approx,
            eagle_tag_mapping,
            map_tag_external,
            set_source_name_lang,
            external_suggestions,
            image_rating,
            safe_mode,
            set_safe_mode,
            set_safe_mode_scope
        ])
        .setup(|app, _api| {
            let dirs = crate::data_dirs::app_data(app);
            let device_dir = dirs.device().to_path_buf();
            kinshoko_core::application_settings_backup::ApplicationSettingsBackup::recover(
                &device_dir,
                dirs.settings(),
            )
            .map_err(std::io::Error::other)?;
            // 硬件档保存在应用壳设置里；这里只读一次，之后由设置命令同步。
            let saved = kinshoko_core::AppSettings::open(dirs.settings()).ok();
            let preferred = saved.as_ref().and_then(|s| s.tagging_device());
            crate::tagging::setup(app, dirs.models().to_path_buf(), preferred);
            // 读不到设置时按 SafeModeState 的默认值：开启，默认范围。
            let safe_mode = saved.as_ref().map_or_else(
                || SafeModeState::default().current(),
                |s| SafeMode::new(s.safe_mode(), s.safe_mode_scope()),
            );
            let state = LibraryState::new(device_dir, safe_mode);
            state.detached.set_safe_mode_scope(safe_mode.scope);
            app.manage(state);
            workspace::monitor(app.clone());
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("thumb", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().trim_start_matches('/').to_owned();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(thumbnail_response(&app, &path));
            });
        })
        .build()
}

/// 设置里的安全模式（[`SafeModeState`]）；资料库插件还没装配时按其默认值。
fn saved_mode<R: Runtime>(app: &AppHandle<R>) -> SafeMode {
    app.try_state::<LibraryState>().map_or_else(
        || SafeModeState::default().current(),
        |state| state.safe_mode.current(),
    )
}

/// 这张图此刻能不能显示（已登记、没被安全模式隐藏），与 `thumb` 协议同一套核对。
pub(crate) fn image_shown<R: Runtime>(
    app: &AppHandle<R>,
    library_id: &str,
    image_id: &str,
) -> bool {
    let mut slow = false;
    workspace::read_image(app, library_id, image_id, &mut slow).is_ok()
}

/// 设置里的安全模式开关；还没迁移的命令组用它“开始记下、结束复核”。
pub(crate) fn saved_safe_mode<R: Runtime>(app: &AppHandle<R>) -> bool {
    saved_mode(app).on
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(CommandError::system)?
}

#[cfg(test)]
mod tests;
