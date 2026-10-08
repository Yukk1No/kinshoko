//! 资料库的命令层（内联插件 `library`）：只做转发、类型转换和事件推送，领域逻辑在
//! `kinshoko_core::library`。前端以 `plugin:library|<命令>` 调用。
//!
//! - 命令都是 async，阻塞工作放进 `spawn_blocking`，不占用主线程；
//! - 本设备可登记多个资料库，同一时间一个活动资料库（#49）。保存命令固定库和目录；来源整理命令带明确来源。浏览命令带界面正在操作的
//!   资料库 id，切换后旧请求得到错误，不会落到新库上；
//! - 资料库事件转发为窗口事件 `library-event`，按来源身份转发；导入回执独立保留任务所属库和目录；
//! - 缩略图走自定义协议 `thumb`：`<资料库 id>/<参考图 id>/<像素档位>`，缓存缺失时现场生成；
//! - 安全模式（#60）：开关保存在应用壳设置里，打开资料库与切换时设给当前资料库。这里的命令都是
//!   浏览视角；参考视角的句柄在装配（打开资料库）时取走，只交给参考组与桌面钉图，不经命令给前端。

mod approx;
mod groups;
mod name_migration;
mod names;
mod portable;
mod save_destination;
mod settings_backup;
pub use portable::{
    export_package as export_reference_package, import_package as import_reference_package,
    publish_definition_dependencies,
};
mod source_actions;
pub use save_destination::{with_destination, with_destination_published};
mod workspace;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use kinshoko_core::approx::{ApproxRelation, BuiltinApproxTable};
use kinshoko_core::diagnostics::UsageEvent;
use kinshoko_core::library::{
    BrowsePage, BrowseQuery, EagleDiscoveryOptions, EagleLibraryCandidate, EagleTagMapping,
    ExternalVocabulary, ImageDetail, ImageEdit, ImageRating, ImageTags, ImportOptions,
    ImportSource, LibraryEvent, LibraryInfo, MappedExternal, PermanentDeletePreview,
    PersonalApproxEntry, RecoveryReport, ReferenceLens, Sidebar, TagAlias, TagEdit, TagGroupView,
    TagNamespace, TagTranslations, Vocabulary, discover_eagle_libraries as discover_eagle,
};
use kinshoko_core::reference_groups::{DetachedLenses, References};
use kinshoko_core::search::{Candidate, ConditionTree, Search, SearchCache, SearchInput};
use kinshoko_core::tag_catalog::{
    CatalogCorrection, CatalogError, CatalogImageTags, TagCatalog, TagCatalogWorkspace,
};
use kinshoko_core::{
    DeviceLibraries, DeviceLibraryError, DeviceRegistry, Library, LibraryRegistration,
};
use tauri::http::{Response, StatusCode, header};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::shell::ShellState;

/// 指定本设备登记表所在目录；不设时用应用数据目录。WebDriver 冒烟测试用它隔离数据。
const DATA_DIR_ENV: &str = "KINSHOKO_DATA_DIR";
const EVENT: &str = "library-event";
/// 安全模式（应用设置）开关后推送，载荷为开关状态。不论有没有打开资料库都推送：
/// 桌面钉图据此重新核对遮蔽（#65）。
pub const SAFE_MODE_EVENT: &str = "safe-mode-setting";

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
            workspace: Mutex::default(),
            reference: Mutex::new(None),
            detached: DetachedLenses::default(),
            builtin_approx: Arc::new(BuiltinApproxTable::bundled()),
            translations: Arc::new(bundled_translations()),
            external_vocabulary: Mutex::new(None),
        }
    }

    /// New tags receive bundled initial names; old display text awaits explicit migration.
    fn install_translations(&self, library: &Library) {
        library.use_translations_for_new_tags((*self.translations).clone());
    }

    /// 界面正在操作的资料库；已切换或关闭时返回错误。
    fn current(&self, library_id: &str) -> Result<Arc<Library>, String> {
        with_libraries(&self.device_dir, &self.libraries, |libraries| {
            libraries.require(library_id)
        })
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
            sidebar,
            create_folder,
            rename_folder,
            move_folder,
            recovery,
            start_import,
            save_destination::import_tasks,
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
            resolve_search,
            set_tag_approx,
            remove_tag_approx,
            personal_approx,
            eagle_tag_mapping,
            map_tag_external,
            external_suggestions,
            image_rating,
            safe_mode,
            set_safe_mode
        ])
        .setup(|app, _api| {
            let device_dir = match std::env::var_os(DATA_DIR_ENV) {
                Some(dir) => PathBuf::from(dir),
                None => app.path().app_data_dir()?,
            };
            kinshoko_core::application_settings_backup::ApplicationSettingsBackup::recover(
                &device_dir,
                &app.path().app_config_dir()?,
            )
            .map_err(std::io::Error::other)?;
            // 打标模型约 1 GB（CPU 档 2 GB），放在本机数据目录，不随漫游配置同步。
            let models_dir = match std::env::var_os(DATA_DIR_ENV) {
                Some(dir) => PathBuf::from(dir).join("models"),
                None => app.path().app_local_data_dir()?.join("models"),
            };
            // 模型选择保存在应用壳设置里；这里只读一次，之后由设置命令同步。
            let preferred = kinshoko_core::AppSettings::open(&app.path().app_config_dir()?)
                .ok()
                .and_then(|s| s.tagging_model().map(str::to_owned));
            crate::tagging::setup(app, models_dir, preferred);
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

fn thumbnail_response<R: Runtime>(app: &AppHandle<R>, path: &str) -> Response<Vec<u8>> {
    let not_found = || {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new())
            .expect("响应合法")
    };
    let mut parts = path.split('/');
    let (Some(library_id), Some(image_id), Some(px), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return not_found();
    };
    // Registered detached provider. The workspace safety veto includes nonmatching/offline sources.
    let state = app.state::<LibraryState>();
    let generation = state.safe_mode_generation.load(Ordering::SeqCst);
    let safe = saved_safe_mode(app);
    let Ok(library) = workspace::read(app, library_id, image_id) else {
        return not_found();
    };
    // `full`：1:1 与放大时显示的文件（Library::display，ADR-0005）。看图界面只用这条路，
    // 不直接读原文件——动图、HDR、Chromium 不能精确表示的 ICC 与 CMYK 要换成 sdr 派生图。
    // `fit-<像素>`：查看器缩小显示（适应窗口等）的精确尺寸派生图（Library::display_scaled，#47）。
    let found = if px == "full" {
        library.display(image_id).map(|d| d.path)
    } else if let Some(fit) = px.strip_prefix("fit-") {
        let Ok(fit) = fit.parse::<u32>() else {
            return not_found();
        };
        library.display_scaled(image_id, fit).map(|d| d.path)
    } else {
        let Ok(px) = px.parse::<u32>() else {
            return not_found();
        };
        library.thumbnail(image_id, px)
    };
    let Ok(path) = found else {
        return not_found();
    };
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return not_found(),
    };
    if state.safe_mode_generation.load(Ordering::SeqCst) != generation
        || saved_safe_mode(app) != safe
        || workspace::read(app, library_id, image_id).is_err()
    {
        return not_found();
    }
    match Ok::<_, std::io::Error>(bytes) {
        Ok(bytes) => Response::builder()
            .header(header::CONTENT_TYPE, image_content_type(&path))
            .body(bytes)
            .expect("响应合法"),
        Err(_) => not_found(),
    }
}

/// 派生图按来源分档存为无损 WebP 或 16 位 PNG（#45）。
pub fn image_content_type(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        _ => "image/webp",
    }
}

/// 核心已完成切换，这里装配新的活动资料库：设上保存的安全模式、取走参考视角、清掉旧库的
/// Search 快照、为它开始打标，并转发它的事件。每个活动句柄只装配一次，旧库事件不再转发。
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
        eprintln!("接入统一标签目录失败：{error}");
    }
    state.install_translations(&library);
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
    handles.push(weak.clone());
    drop(handles);
    let (app, libraries, search) = (app.clone(), state.libraries.clone(), state.search.clone());
    std::thread::Builder::new()
        .name("kinshoko-library-events".into())
        .spawn(move || {
            for event in events {
                let active = lock(&libraries)
                    .as_ref()
                    .and_then(DeviceLibraries::current)
                    .is_some_and(|current| Weak::ptr_eq(&Arc::downgrade(&current), &weak));
                if !active {
                    continue;
                }
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
                let _ = app.emit(EVENT, event);
            }
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

/// 活动资料库；还没有时打开本设备上次打开的资料库并装配。会读文件，不要在主线程上调用。
fn restore<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Arc<Library>>, String> {
    let state = app.state::<LibraryState>();
    let _transition = lock(&state.transition);
    let opened = with_libraries(
        &state.device_dir,
        &state.libraries,
        DeviceLibraries::restore_last_opened,
    )?;
    if let Some(library) = &opened {
        forward_events(app, &state, library.clone());
    }
    Ok(opened)
}

/// 当前资料库，还没打开时打开本设备上次打开的资料库。供其他模块（例如收藏截图）使用；
/// 会读文件，不要在主线程上调用。
pub fn current_or_last<R: Runtime>(app: &AppHandle<R>) -> Result<Arc<Library>, String> {
    restore(app)?.ok_or_else(|| "还没有资料库".to_owned())
}

/// 界面正在操作的资料库（浏览视角）；已切换或关闭时返回错误。
pub fn current<R: Runtime>(app: &AppHandle<R>, library_id: &str) -> Result<Arc<Library>, String> {
    app.state::<LibraryState>().current(library_id)
}

/// Validate the exact visible workspace source before creating a desktop reference.
pub fn visible_source<R: Runtime>(
    app: &AppHandle<R>,
    library_id: &str,
    image_id: &str,
) -> Result<Arc<Library>, String> {
    workspace::read(app, library_id, image_id)
}

/// 本设备上按“资料库＋参考图”取图的地方（参考组与桌面钉图用，#66）：活动资料库经它的参考视角
/// （现取），其他已登记的资料库只读打开，不切换活动库。会读文件，不要在主线程上调用。
pub fn with_references<R: Runtime, T>(
    app: &AppHandle<R>,
    f: impl FnOnce(&References<'_>) -> T,
) -> T {
    let state = app.state::<LibraryState>();
    let registry = lock(&state.libraries)
        .as_ref()
        .map(|libraries| libraries.libraries().to_vec())
        .or_else(|| {
            DeviceRegistry::open(&state.device_dir)
                .ok()
                .map(|device| device.libraries().to_vec())
        })
        .unwrap_or_default();
    let current = lock(&state.reference).clone();
    f(&References {
        current,
        registry: &registry,
        detached: &state.detached,
        safe_mode: saved_safe_mode(app),
    })
}

/// 本设备的数据目录：资料库登记表、参考组与备份计划都在这里（`KINSHOKO_DATA_DIR` 覆盖）。
pub fn data_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.state::<LibraryState>().device_dir.clone()
}

/// 本设备登记的资料库（备份范围用，#69）。在切换锁里读：不会读到切换进行到一半的登记表。
pub fn registered<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<kinshoko_core::RegisteredLibrary>, String> {
    let state = app.state::<LibraryState>();
    let _transition = lock(&state.transition);
    with_libraries(&state.device_dir, &state.libraries, |libraries| {
        Ok(libraries.libraries().to_vec())
    })
}

/// 把恢复出的资料库登记到本设备，不切换过去（#69）。
pub fn register_restored<R: Runtime>(app: &AppHandle<R>, roots: &[PathBuf]) -> Result<(), String> {
    let state = app.state::<LibraryState>();
    let _transition = lock(&state.transition);
    with_libraries(&state.device_dir, &state.libraries, |libraries| {
        for root in roots {
            libraries.add_registration(root)?;
        }
        Ok(())
    })?;
    state.detached.clear();
    Ok(())
}

/// 安全模式是否开启（全局设置）；读不到设置时按开启处理。
pub fn safe_mode_on<R: Runtime>(app: &AppHandle<R>) -> bool {
    saved_safe_mode(app)
}

/// 当前资料库；启动后第一次调用时打开本设备上次打开的资料库。
#[tauri::command]
async fn current_library<R: Runtime>(app: AppHandle<R>) -> Result<Option<LibraryInfo>, String> {
    blocking(move || Ok(restore(&app)?.map(|library| library.info().clone()))).await
}

/// 在 `parent` 下新建名为 `name` 的资料库文件夹，登记到本设备并切换过去。
#[tauri::command]
async fn create_library<R: Runtime>(
    app: AppHandle<R>,
    parent: PathBuf,
    name: String,
) -> Result<LibraryInfo, String> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        let _transition = lock(&state.transition);
        let library = with_libraries(&state.device_dir, &state.libraries, |libraries| {
            libraries.create(&parent.join(name.trim()), &name)
        })?;
        Ok(forward_events(&app, &state, library))
    })
    .await
}

/// 本设备登记的资料库，以及这次检查时不可用的原因（例如移动盘没插）。
#[tauri::command]
async fn registered_libraries(
    state: State<'_, LibraryState>,
) -> Result<Vec<LibraryRegistration>, String> {
    let (device_dir, libraries) = (state.device_dir.clone(), state.libraries.clone());
    blocking(move || {
        let registered = with_libraries(&device_dir, &libraries, |libraries| {
            Ok(libraries.libraries().to_vec())
        })?;
        Ok(DeviceLibraries::inspect_registrations(&registered))
    })
    .await
}

/// 登记所选文件夹里的资料库并切换过去；搬家后重新登记同一资料库时只更新位置。
#[tauri::command]
async fn register_library<R: Runtime>(
    app: AppHandle<R>,
    root: PathBuf,
) -> Result<LibraryInfo, String> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        let _transition = lock(&state.transition);
        let library = with_libraries(&state.device_dir, &state.libraries, |libraries| {
            libraries.register(&root)
        })?;
        Ok(forward_events(&app, &state, library))
    })
    .await
}

/// 切换到已登记的资料库。旧库的导入在提交当前一项后结束，打标停止。
#[tauri::command]
async fn switch_library<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
) -> Result<LibraryInfo, String> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        let _transition = lock(&state.transition);
        let library = with_libraries(&state.device_dir, &state.libraries, |libraries| {
            libraries.switch(&library_id)
        })?;
        Ok(forward_events(&app, &state, library))
    })
    .await
}

/// 取消本设备的登记；资料库文件夹与整理结果原样保留。取消的是活动库时一并关闭它。
#[tauri::command]
async fn unregister_library<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
) -> Result<(), String> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        let _transition = lock(&state.transition);
        let closed = with_libraries(&state.device_dir, &state.libraries, |libraries| {
            let closed = libraries
                .current()
                .is_some_and(|library| library.info().id == library_id);
            libraries.unregister(&library_id)?;
            Ok(closed)
        })?;
        if closed {
            *lock(&state.forwarded) = None;
            state.search.invalidate();
            *lock(&state.reference) = None;
            crate::tagging::detach(&app);
        }
        state.detached.clear();
        Ok(())
    })
    .await
}

#[tauri::command]
async fn browse(
    state: State<'_, LibraryState>,
    library_id: String,
    query: BrowseQuery,
) -> Result<BrowsePage, String> {
    let library = state.current(&library_id)?;
    blocking(move || library.browse(&query).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn image(
    state: State<'_, LibraryState>,
    library_id: String,
    image_id: String,
) -> Result<ImageDetail, String> {
    let library = state.current(&library_id)?;
    blocking(move || library.image(&image_id).map_err(|e| e.to_string())).await
}

/// 一次批量整理若干张图，返回重新计算后的详情。
#[tauri::command]
async fn edit(
    state: State<'_, LibraryState>,
    library_id: String,
    ids: Vec<String>,
    edits: Vec<ImageEdit>,
) -> Result<Vec<ImageDetail>, String> {
    let library = state.current(&library_id)?;
    blocking(move || library.edit(&ids, &edits).map_err(|e| e.to_string())).await
}

/// 永久删除的预览（#67）：回收站里这些图会影响哪些参考组，以及执行时要交回的令牌。
/// 参考组读不懂时报错，不当作没用到。
#[tauri::command]
async fn preview_permanent_delete<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    ids: Vec<String>,
) -> Result<PermanentDeletePreview, String> {
    let library = current(&app, &library_id)?;
    blocking(move || {
        crate::desktop::with_groups(&app, |groups| {
            library.preview_permanent_delete(&ids, groups)
        })
        .ok_or_else(|| "参考组还没有准备好".to_owned())?
        .map_err(|e| e.to_string())
    })
    .await
}

/// 按预览的令牌永久删除回收站里的图。预览之后回收站、参考组或安全模式变了时被拒绝，
/// 界面重新预览。整个执行在参考组的锁里，期间参考组不会被改。
#[tauri::command]
async fn permanent_delete<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    ids: Vec<String>,
    token: String,
) -> Result<(), String> {
    let library = current(&app, &library_id)?;
    blocking(move || {
        crate::desktop::with_groups(&app, |groups| {
            library.permanent_delete(&ids, &token, groups)
        })
        .ok_or_else(|| "参考组还没有准备好".to_owned())?
        .map_err(|e| e.to_string())?;
        crate::desktop::reference_groups_changed(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn sidebar(state: State<'_, LibraryState>, library_id: String) -> Result<Sidebar, String> {
    let library = state.current(&library_id)?;
    blocking(move || library.sidebar().map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn create_folder(
    state: State<'_, LibraryState>,
    library_id: String,
    name: String,
    parent: Option<String>,
) -> Result<String, String> {
    let library = state.current(&library_id)?;
    blocking(move || {
        library
            .create_folder(&name, parent.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn rename_folder(
    state: State<'_, LibraryState>,
    library_id: String,
    folder_id: String,
    name: String,
) -> Result<(), String> {
    let library = state.current(&library_id)?;
    blocking(move || {
        library
            .rename_folder(&folder_id, &name)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn move_folder(
    state: State<'_, LibraryState>,
    library_id: String,
    folder_id: String,
    parent: Option<String>,
    position: u32,
) -> Result<(), String> {
    let library = state.current(&library_id)?;
    blocking(move || {
        library
            .move_folder(&folder_id, parent.as_deref(), position)
            .map_err(|e| e.to_string())
    })
    .await
}

/// 当前资料库这次打开时的对账结果。
#[tauri::command]
async fn recovery(
    state: State<'_, LibraryState>,
    library_id: String,
) -> Result<RecoveryReport, String> {
    with_libraries(&state.device_dir, &state.libraries, |device| {
        Ok(device.write(&library_id)?.recovery().clone())
    })
}

/// 开始导入，立即返回任务 id；进度与结果经 `library-event` 推送。
#[tauri::command]
async fn start_import<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    source: ImportSource,
    options: Option<ImportOptions>,
    destination: Option<kinshoko_core::library::SaveDestination>,
) -> Result<String, String> {
    let paths = source.paths.len().min(u32::MAX as usize) as u32;
    let destination = destination.unwrap_or(kinshoko_core::library::SaveDestination {
        library_id: library_id.clone(),
        folder_id: None,
    });
    if destination.library_id != library_id {
        return Err("保存目标资料库与任务归属不一致".into());
    }
    let worker = app.clone();
    let id = blocking(move || {
        save_destination::begin(&worker, destination, source, options.unwrap_or_default())
    })
    .await?;
    crate::diagnostics::record(&app, UsageEvent::ImportStarted { paths });
    Ok(id)
}

/// 来源预检只读取文件夹，所有入口在开始 Eagle 任务前使用同一个选择步骤。
#[tauri::command]
async fn import_contains_eagle(source: ImportSource) -> Result<bool, String> {
    blocking(move || Ok(source.contains_eagle())).await
}

#[tauri::command]
async fn cancel_import(
    state: State<'_, LibraryState>,
    library_id: String,
    task_id: String,
) -> Result<(), String> {
    let (device_dir, libraries) = (state.device_dir.clone(), state.libraries.clone());
    blocking(move || {
        with_libraries(&device_dir, &libraries, |libraries| {
            libraries.cancel_import(&library_id, &task_id)
        })
    })
    .await
}

#[tauri::command]
async fn pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<Option<PathBuf>, String> {
    blocking(move || {
        Ok(app
            .dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok()))
    })
    .await
}

#[tauri::command]
async fn pick_files<R: Runtime>(app: AppHandle<R>) -> Result<Vec<PathBuf>, String> {
    blocking(move || {
        Ok(app
            .dialog()
            .file()
            .add_filter("图片", &["jpg", "jpeg", "png", "webp", "gif"])
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .collect())
    })
    .await
}

/// 查找本机 Eagle 资料库；文件读取与磁盘扫描放在阻塞任务里。
#[tauri::command]
async fn discover_eagle_libraries() -> Result<Vec<EagleLibraryCandidate>, String> {
    blocking(|| Ok(discover_eagle(&EagleDiscoveryOptions::default()))).await
}

/// 画师确认导入报告里疑似搬家的 Eagle 位置；确认后前端再导入这个位置。
#[tauri::command]
async fn confirm_eagle_location<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    path: PathBuf,
    choice: kinshoko_core::library::EagleLocationChoice,
) -> Result<(), String> {
    let library = save_destination::fixed_library(
        &app,
        &kinshoko_core::library::SaveDestination {
            library_id,
            folder_id: None,
        },
    )?;
    blocking(move || {
        library
            .confirm_eagle_location(&path, choice)
            .map_err(|e| e.to_string())
    })
    .await
}

/// 一张参考图的标签，名称按界面语言 `lang`。
#[tauri::command]
async fn image_tags(
    state: State<'_, LibraryState>,
    library_id: String,
    image_id: String,
    lang: String,
) -> Result<ImageTags, String> {
    let library = state.current(&library_id)?;
    let (dir, catalog) = (state.device_dir.clone(), state.catalog.clone());
    blocking(move || {
        with_catalog(&dir, &catalog, |catalog| {
            Ok(catalog.image_tags(&library, &image_id, &lang)?.image)
        })
    })
    .await
}

#[tauri::command]
async fn catalog_image_tags(
    state: State<'_, LibraryState>,
    library_id: String,
    image_id: String,
    lang: String,
) -> Result<CatalogImageTags, String> {
    let library = state.current(&library_id)?;
    let (dir, catalog) = (state.device_dir.clone(), state.catalog.clone());
    blocking(move || {
        with_catalog(&dir, &catalog, |catalog| {
            catalog.image_tags(&library, &image_id, &lang)
        })
    })
    .await
}

#[tauri::command]
async fn inspect_tag_catalog<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
) -> Result<TagCatalogWorkspace, String> {
    let (dir, libraries, catalog) = (
        state.device_dir.clone(),
        state.libraries.clone(),
        state.catalog.clone(),
    );
    let generation = state.safe_mode_generation.load(Ordering::SeqCst);
    let safe = saved_safe_mode(&app);
    let result = blocking(move || {
        with_libraries(&dir, &libraries, |libraries| {
            Ok(with_catalog(&dir, &catalog, |catalog| {
                catalog.inspect_libraries(libraries, safe)
            }))
        })?
    })
    .await?;
    if state.safe_mode_generation.load(Ordering::SeqCst) != generation
        || saved_safe_mode(&app) != safe
    {
        return Err("安全模式已变化，请重新检查标签对应".into());
    }
    Ok(result)
}

#[tauri::command]
async fn correct_tag_mapping<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
    local_tag_id: String,
    correction: CatalogCorrection,
) -> Result<TagCatalogWorkspace, String> {
    let (dir, libraries, catalog) = (
        state.device_dir.clone(),
        state.libraries.clone(),
        state.catalog.clone(),
    );
    let generation = state.safe_mode_generation.load(Ordering::SeqCst);
    let safe = saved_safe_mode(&app);
    let publish_library_id = library_id.clone();
    let result = blocking(move || {
        with_libraries(&dir, &libraries, |libraries| {
            let library = libraries.read(&library_id)?;
            library.set_safe_mode(safe);
            Ok(with_catalog(&dir, &catalog, |catalog| {
                catalog.correct(&library, &local_tag_id, correction)?;
                catalog.inspect_libraries(libraries, safe)
            }))
        })?
    })
    .await?;
    let publish_app = app.clone();
    let publication =
        blocking(move || publish_definition_dependencies(&publish_app, &publish_library_id)).await;
    state.search.invalidate();
    // Compatibility event refreshes current candidates, conditions and selected image labels.
    if let Ok(active) = state.active() {
        let _ = app.emit(
            EVENT,
            LibraryEvent::VocabularyChanged {
                library_id: active.info().id.clone(),
                revision: active.vocabulary_revision().map_err(|e| e.to_string())?,
            },
        );
    }
    if state.safe_mode_generation.load(Ordering::SeqCst) != generation
        || saved_safe_mode(&app) != safe
    {
        return Err("安全模式已变化，请重新检查标签对应".into());
    }
    publication.map_err(|error| format!("标签对应已保存在程序中，但资料库定义尚未更新：{error}。请在统一标签目录中重试保存标签定义。"))?;
    Ok(result)
}

/// 对若干参考图批量添加、否决或清除标签决定。
#[tauri::command]
async fn edit_tags<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
    image_ids: Vec<String>,
    edits: Vec<TagEdit>,
) -> Result<(), String> {
    let library = state.current(&library_id)?;
    blocking(move || {
        library.edit_tags(&image_ids, &edits).map_err(|e| e.to_string())?;
        publish_definition_dependencies(&app, &library_id).map_err(|error| format!("标签整理已保存，但资料库定义尚未更新：{error}。请在统一标签目录中重试保存标签定义。"))
    })
    .await
}

#[tauri::command]
async fn vocabulary(
    state: State<'_, LibraryState>,
    library_id: String,
) -> Result<Vocabulary, String> {
    let library = state.current(&library_id)?;
    let (dir, catalog) = (state.device_dir.clone(), state.catalog.clone());
    blocking(move || {
        with_catalog(&dir, &catalog, |catalog| {
            catalog.search_vocabulary(&library)
        })
    })
    .await
}

/// 侧栏的标签分组及计数，名称按界面语言 `lang`。
#[tauri::command]
async fn tag_groups(
    state: State<'_, LibraryState>,
    library_id: String,
    lang: String,
) -> Result<Vec<TagGroupView>, String> {
    let library = state.current(&library_id)?;
    let (dir, catalog) = (state.device_dir.clone(), state.catalog.clone());
    blocking(move || {
        with_catalog(&dir, &catalog, |catalog| {
            catalog.tag_groups(&library, &lang)
        })
    })
    .await
}

/// 给标签加一个别名；之后按这个叫法能查到、能添加这个标签。
#[tauri::command]
async fn add_tag_alias<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
    tag_id: String,
    alias: TagAlias,
) -> Result<(), String> {
    names::edit_local_alias(
        app,
        &state,
        library_id,
        tag_id,
        names::LocalAliasEdit::Add(alias),
    )
    .await
}

#[tauri::command]
async fn remove_tag_alias<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
    tag_id: String,
    alias: String,
) -> Result<(), String> {
    names::edit_local_alias(
        app,
        &state,
        library_id,
        tag_id,
        names::LocalAliasEdit::Remove(alias),
    )
    .await
}

/// 建立标签分组，返回分组 id；给出 `namespace` 时分组是该命名空间的全部标签。
#[tauri::command]
async fn create_tag_group(
    state: State<'_, LibraryState>,
    library_id: String,
    name: String,
    namespace: Option<TagNamespace>,
) -> Result<String, String> {
    let library = state.current(&library_id)?;
    blocking(move || {
        library
            .create_tag_group(&name, namespace)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn rename_tag_group(
    state: State<'_, LibraryState>,
    library_id: String,
    group_id: String,
    name: String,
) -> Result<(), String> {
    let library = state.current(&library_id)?;
    blocking(move || {
        library
            .rename_tag_group(&group_id, &name)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn delete_tag_group(
    state: State<'_, LibraryState>,
    library_id: String,
    group_id: String,
) -> Result<(), String> {
    let library = state.current(&library_id)?;
    blocking(move || {
        library
            .delete_tag_group(&group_id)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn add_to_tag_group(
    state: State<'_, LibraryState>,
    library_id: String,
    group_id: String,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    let library = state.current(&library_id)?;
    blocking(move || {
        library
            .add_to_tag_group(&group_id, &tag_ids)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn remove_from_tag_group(
    state: State<'_, LibraryState>,
    library_id: String,
    group_id: String,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    let library = state.current(&library_id)?;
    blocking(move || {
        library
            .remove_from_tag_group(&group_id, &tag_ids)
            .map_err(|e| e.to_string())
    })
    .await
}

/// 搜索框打字时的候选：按命名空间与别名列出，名称按界面语言 `lang`。`safe_mode` 是界面
/// 当前的视角；资料库的安全模式不同（刚切换）时返回错误，候选不会落到另一视角上（#76）。
#[tauri::command]
async fn search_candidates(
    state: State<'_, LibraryState>,
    library_id: String,
    text: String,
    lang: String,
    limit: u32,
    safe_mode: bool,
) -> Result<Vec<Candidate>, String> {
    let library = state.current(&library_id)?;
    let (cache, builtin) = (state.search.clone(), state.builtin_approx.clone());
    let (dir, catalog, revision) = (
        state.device_dir.clone(),
        state.catalog.clone(),
        state.search_catalog_revision.clone(),
    );
    blocking(move || {
        let search = catalog_search(
            &dir, &catalog, &revision, &cache, &library, &builtin, safe_mode,
        )?;
        Ok(search.candidates(&text, &lang, limit as usize))
    })
    .await
}

/// 把搜索框里的条件解析成可见的条件树，交给 `browse` 执行。`safe_mode` 同
/// [`search_candidates`]。
#[tauri::command]
async fn resolve_search<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
    input: SearchInput,
    lang: String,
    safe_mode: bool,
) -> Result<ConditionTree, String> {
    let library = state.current(&library_id)?;
    let (cache, builtin) = (state.search.clone(), state.builtin_approx.clone());
    let (dir, catalog, revision) = (
        state.device_dir.clone(),
        state.catalog.clone(),
        state.search_catalog_revision.clone(),
    );
    crate::diagnostics::record(
        &app,
        UsageEvent::SearchResolved {
            terms: input.conditions.len().min(u32::MAX as usize) as u32,
        },
    );
    blocking(move || {
        let search = catalog_search(
            &dir, &catalog, &revision, &cache, &library, &builtin, safe_mode,
        )?;
        Ok(search.resolve(&input, &lang))
    })
    .await
}

/// 安全模式是否开启（全局设置）。
#[tauri::command]
async fn safe_mode<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    Ok(saved_safe_mode(&app))
}

/// 开关安全模式：先保存设置，再设给活动资料库；资料库推送 `safeModeChanged`。
/// 安全模式属于本设备，不随资料库变；之后切换到的资料库按保存的设置打开。
#[tauri::command]
async fn set_safe_mode<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    on: bool,
) -> Result<bool, String> {
    state.safe_mode_generation.fetch_add(1, Ordering::SeqCst);
    if let Some(shell) = app.try_state::<ShellState>() {
        let mut shell = shell.0.lock().map_err(|e| e.to_string())?;
        shell
            .settings
            .set_safe_mode(on)
            .map_err(|e| e.to_string())?;
    }
    if let Ok(library) = state.active() {
        library.set_safe_mode(on);
    }
    let _ = app.emit(SAFE_MODE_EVENT, on);
    Ok(on)
}

/// 在个人近似对应表中记下两个标签相近或不相近（“＋”与“以后都不展开”）。
#[tauri::command]
async fn set_tag_approx(
    state: State<'_, LibraryState>,
    library_id: String,
    a: String,
    b: String,
    relation: ApproxRelation,
) -> Result<(), String> {
    let library = state.current(&library_id)?;
    blocking(move || {
        library
            .set_tag_approx(&a, &b, relation)
            .map_err(|e| e.to_string())
    })
    .await
}

/// 删除个人近似对应表中的一对。
#[tauri::command]
async fn remove_tag_approx(
    state: State<'_, LibraryState>,
    library_id: String,
    a: String,
    b: String,
) -> Result<(), String> {
    let library = state.current(&library_id)?;
    blocking(move || library.remove_tag_approx(&a, &b).map_err(|e| e.to_string())).await
}

/// 资料库设置中列出的个人近似对应表条目，名称按界面语言 `lang`。
#[tauri::command]
async fn personal_approx(
    state: State<'_, LibraryState>,
    library_id: String,
    lang: String,
) -> Result<Vec<PersonalApproxEntry>, String> {
    let library = state.current(&library_id)?;
    let (dir, catalog) = (state.device_dir.clone(), state.catalog.clone());
    blocking(move || {
        with_catalog(&dir, &catalog, |catalog| {
            let snapshot = catalog.synchronize(&library)?;
            let mut entries = library.personal_approx(&lang)?;
            for entry in &mut entries {
                entry.a = snapshot.display_label(&library.info().id, &entry.a, &lang);
                entry.b = snapshot.display_label(&library.info().id, &entry.b, &lang);
            }
            Ok(entries)
        })
    })
    .await
}

/// 随软件分发的翻译表（`data/builtin-translation-table.json`），启动时取一次。唯一的注入点：
/// 每个打开的资料库在装配时（[`forward_events`]）装上它，迁入向导的外部词表也按它匹配。
fn bundled_translations() -> TagTranslations {
    TagTranslations::bundled()
}

/// 迁入向导的外部词表：内置近似对应表中的名称、本机已就绪模型的词表与翻译表。
/// 会读文件，不要在主线程上调用。
fn external_vocabulary<R: Runtime>(app: &AppHandle<R>) -> Result<ExternalVocabulary, String> {
    let state = app.state::<LibraryState>();
    let csv = crate::tagging::vocabulary_csv(app);
    let mut cached = lock(&state.external_vocabulary);
    if let Some((path, vocabulary)) = cached.as_ref()
        && *path == csv
    {
        return Ok(vocabulary.clone());
    }
    let mut names = ExternalVocabulary::builtin_names(&state.builtin_approx);
    if let Some(path) = &csv {
        names.extend(ExternalVocabulary::read_tags_csv(path)?);
    }
    let vocabulary = ExternalVocabulary::new(names, &state.translations);
    *cached = Some((csv, vocabulary.clone()));
    Ok(vocabulary)
}

/// 迁入向导“标签的外部对应”：自动匹配还没有外部对应的 Eagle 标签，返回对上与没对上的。
#[tauri::command]
async fn eagle_tag_mapping<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    lang: String,
) -> Result<EagleTagMapping, String> {
    let library = save_destination::fixed_library(
        &app,
        &kinshoko_core::library::SaveDestination {
            library_id,
            folder_id: None,
        },
    )?;
    blocking(move || {
        let vocabulary = external_vocabulary(&app)?;
        let mapping = library
            .map_eagle_tags(&vocabulary, &lang)
            .map_err(|e| e.to_string())?;
        save_destination::publish_saved(&app, &library)?;
        Ok(mapping)
    })
    .await
}

/// 迁入向导：画师给一个标签补上外部对应。
#[tauri::command]
async fn map_tag_external<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    tag_id: String,
    external: String,
) -> Result<MappedExternal, String> {
    let library = save_destination::fixed_library(
        &app,
        &kinshoko_core::library::SaveDestination {
            library_id,
            folder_id: None,
        },
    )?;
    blocking(move || {
        let vocabulary = external_vocabulary(&app)?;
        let mapping = library
            .map_tag_external(&tag_id, &external, &vocabulary)
            .map_err(|e| e.to_string())?;
        save_destination::publish_saved(&app, &library)?;
        Ok(mapping)
    })
    .await
}

/// 补外部对应时的联想。外部词表属于本设备，不带资料库身份。
#[tauri::command]
async fn external_suggestions<R: Runtime>(
    app: AppHandle<R>,
    text: String,
    limit: u32,
) -> Result<Vec<String>, String> {
    blocking(move || Ok(external_vocabulary(&app)?.suggest(&text, limit as usize))).await
}

/// 一张参考图的内容分级（自动与有效）。
#[tauri::command]
async fn image_rating(
    state: State<'_, LibraryState>,
    library_id: String,
    image_id: String,
) -> Result<ImageRating, String> {
    let library = state.current(&library_id)?;
    blocking(move || library.image_rating(&image_id).map_err(|e| e.to_string())).await
}

#[cfg(test)]
mod tests {
    //! 应用壳的翻译表装配（#76 Core3、#77 C1）：走生产代码同一条路径——[`LibraryState::new`]
    //! 取 [`bundled_translations`]，[`forward_events`] 调 [`LibraryState::install_translations`]。
    //! 不启动 Tauri；资料库是临时目录里的真库。

    use kinshoko_core::library::{FactSource, ImportOutcome, SourceTag, TagNamespace, TagRef};
    use kinshoko_core::search::Search;

    use super::*;

    fn library_with_image(dir: &Path, name: &str) -> (Library, String) {
        let library = Library::create(&dir.join(name), name).unwrap();
        let path = dir.join(format!("{name}.png"));
        image::RgbaImage::from_pixel(4, 4, image::Rgba([1, 2, 3, 255]))
            .save(&path)
            .unwrap();
        let report = library.import(ImportSource { paths: vec![path] }).wait();
        let ImportOutcome::Imported { image_id } = &report.items[0].outcome else {
            panic!("未导入：{:?}", report.items[0].outcome);
        };
        let id = image_id.clone();
        (library, id)
    }

    fn tag_blue_eyes(library: &Library, image_id: &str) {
        library
            .replace_source_tags(
                &FactSource::model("pixai-v1.0"),
                image_id,
                &[SourceTag {
                    tag: TagRef::External {
                        namespace: TagNamespace::General,
                        name: "blue_eyes".into(),
                    },
                    score: Some(0.9),
                }],
            )
            .unwrap();
    }

    fn names(library: &Library, image_id: &str) -> Vec<(String, bool)> {
        library
            .image_tags(image_id, "zh-CN")
            .unwrap()
            .tags
            .into_iter()
            .map(|t| (t.tag.name, t.tag.untranslated))
            .collect()
    }

    fn state() -> (tempfile::TempDir, LibraryState) {
        let dir = tempfile::tempdir().unwrap();
        let state = LibraryState::new(dir.path().join("device"));
        (dir, state)
    }

    #[test]
    fn the_injection_point_hands_out_the_shipped_table() {
        let (_dir, state) = state();
        assert_eq!(*state.translations, TagTranslations::bundled());
        assert!(
            state
                .translations
                .entries
                .iter()
                .any(|e| e.external == "blue_eyes" && e.names["zh-CN"] == "蓝瞳")
        );
    }

    #[test]
    fn a_library_assembled_by_the_app_names_model_tags_and_finds_them_by_chinese_names() {
        let (dir, state) = state();
        let (library, image) = library_with_image(dir.path(), "new");
        state.install_translations(&library);
        tag_blue_eyes(&library, &image);

        assert_eq!(names(&library, &image), [("蓝瞳".to_owned(), false)]);
        let search = Search::new(&library.vocabulary().unwrap(), &state.builtin_approx);
        for text in ["蓝瞳", "蓝眼睛"] {
            let found = search.candidates(text, "zh-CN", 5);
            assert_eq!(found.len(), 1, "{text}");
            assert_eq!(found[0].tag.name, "蓝瞳");
        }
    }

    #[test]
    fn opening_a_legacy_library_preserves_untranslated_display_until_explicit_migration() {
        let (dir, state) = state();
        let (library, image) = library_with_image(dir.path(), "old");
        tag_blue_eyes(&library, &image);
        assert_eq!(names(&library, &image), [("blue eyes".to_owned(), true)]);

        state.install_translations(&library);
        assert_eq!(names(&library, &image), [("blue eyes".to_owned(), true)]);
    }

    #[test]
    fn the_eagle_wizard_matches_chinese_tag_names_with_the_same_table() {
        let (_dir, state) = state();
        let vocabulary = ExternalVocabulary::new(Vec::new(), &state.translations);
        assert_eq!(vocabulary.by_translation("蓝瞳"), ["blue_eyes"]);
    }
}
