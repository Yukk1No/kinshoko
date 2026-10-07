//! 资料库的命令层（内联插件 `library`）：只做转发、类型转换和事件推送，领域逻辑在
//! `kinshoko_core::library`。前端以 `plugin:library|<命令>` 调用。
//!
//! - 命令都是 async，阻塞工作放进 `spawn_blocking`，不占用主线程；
//! - 资料库事件转发为窗口事件 `library-event`；
//! - 缩略图走自定义协议 `thumb`：`<资料库 id>/<参考图 id>/<像素档位>`，缓存缺失时现场生成；
//! - 安全模式（#60）：开关保存在应用壳设置里，打开资料库与切换时设给当前资料库。这里的命令都是
//!   浏览视角；参考视角的句柄在装配（打开资料库）时取走，只交给参考组与桌面钉图，不经命令给前端。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use kinshoko_core::approx::{ApproxRelation, BuiltinApproxTable};
use kinshoko_core::diagnostics::UsageEvent;
use kinshoko_core::library::{
    BrowsePage, BrowseQuery, ImageDetail, ImageEdit, ImageRating, ImageTags, ImportSource,
    ImportTask, LibraryEvent, LibraryInfo, PersonalApproxEntry, RecoveryReport, ReferenceLens,
    Sidebar, TagEdit, TagGroupView, Vocabulary,
};
use kinshoko_core::search::{Candidate, ConditionTree, Search, SearchInput};
use kinshoko_core::{DeviceRegistry, Library};
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
    current: Mutex<Option<Arc<Library>>>,
    tasks: Arc<Mutex<HashMap<String, ImportTask>>>,
    /// 当前资料库词表快照上的 Search；词表或图片变化时清掉，下次查找时重建。
    search: Arc<Mutex<Option<Arc<Search>>>>,
    /// 当前资料库参考视角的句柄，装配时取走。只交给参考组（#66）与桌面钉图（#65），
    /// 不经任何命令交给前端。
    reference: Mutex<Option<ReferenceLens>>,
    /// 随软件分发的内置近似对应表，启动时读取一次。
    builtin_approx: BuiltinApproxTable,
}

impl LibraryState {
    fn current(&self) -> Result<Arc<Library>, String> {
        lock(&self.current)
            .clone()
            .ok_or_else(|| "还没有打开资料库".to_owned())
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("library")
        .invoke_handler(tauri::generate_handler![
            current_library,
            create_library,
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
                current: Mutex::new(None),
                tasks: Arc::default(),
                search: Arc::default(),
                reference: Mutex::new(None),
                builtin_approx: BuiltinApproxTable::bundled(),
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
    let Ok(library) = app.state::<LibraryState>().current() else {
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

/// 设为当前资料库，并把它的事件转发给前端。
fn activate<R: Runtime>(app: &AppHandle<R>, state: &LibraryState, library: Library) -> LibraryInfo {
    let info = library.info().clone();
    library.set_safe_mode(saved_safe_mode(app));
    let events = library.events();
    *lock(&state.reference) = library.take_reference_lens();
    let library = Arc::new(library);
    *lock(&state.current) = Some(library.clone());
    *lock(&state.search) = None;
    crate::tagging::attach(app, library);
    let (app, tasks, search) = (app.clone(), state.tasks.clone(), state.search.clone());
    std::thread::Builder::new()
        .name("kinshoko-library-events".into())
        .spawn(move || {
            for event in events {
                match &event {
                    LibraryEvent::TaskFinished { task_id, .. } => {
                        lock(&tasks).remove(task_id);
                    }
                    // 有新图进库：自动标签立即检查，不等下一次轮询。
                    LibraryEvent::ListStale { .. } => crate::tagging::wake(&app),
                    _ => {}
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
                    lock(&search).take();
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

/// 本设备上次打开的资料库；没有时为 `None`。会读文件，不要在主线程上调用。
fn open_last(device_dir: &std::path::Path) -> Result<Option<Library>, String> {
    let device = DeviceRegistry::open(device_dir).map_err(|e| e.to_string())?;
    match device.last_opened() {
        None => Ok(None),
        Some(entry) => Library::open(&entry.root)
            .map(Some)
            .map_err(|e| e.to_string()),
    }
}

/// 当前资料库，还没打开时打开本设备上次打开的资料库。供其他模块（例如收藏截图）使用；
/// 会读文件，不要在主线程上调用。
pub fn current_or_last<R: Runtime>(app: &AppHandle<R>) -> Result<Arc<Library>, String> {
    let state = app.state::<LibraryState>();
    if let Ok(library) = state.current() {
        return Ok(library);
    }
    let library = open_last(&state.device_dir)?.ok_or_else(|| "还没有资料库".to_owned())?;
    activate(app, &state, library);
    state.current()
}

/// [`current_or_last`] 会用到的资料库的 id 与名称，只读登记表、不打开资料库。
pub fn current_name<R: Runtime>(app: &AppHandle<R>) -> Option<(String, String)> {
    let state = app.state::<LibraryState>();
    if let Ok(library) = state.current() {
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
async fn current_library<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
) -> Result<Option<LibraryInfo>, String> {
    if let Ok(library) = state.current() {
        return Ok(Some(library.info().clone()));
    }
    let device_dir = state.device_dir.clone();
    let opened = blocking(move || open_last(&device_dir)).await?;
    Ok(opened.map(|library| activate(&app, &state, library)))
}

/// 在 `parent` 下新建名为 `name` 的资料库文件夹，登记到本设备并打开。
#[tauri::command]
async fn create_library<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    parent: PathBuf,
    name: String,
) -> Result<LibraryInfo, String> {
    let device_dir = state.device_dir.clone();
    let library = blocking(move || {
        let library =
            Library::create(&parent.join(name.trim()), &name).map_err(|e| e.to_string())?;
        DeviceRegistry::open(&device_dir)
            .and_then(|mut device| device.register(library.info()))
            .map_err(|e| e.to_string())?;
        Ok(library)
    })
    .await?;
    Ok(activate(&app, &state, library))
}

#[tauri::command]
async fn browse(state: State<'_, LibraryState>, query: BrowseQuery) -> Result<BrowsePage, String> {
    let library = state.current()?;
    blocking(move || library.browse(&query).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn image(state: State<'_, LibraryState>, image_id: String) -> Result<ImageDetail, String> {
    let library = state.current()?;
    blocking(move || library.image(&image_id).map_err(|e| e.to_string())).await
}

/// 一次批量整理若干张图，返回重新计算后的详情。
#[tauri::command]
async fn edit(
    state: State<'_, LibraryState>,
    ids: Vec<String>,
    edits: Vec<ImageEdit>,
) -> Result<Vec<ImageDetail>, String> {
    let library = state.current()?;
    blocking(move || library.edit(&ids, &edits).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn sidebar(state: State<'_, LibraryState>) -> Result<Sidebar, String> {
    let library = state.current()?;
    blocking(move || library.sidebar().map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn create_folder(
    state: State<'_, LibraryState>,
    name: String,
    parent: Option<String>,
) -> Result<String, String> {
    let library = state.current()?;
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
    folder_id: String,
    name: String,
) -> Result<(), String> {
    let library = state.current()?;
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
    folder_id: String,
    parent: Option<String>,
    position: u32,
) -> Result<(), String> {
    let library = state.current()?;
    blocking(move || {
        library
            .move_folder(&folder_id, parent.as_deref(), position)
            .map_err(|e| e.to_string())
    })
    .await
}

/// 当前资料库这次打开时的对账结果。
#[tauri::command]
fn recovery(state: State<'_, LibraryState>) -> Result<RecoveryReport, String> {
    Ok(state.current()?.recovery().clone())
}

/// 开始导入，立即返回任务 id；进度与结果经 `library-event` 推送。
#[tauri::command]
async fn start_import<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    source: ImportSource,
) -> Result<String, String> {
    let library = state.current()?;
    crate::diagnostics::record(
        &app,
        UsageEvent::ImportStarted {
            paths: source.paths.len().min(u32::MAX as usize) as u32,
        },
    );
    let task = library.import(source);
    let id = task.id().to_owned();
    if !task.is_finished() {
        lock(&state.tasks).insert(id.clone(), task);
    }
    Ok(id)
}

#[tauri::command]
async fn cancel_import(state: State<'_, LibraryState>, task_id: String) -> Result<(), String> {
    if let Some(task) = lock(&state.tasks).get(&task_id) {
        task.cancel();
    }
    Ok(())
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

/// 一张参考图的标签，名称按界面语言 `lang`。
#[tauri::command]
async fn image_tags(
    state: State<'_, LibraryState>,
    image_id: String,
    lang: String,
) -> Result<ImageTags, String> {
    let library = state.current()?;
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
    image_ids: Vec<String>,
    edits: Vec<TagEdit>,
) -> Result<(), String> {
    let library = state.current()?;
    blocking(move || {
        library
            .edit_tags(&image_ids, &edits)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn vocabulary(state: State<'_, LibraryState>) -> Result<Vocabulary, String> {
    let library = state.current()?;
    blocking(move || library.vocabulary().map_err(|e| e.to_string())).await
}

/// 侧栏的标签分组及计数，名称按界面语言 `lang`。
#[tauri::command]
async fn tag_groups(
    state: State<'_, LibraryState>,
    lang: String,
) -> Result<Vec<TagGroupView>, String> {
    let library = state.current()?;
    blocking(move || library.tag_groups(&lang).map_err(|e| e.to_string())).await
}

/// 当前资料库的 Search，按需从词表快照建立。
fn search(state: &LibraryState, library: &Library) -> Result<Arc<Search>, String> {
    if let Some(search) = lock(&state.search).clone() {
        return Ok(search);
    }
    let search = Arc::new(Search::new(
        &library.vocabulary().map_err(|e| e.to_string())?,
        &state.builtin_approx,
    ));
    *lock(&state.search) = Some(search.clone());
    Ok(search)
}

/// 搜索框打字时的候选：按命名空间与别名列出，名称按界面语言 `lang`。
#[tauri::command]
async fn search_candidates(
    state: State<'_, LibraryState>,
    text: String,
    lang: String,
    limit: u32,
) -> Result<Vec<Candidate>, String> {
    let library = state.current()?;
    let state = state.inner();
    let search = search(state, &library)?;
    Ok(search.candidates(&text, &lang, limit as usize))
}

/// 把搜索框里的条件解析成可见的条件树，交给 `browse` 执行。
#[tauri::command]
async fn resolve_search<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    input: SearchInput,
    lang: String,
) -> Result<ConditionTree, String> {
    let library = state.current()?;
    let search = search(state.inner(), &library)?;
    crate::diagnostics::record(
        &app,
        UsageEvent::SearchResolved {
            terms: input.conditions.len().min(u32::MAX as usize) as u32,
        },
    );
    Ok(search.resolve(&input, &lang))
}

/// 安全模式是否开启（全局设置）。
#[tauri::command]
async fn safe_mode<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    Ok(saved_safe_mode(&app))
}

/// 开关安全模式：先保存设置，再设给当前资料库；资料库推送 `safeModeChanged`。
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
    if let Ok(library) = state.current() {
        library.set_safe_mode(on);
    }
    Ok(on)
}

/// 在个人近似对应表中记下两个标签相近或不相近（“＋”与“以后都不展开”）。
#[tauri::command]
async fn set_tag_approx(
    state: State<'_, LibraryState>,
    a: String,
    b: String,
    relation: ApproxRelation,
) -> Result<(), String> {
    let library = state.current()?;
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
    a: String,
    b: String,
) -> Result<(), String> {
    let library = state.current()?;
    blocking(move || library.remove_tag_approx(&a, &b).map_err(|e| e.to_string())).await
}

/// 资料库设置中列出的个人近似对应表条目，名称按界面语言 `lang`。
#[tauri::command]
async fn personal_approx(
    state: State<'_, LibraryState>,
    lang: String,
) -> Result<Vec<PersonalApproxEntry>, String> {
    let library = state.current()?;
    blocking(move || library.personal_approx(&lang).map_err(|e| e.to_string())).await
}

/// 一张参考图的内容分级（自动与有效）。
#[tauri::command]
async fn image_rating(
    state: State<'_, LibraryState>,
    image_id: String,
) -> Result<ImageRating, String> {
    let library = state.current()?;
    blocking(move || library.image_rating(&image_id).map_err(|e| e.to_string())).await
}
