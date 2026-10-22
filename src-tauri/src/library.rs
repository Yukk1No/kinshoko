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

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use kinshoko_core::approx::{ApproxRelation, BuiltinApproxTable};
use kinshoko_core::diagnostics::{LibraryNo, LogEvent};
use kinshoko_core::library::{
    BrowsePage, BrowseQuery, EagleDiscoveryOptions, EagleLibraryCandidate, EagleTagMapping,
    ExternalVocabulary, ImageDetail, ImageEdit, ImageRating, ImageTags, ImportOptions,
    ImportSource, LibraryEvent, LibraryInfo, MappedExternal, PermanentDeletePreview,
    PersonalApproxEntry, RecoveryReport, ReferenceLens, Sidebar, TagAlias, TagEdit, TagGroupView,
    TagNamespace, TagTranslations, Vocabulary, discover_eagle_libraries as discover_eagle,
};
use kinshoko_core::library_batch::{
    LibraryBatchFailure, LibraryDeletePreview, LibraryDeleteToken, LibraryTarget, each_library,
    group_by_library,
};
use kinshoko_core::reference_groups::{DetachedLenses, References};
use kinshoko_core::search::{
    Candidate, ConditionTree, RatingCandidate, Search, SearchCache, SearchInput,
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

const EVENT: &str = "library-event";
/// 连续的列表、图片与词表变化合并推送的窗口（#142）。
const EVENT_COALESCE: std::time::Duration = std::time::Duration::from_millis(500);
/// 安全模式（应用设置）开关后推送，载荷为开关状态。不论有没有打开资料库都推送：
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
    /// 活动资料库词表快照上的 Search，按（资料库，词表修订号，安全模式）校验；词表或图片
    /// 变化、安全模式切换、切换资料库时清掉，下次查找时重建（#76）。
    search: Arc<SearchCache>,
    catalog: Arc<Mutex<Option<TagCatalog>>>,
    search_catalog_revision: Arc<AtomicI64>,
    safe_mode_generation: AtomicU64,
    import_preview_generation: AtomicU64,
    /// Serialize visibility revocation with the final externally visible side effect.
    visibility_commit: Arc<Mutex<()>>,
    workspace: Mutex<Option<kinshoko_core::workspace::Workspace>>,
    /// 活动资料库参考视角的句柄，装配时取走（每个打开的资料库一次）。只交给参考组（#66）
    /// 与桌面钉图（#65），不经任何命令交给前端。
    reference: Mutex<Option<ReferenceLens>>,
    /// 未激活资料库的只读参考视角（参考组跨库引用，#66）。切换、登记变化时清掉，释放数据库文件。
    detached: DetachedLenses,
    /// 随软件分发的内置近似对应表，启动时读取一次。
    builtin_approx: Arc<BuiltinApproxTable>,
    /// 随软件分发的翻译表（见 [`bundled_translations`]）：资料库首次进库的外部名称取它的
    /// 各语言名称，迁入向导也按它匹配 Eagle 标签。
    translations: Arc<TagTranslations>,
    /// 迁入向导的外部词表及它读自哪份模型词表；模型变了才重读。
    external_vocabulary: Mutex<Option<(Option<PathBuf>, ExternalVocabulary)>>,
}

impl LibraryState {
    fn new(device_dir: PathBuf) -> LibraryState {
        LibraryState {
            device_dir,
            libraries: Arc::default(),
            forwarded: Mutex::new(None),
            forwarded_handles: Mutex::new(Vec::new()),
            transition: Mutex::new(()),
            search: Arc::default(),
            catalog: Arc::default(),
            search_catalog_revision: Arc::new(AtomicI64::new(-1)),
            safe_mode_generation: AtomicU64::new(0),
            import_preview_generation: AtomicU64::new(0),
            visibility_commit: Arc::new(Mutex::new(())),
            workspace: Mutex::default(),
            reference: Mutex::new(None),
            detached: DetachedLenses::default(),
            builtin_approx: Arc::new(BuiltinApproxTable::bundled()),
            translations: Arc::new(bundled_translations()),
            external_vocabulary: Mutex::new(None),
        }
    }

    /// Configure shared writer policy before application actions: initial names and the
    /// same final visibility gate used by package/copy rating publication.
    fn configure_library(&self, library: &Library) {
        library.use_translations_for_new_tags((*self.translations).clone());
        library.use_package_publication_gate(self.visibility_commit.clone());
    }

    /// 活动资料库，不核对身份。只给不经界面请求的入口用（缩略图协议、安全模式开关）。
    fn active(&self) -> Result<Arc<Library>, String> {
        lock(&self.libraries)
            .as_ref()
            .and_then(DeviceLibraries::current)
            .ok_or_else(|| "还没有打开资料库".to_owned())
    }
}

fn with_libraries<T>(
    device_dir: &Path,
    state: &Mutex<Option<DeviceLibraries>>,
    action: impl FnOnce(&mut DeviceLibraries) -> Result<T, DeviceLibraryError>,
) -> Result<T, String> {
    let mut state = lock(state);
    if state.is_none() {
        *state = Some(DeviceLibraries::open(device_dir).map_err(|error| error.to_string())?);
    }
    action(state.as_mut().expect("登记表已打开")).map_err(|error| error.to_string())
}

fn with_catalog<T>(
    device_dir: &Path,
    state: &Mutex<Option<TagCatalog>>,
    action: impl FnOnce(&mut TagCatalog) -> Result<T, CatalogError>,
) -> Result<T, String> {
    let mut state = lock(state);
    if state.is_none() {
        let mut catalog = TagCatalog::open(device_dir).map_err(|e| e.to_string())?;
        catalog
            .install_name_defaults(bundled_translations())
            .map_err(|e| e.to_string())?;
        *state = Some(catalog);
    }
    action(state.as_mut().expect("统一目录已打开")).map_err(|e| e.to_string())
}

fn catalog_search(
    device_dir: &Path,
    catalog: &Mutex<Option<TagCatalog>>,
    revision: &AtomicI64,
    cache: &SearchCache,
    library: &Arc<Library>,
    builtin: &BuiltinApproxTable,
    safe_mode: bool,
) -> Result<Arc<Search>, String> {
    // Hold catalog serialization until the cached projection has been built. A correction
    // cannot race an older snapshot back into the cache after invalidation.
    with_catalog(device_dir, catalog, |catalog| {
        let snapshot = catalog.synchronize(library)?;
        if revision.swap(snapshot.revision, Ordering::SeqCst) != snapshot.revision {
            cache.invalidate();
        }
        cache
            .search_with(library, safe_mode, |vocabulary| {
                Search::new(
                    &snapshot.search_vocabulary(&library.info().id, vocabulary),
                    builtin,
                )
            })
            .map_err(CatalogError::Library)
    })
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
            browse,
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
            set_safe_mode
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
            let preferred = kinshoko_core::AppSettings::open(dirs.settings())
                .ok()
                .and_then(|s| s.tagging_device());
            crate::tagging::setup(app, dirs.models().to_path_buf(), preferred);
            app.manage(LibraryState::new(device_dir));
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

/// 核心已完成切换，这里装配新的活动资料库：设上保存的安全模式、取走参考视角、清掉旧库的
/// Search 快照、为它开始打标，并转发它的事件。每个活动句柄只装配一次；事件按句柄转发，
/// 切换后旧句柄（例如导入仍持有的库）的事件照常带着它的资料库身份送到界面。
///
/// 新打开的资料库在核心里先是封存状态（安全模式开），这里再按设置放开。
fn forward_events<R: Runtime>(
    app: &AppHandle<R>,
    state: &LibraryState,
    library: Arc<Library>,
) -> LibraryInfo {
    let info = library.info().clone();
    let weak = Arc::downgrade(&library);
    let mut forwarded = lock(&state.forwarded);
    if forwarded
        .as_ref()
        .is_some_and(|previous| Weak::ptr_eq(previous, &weak))
    {
        return info;
    }
    *forwarded = Some(weak.clone());
    library.set_safe_mode(saved_safe_mode(app));
    if let Err(error) = with_catalog(&state.device_dir, &state.catalog, |catalog| {
        catalog.synchronize(&library)
    }) {
        crate::run_log::error("接入统一标签目录失败", error);
    }
    state.configure_library(&library);
    let events = library.events();
    *lock(&state.reference) = library.take_reference_lens();
    // 刚成为活动库的库不再经只读视角读取；其他库按需重开。
    state.detached.clear();
    state.search.invalidate();
    crate::tagging::attach(app, library);
    let mut handles = lock(&state.forwarded_handles);
    handles.retain(|handle| handle.strong_count() > 0);
    if handles.iter().any(|handle| Weak::ptr_eq(handle, &weak)) {
        return info;
    }
    handles.push(weak);
    drop(handles);
    let (app, search) = (app.clone(), state.search.clone());
    // 每个句柄的事件都转发，直到句柄关闭（ADR-0008）：可写句柄切到别的库后，原库仍在进行的导入的
    // 进度、结束与列表变化照常送到界面。事件都带资料库身份，界面只采纳它正在显示的库的安全模式与
    // 导入事件，不串台。
    std::thread::Builder::new()
        .name("kinshoko-library-events".into())
        .spawn(move || {
            // 自动打标每写一张图都有图片与词表变化：合并后再送到界面，免得每张图都让界面重读一遍、
            // 在后端阻塞线程池里排起长队（#142）。
            kinshoko_core::library::forward_coalesced(events, EVENT_COALESCE, |mut event| {
                // 有新图进库：自动标签立即检查，不等下一次轮询。
                if matches!(event, LibraryEvent::ListStale { .. }) {
                    crate::tagging::wake(&app);
                }
                // 先清掉旧快照再通知前端，前端收到事件后的查找用的是新词表。
                // 安全模式切换后词表计数与可见的标签都变了。
                if matches!(
                    event,
                    LibraryEvent::VocabularyChanged { .. }
                        | LibraryEvent::ImagesChanged { .. }
                        | LibraryEvent::ListStale { .. }
                        | LibraryEvent::SafeModeChanged { .. }
                ) {
                    search.invalidate();
                }
                // Task-finished events may race the all-provider projection. Raw success details
                // stay in the fixed task owner; polling returns the checked ordinary receipt.
                if let LibraryEvent::TaskFinished { report, .. } = &mut event {
                    *report = report.clone().without_content_details();
                }
                let _ = app.emit(EVENT, event);
            });
        })
        .expect("无法启动事件转发线程");
    info
}

/// 设置里的安全模式；读不到设置时按开启处理。
fn saved_safe_mode<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<ShellState>()
        .and_then(|shell| shell.0.lock().ok().map(|s| s.settings.safe_mode()))
        .unwrap_or(true)
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests;
