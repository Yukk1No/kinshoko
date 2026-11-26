//! 资料库的命令层（内联插件 `library`）：只做转发、类型转换和事件推送，领域逻辑在
//! `kinshoko_core::library`。前端以 `plugin:library|<命令>` 调用。
//!
//! - 命令都是 async，阻塞工作放进 `spawn_blocking`，不占用主线程；
//! - 本设备可登记多个资料库，同一时间一个活动资料库（#49）。保存命令固定库和目录；来源整理命令带明确来源。浏览命令带界面正在操作的
//!   资料库 id，切换后旧请求得到错误，不会落到新库上；
//! - 界面上没有“当前资料库”（ADR-0008，#112）：整理命令（文件夹、放入、回收站、标签）带资料库身份，
//!   由 [`writable`] 把活动资料库按需切过去（同一个资料库始终只有一个可写句柄，ADR-0008 修订）；
//!   该库或当前持有者有导入在收尾时等它结束再执行，并推送 `organize-waiting` 作为轻提示；
//! - 资料库事件转发为窗口事件 `library-event`，按来源身份转发；导入回执独立保留任务所属库和目录；
//! - 缩略图走自定义协议 `thumb`：`<资料库 id>/<参考图 id>/<像素档位>`，缓存缺失时现场生成；
//! - 安全模式（#60）：开关保存在应用壳设置里，打开资料库与切换时设给活动资料库。这里的命令都是
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
mod lens;
use lens::{Hold, with_lens};
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
mod verbs;
use forward::forward_events;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use kinshoko_core::approx::{ApproxRelation, BuiltinApproxTable};
use kinshoko_core::diagnostics::{LibraryNo, LogEvent};
use kinshoko_core::library::{
    EagleDiscoveryOptions, EagleLibraryCandidate, EagleTagMapping, ExternalVocabulary, ImageDetail,
    ImageEdit, ImportOptions, ImportSource, LibraryEvent, LibraryInfo, MappedExternal,
    PermanentDeletePreview, RecoveryReport, ReferenceLens, SafeMode, SafeModeScope, Sidebar,
    TagAlias, TagEdit, TagGroupView, TagNamespace, TagTranslations, Vocabulary,
    discover_eagle_libraries as discover_eagle,
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
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::app_notice::{AppNotice, publish};
use crate::blocking::blocking;
use crate::shell::ShellState;
use crate::sync::lock;
use std::panic::Location;

use kinshoko_core::WorkspaceSession;
use kinshoko_core::session::LibrariesGuard;

/// 连续的列表、图片与词表变化合并推送的窗口（#142）。
const EVENT_COALESCE: std::time::Duration = std::time::Duration::from_millis(500);
/// 等导入收尾时每次最多等这么久，然后重新检查（收尾结束会立即唤醒）。
const ORGANIZE_RECHECK: std::time::Duration = std::time::Duration::from_millis(500);
/// 等导入收尾的总上限：收尾一直不结束时，整理报错给界面，不让请求永远挂着。
const ORGANIZE_LIMIT: std::time::Duration = std::time::Duration::from_secs(120);

/// 资料库插件的状态。锁、安全模式与取锁顺序都在 [`WorkspaceSession`] 里；这里只放命令壳
/// 自己的事：事件转发、参考视角、翻译表与迁入向导的缓存。
struct LibraryState {
    session: WorkspaceSession,
    /// 已在转发事件的活动资料库句柄；同一句柄只装配一次。
    forwarded: Mutex<Option<Weak<Library>>>,
    forwarded_handles: Mutex<Vec<Weak<Library>>>,
    workspace_wake: workspace::MonitorWake,
    // Only one thumbnail should contend for workspace locks when the fast path expires.
    image_gate_refresh: Mutex<()>,
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
        let search = CatalogSearch::new(
            device_dir.clone(),
            translations.clone(),
            BuiltinApproxTable::bundled(),
        );
        LibraryState {
            session: WorkspaceSession::new(device_dir, safe_mode, search),
            forwarded: Mutex::new(None),
            forwarded_handles: Mutex::new(Vec::new()),
            workspace_wake: workspace::MonitorWake::default(),
            image_gate_refresh: Mutex::default(),
            reference: Mutex::new(None),
            detached: DetachedLenses::default(),
            translations: Arc::new(translations),
            external_vocabulary: Mutex::new(None),
        }
    }

    /// 本设备安全模式的权威状态（#272），只读：改动经可见性许可（[`lens::commit_safe_mode`]）。
    fn safe_mode(&self) -> &SafeModeState {
        self.session.safe_mode()
    }

    /// 统一标签目录与其上的查找（#76、#272）：词表或图片变化、安全模式切换、切换资料库时
    /// 清掉查找缓存，下次查找时重建。
    fn search(&self) -> &Arc<CatalogSearch> {
        self.session.search()
    }

    fn device_dir(&self) -> &Path {
        self.session.device_dir()
    }

    /// Configure shared writer policy before application actions: initial names and the
    /// same final visibility gate used by package/copy rating publication.
    fn configure_library(&self, library: &Library) {
        library.use_translations_for_new_tags((*self.translations).clone());
        self.session.configure_library(library);
    }

    /// 放掉只读打开的资料库（参考视角与缩略图放行的句柄）：切换、登记变化、设置整份替换时。
    fn release_readers(&self) {
        self.detached.clear();
        self.session.release_readers();
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

pub(crate) fn groups_not_ready() -> CommandError {
    CommandError::new(ErrorKind::ReferenceGroupsNotReady, "参考组还没有准备好")
}

#[track_caller]
fn with_libraries<T>(
    state: &LibraryState,
    action: impl FnOnce(&mut DeviceLibraries) -> Result<T, DeviceLibraryError>,
) -> Result<T, CommandError> {
    state.session.with_libraries_at(Location::caller(), action)
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
#[track_caller]
fn lock_libraries(state: &LibraryState) -> LibrariesGuard<'_> {
    state.session.lock_libraries_at(Location::caller())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("library")
        .invoke_handler(command_registry!(library, command_handler))
        .setup(|app, _api| {
            let dirs = crate::data_dirs::app_data(app);
            let device_dir = dirs.device().to_path_buf();
            kinshoko_core::application_settings_backup::ApplicationSettingsBackup::recover(
                &device_dir,
                dirs.settings(),
            )
            .map_err(std::io::Error::other)?;
            let saved = kinshoko_core::AppSettings::open(dirs.settings()).ok();
            // 读不到设置时按 SafeModeState 的默认值：开启，默认范围。
            let safe_mode = saved.as_ref().map_or_else(
                || SafeModeState::default().current(),
                |s| SafeMode::new(s.safe_mode(), s.safe_mode_scope()),
            );
            let state = LibraryState::new(device_dir, safe_mode);
            state.detached.set_safe_mode_scope(safe_mode.scope);
            app.manage(state);
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
/// 开始自动标签与工作区监视。在资料库状态登记好（发布闸门取自它）、运行日志打开之后调用一次：
/// 打标子进程的显存额度与标准错误要记进运行日志，打标一开始就要用到它。
pub fn start_background<R: Runtime>(app: &AppHandle<R>) {
    let dirs = crate::data_dirs::app_data(app);
    // 硬件档保存在应用壳设置里；这里只读一次，之后由设置命令同步。
    let preferred = kinshoko_core::AppSettings::open(dirs.settings())
        .ok()
        .and_then(|s| s.tagging_device());
    crate::tagging::setup(app, dirs.models().to_path_buf(), preferred);
    workspace::monitor(app.clone());
}

pub(crate) use names::refresh_search_on_notice;
pub(crate) use workspace::wake_on_notice;

fn saved_mode<R: Runtime>(app: &AppHandle<R>) -> SafeMode {
    app.try_state::<LibraryState>().map_or_else(
        || SafeModeState::default().current(),
        |state| state.safe_mode().current(),
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

#[cfg(test)]
mod tests;
