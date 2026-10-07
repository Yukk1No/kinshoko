//! 资料库的命令层（内联插件 `library`）：只做转发、类型转换和事件推送，领域逻辑在
//! `kinshoko_core::library`。前端以 `plugin:library|<命令>` 调用。
//!
//! - 命令都是 async，阻塞工作放进 `spawn_blocking`，不占用主线程；
//! - 本设备可登记多个资料库，同一时间一个活动资料库（#49）。资料库命令都带界面正在操作的
//!   资料库 id，切换后旧请求得到错误，不会落到新库上；
//! - 资料库事件转发为窗口事件 `library-event`，只转发活动资料库的事件；
//! - 缩略图走自定义协议 `thumb`：`<资料库 id>/<参考图 id>/<像素档位>`，缓存缺失时现场生成；
//! - 安全模式（#60）：开关保存在应用壳设置里，打开资料库与切换时设给当前资料库。这里的命令都是
//!   浏览视角；参考视角的句柄在装配（打开资料库）时取走，只交给参考组与桌面钉图，不经命令给前端。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use kinshoko_core::approx::{ApproxRelation, BuiltinApproxTable};
use kinshoko_core::diagnostics::UsageEvent;
use kinshoko_core::library::{
    BrowsePage, BrowseQuery, EagleDiscoveryOptions, EagleLibraryCandidate, ImageDetail, ImageEdit,
    ImageRating, ImageTags, ImportSource, LibraryEvent, LibraryInfo, PersonalApproxEntry,
    RecoveryReport, ReferenceLens, Sidebar, TagEdit, TagGroupView, Vocabulary,
    discover_eagle_libraries as discover_eagle,
};
use kinshoko_core::search::{Candidate, ConditionTree, SearchCache, SearchInput};
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

struct LibraryState {
    device_dir: PathBuf,
    /// 本设备登记表与活动资料库；第一次用到时读取登记表。
    libraries: Arc<Mutex<Option<DeviceLibraries>>>,
    /// 已在转发事件的活动资料库句柄；同一句柄只装配一次。
    forwarded: Mutex<Option<Weak<Library>>>,
    /// 切换、恢复和取消登记串行完成，包括旧库打标退出。
    transition: Mutex<()>,
    /// 活动资料库词表快照上的 Search，按（资料库，词表修订号，安全模式）校验；词表或图片
    /// 变化、安全模式切换、切换资料库时清掉，下次查找时重建（#76）。
    search: Arc<SearchCache>,
    /// 活动资料库参考视角的句柄，装配时取走（每个打开的资料库一次）。只交给参考组（#66）
    /// 与桌面钉图（#65），不经任何命令交给前端。
    reference: Mutex<Option<ReferenceLens>>,
    /// 随软件分发的内置近似对应表，启动时读取一次。
    builtin_approx: Arc<BuiltinApproxTable>,
}

impl LibraryState {
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

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("library")
        .invoke_handler(tauri::generate_handler![
            current_library,
            create_library,
            registered_libraries,
            register_library,
            switch_library,
            unregister_library,
            browse,
            image,
            edit,
            sidebar,
            create_folder,
            rename_folder,
            move_folder,
            recovery,
            start_import,
            cancel_import,
            pick_folder,
            pick_files,
            discover_eagle_libraries,
            image_tags,
            edit_tags,
            vocabulary,
            tag_groups,
            search_candidates,
            resolve_search,
            set_tag_approx,
            remove_tag_approx,
            personal_approx,
            image_rating,
            safe_mode,
            set_safe_mode
        ])
        .setup(|app, _api| {
            let device_dir = match std::env::var_os(DATA_DIR_ENV) {
                Some(dir) => PathBuf::from(dir),
                None => app.path().app_data_dir()?,
            };
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
            app.manage(LibraryState {
                device_dir,
                libraries: Arc::default(),
                forwarded: Mutex::new(None),
                transition: Mutex::new(()),
                search: Arc::default(),
                reference: Mutex::new(None),
                builtin_approx: Arc::new(BuiltinApproxTable::bundled()),
            });
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
    // 只回答活动资料库的图；切换后旧图片墙的迟到请求得到 404。
    let Ok(library) = app.state::<LibraryState>().active() else {
        return not_found();
    };
    if library.info().id != library_id {
        return not_found();
    }
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
    match std::fs::read(&path) {
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
    let events = library.events();
    *lock(&state.reference) = library.take_reference_lens();
    state.search.invalidate();
    crate::tagging::attach(app, library);
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

/// [`current_or_last`] 会用到的资料库的 id 与名称，只读登记表、不打开资料库。
pub fn current_name<R: Runtime>(app: &AppHandle<R>) -> Option<(String, String)> {
    let state = app.state::<LibraryState>();
    if let Ok(library) = state.active() {
        let info = library.info();
        return Some((info.id.clone(), info.name.clone()));
    }
    let device = DeviceRegistry::open(&state.device_dir).ok()?;
    device
        .last_opened()
        .map(|entry| (entry.id.clone(), entry.name.clone()))
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
        with_libraries(&device_dir, &libraries, |libraries| {
            Ok(libraries.registrations())
        })
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
    Ok(state.current(&library_id)?.recovery().clone())
}

/// 开始导入，立即返回任务 id；进度与结果经 `library-event` 推送。
#[tauri::command]
async fn start_import<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
    source: ImportSource,
) -> Result<String, String> {
    let paths = source.paths.len().min(u32::MAX as usize) as u32;
    let (device_dir, libraries) = (state.device_dir.clone(), state.libraries.clone());
    let id = blocking(move || {
        with_libraries(&device_dir, &libraries, |libraries| {
            libraries.start_import(&library_id, source)
        })
    })
    .await?;
    crate::diagnostics::record(&app, UsageEvent::ImportStarted { paths });
    Ok(id)
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

/// 一张参考图的标签，名称按界面语言 `lang`。
#[tauri::command]
async fn image_tags(
    state: State<'_, LibraryState>,
    library_id: String,
    image_id: String,
    lang: String,
) -> Result<ImageTags, String> {
    let library = state.current(&library_id)?;
    blocking(move || {
        library
            .image_tags(&image_id, &lang)
            .map_err(|e| e.to_string())
    })
    .await
}

/// 对若干参考图批量添加、否决或清除标签决定。
#[tauri::command]
async fn edit_tags(
    state: State<'_, LibraryState>,
    library_id: String,
    image_ids: Vec<String>,
    edits: Vec<TagEdit>,
) -> Result<(), String> {
    let library = state.current(&library_id)?;
    blocking(move || {
        library
            .edit_tags(&image_ids, &edits)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn vocabulary(
    state: State<'_, LibraryState>,
    library_id: String,
) -> Result<Vocabulary, String> {
    let library = state.current(&library_id)?;
    blocking(move || library.vocabulary().map_err(|e| e.to_string())).await
}

/// 侧栏的标签分组及计数，名称按界面语言 `lang`。
#[tauri::command]
async fn tag_groups(
    state: State<'_, LibraryState>,
    library_id: String,
    lang: String,
) -> Result<Vec<TagGroupView>, String> {
    let library = state.current(&library_id)?;
    blocking(move || library.tag_groups(&lang).map_err(|e| e.to_string())).await
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
    blocking(move || {
        let search = cache
            .search(&library, &builtin, safe_mode)
            .map_err(|e| e.to_string())?;
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
    crate::diagnostics::record(
        &app,
        UsageEvent::SearchResolved {
            terms: input.conditions.len().min(u32::MAX as usize) as u32,
        },
    );
    blocking(move || {
        let search = cache
            .search(&library, &builtin, safe_mode)
            .map_err(|e| e.to_string())?;
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
    blocking(move || library.personal_approx(&lang).map_err(|e| e.to_string())).await
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
