//! 资料库的命令层（内联插件 `library`）：只做转发、类型转换和事件推送，领域逻辑在
//! `kinshoko_core::library`。前端以 `plugin:library|<命令>` 调用。
//!
//! - 命令都是 async，阻塞工作放进 `spawn_blocking`，不占用主线程；
//! - 资料库事件转发为窗口事件 `library-event`；
//! - 缩略图走自定义协议 `thumb`：`<资料库 id>/<参考图 id>/<像素档位>`，缓存缺失时现场生成。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use kinshoko_core::library::{
    BrowsePage, BrowseQuery, ImageTags, ImportSource, ImportTask, LibraryEvent, LibraryInfo,
    RecoveryReport, TagEdit, TagGroupView, Vocabulary,
};
use kinshoko_core::{DeviceRegistry, Library};
use tauri::http::{Response, StatusCode, header};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

/// 指定本设备登记表所在目录；不设时用应用数据目录。WebDriver 冒烟测试用它隔离数据。
const DATA_DIR_ENV: &str = "KINSHOKO_DATA_DIR";
const EVENT: &str = "library-event";

struct LibraryState {
    device_dir: PathBuf,
    current: Mutex<Option<Arc<Library>>>,
    tasks: Arc<Mutex<HashMap<String, ImportTask>>>,
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
            recovery,
            start_import,
            cancel_import,
            pick_folder,
            pick_files,
            image_tags,
            edit_tags,
            vocabulary,
            tag_groups
        ])
        .setup(|app, _api| {
            app.plugin(tauri_plugin_dialog::init())?;
            let device_dir = match std::env::var_os(DATA_DIR_ENV) {
                Some(dir) => PathBuf::from(dir),
                None => app.path().app_data_dir()?,
            };
            app.manage(LibraryState {
                device_dir,
                current: Mutex::new(None),
                tasks: Arc::default(),
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
    let Ok(px) = px.parse::<u32>() else {
        return not_found();
    };
    let Ok(library) = app.state::<LibraryState>().current() else {
        return not_found();
    };
    if library.info().id != library_id {
        return not_found();
    }
    match library
        .thumbnail(image_id, px)
        .map_err(|e| e.to_string())
        .and_then(|p| std::fs::read(p).map_err(|e| e.to_string()))
    {
        Ok(bytes) => Response::builder()
            .header(header::CONTENT_TYPE, "image/webp")
            .body(bytes)
            .expect("响应合法"),
        Err(_) => not_found(),
    }
}

/// 设为当前资料库，并把它的事件转发给前端。
fn activate<R: Runtime>(app: &AppHandle<R>, state: &LibraryState, library: Library) -> LibraryInfo {
    let info = library.info().clone();
    let events = library.events();
    *lock(&state.current) = Some(Arc::new(library));
    let (app, tasks) = (app.clone(), state.tasks.clone());
    std::thread::Builder::new()
        .name("kinshoko-library-events".into())
        .spawn(move || {
            for event in events {
                if let LibraryEvent::TaskFinished { task_id, .. } = &event {
                    lock(&tasks).remove(task_id);
                }
                let _ = app.emit(EVENT, event);
            }
        })
        .expect("无法启动事件转发线程");
    info
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
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
    let opened = blocking(move || {
        let device = DeviceRegistry::open(&device_dir).map_err(|e| e.to_string())?;
        match device.last_opened() {
            None => Ok(None),
            Some(entry) => Library::open(&entry.root)
                .map(Some)
                .map_err(|e| e.to_string()),
        }
    })
    .await?;
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

/// 当前资料库这次打开时的对账结果。
#[tauri::command]
fn recovery(state: State<'_, LibraryState>) -> Result<RecoveryReport, String> {
    Ok(state.current()?.recovery().clone())
}

/// 开始导入，立即返回任务 id；进度与结果经 `library-event` 推送。
#[tauri::command]
async fn start_import(
    state: State<'_, LibraryState>,
    source: ImportSource,
) -> Result<String, String> {
    let library = state.current()?;
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
            .add_filter("图片", &["jpg", "jpeg", "png", "webp"])
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
