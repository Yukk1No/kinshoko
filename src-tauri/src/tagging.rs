//! 自动标签的命令层：为当前资料库运行 `kinshoko_core::tagging::Tagging`，打标子进程是本 exe 的
//! `tagger` 子命令（ADR-0004）。状态变化推送为窗口事件 `tagging-status`。
//!
//! 模型选择与模型目录属于本设备，不随资料库变：换资料库时沿用画师选的模型与暂停状态。
//! 状态与命令都带资料库身份（#49），切换后旧库的迟到状态与旧请求不会落到新库上。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kinshoko_core::Library;
use kinshoko_core::tagging::{
    HUGGING_FACE, LibraryTaggingStatus, ModelChoice, ModelStore, ProcessTagger, Tagging,
    TaggingConfig, catalog,
};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt as _;

use crate::shell::ShellState;

const EVENT: &str = "tagging-status";

pub struct TaggingState {
    models_dir: PathBuf,
    current: Arc<Mutex<Option<ActiveTagging>>>,
    /// 画师在设置中选的模型；`None` 为自动。
    preferred: Mutex<Option<String>>,
    /// 画师暂停了打标；换资料库后仍暂停。
    paused: AtomicBool,
}

impl TaggingState {
    fn choice(&self) -> ModelChoice {
        ModelChoice {
            selected: lock(&self.preferred).clone(),
            options: ModelStore::new(self.models_dir.clone(), HUGGING_FACE).options(&catalog()),
        }
    }
}

/// 活动资料库的打标，带上它属于哪个资料库。
struct ActiveTagging {
    library_id: String,
    tagging: Tagging,
}

impl ActiveTagging {
    fn status(&self) -> LibraryTaggingStatus {
        LibraryTaggingStatus {
            library_id: self.library_id.clone(),
            status: self.tagging.status(),
        }
    }
}

/// 本机已就绪模型的词表 `selected_tags.csv`：优先画师选的模型，没有就绪时取任一已就绪的。
/// 迁入向导（#59）用它作外部词表；没有模型时返回 `None`。会读文件，不要在主线程上调用。
pub fn vocabulary_csv<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let state = app.state::<TaggingState>();
    let store = ModelStore::new(state.models_dir.clone(), HUGGING_FACE);
    let preferred = lock(&state.preferred).clone();
    let models = catalog();
    models
        .iter()
        .filter(|m| preferred.as_deref() == Some(m.key.as_str()))
        .chain(models.iter())
        .find_map(|m| store.ready(m))
        .map(|m| m.tags_csv)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 应用启动时登记状态，并开始推送状态变化。`preferred` 是设置里保存的模型选择。
pub fn setup<R: Runtime>(app: &AppHandle<R>, models_dir: PathBuf, preferred: Option<String>) {
    let current: Arc<Mutex<Option<ActiveTagging>>> = Arc::default();
    app.manage(TaggingState {
        models_dir,
        current: current.clone(),
        preferred: Mutex::new(preferred),
        paused: AtomicBool::new(false),
    });
    let app = app.clone();
    std::thread::Builder::new()
        .name("kinshoko-tagging-status".into())
        .spawn(move || {
            let mut last = None;
            loop {
                let status = lock(&current).as_ref().map(ActiveTagging::status);
                if status != last {
                    if let Some(status) = &status {
                        let _ = app.emit(EVENT, status);
                    }
                    last = status;
                }
                std::thread::sleep(Duration::from_millis(300));
            }
        })
        .expect("无法启动打标状态线程");
}

/// 在资料库切换的阻塞任务里调用：先结束旧库打标（立即结束子进程）并释放它持有的资料库，
/// 再为新库开始自动标签。画师的暂停与模型选择沿用到新库。
pub fn attach<R: Runtime>(app: &AppHandle<R>, library: Arc<Library>) {
    detach(app);
    let state = app.state::<TaggingState>();
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(_) => return,
    };
    let tagger = ProcessTagger::new(exe, vec![kinshoko_tagger::SUBCOMMAND.into()]);
    let mut config = TaggingConfig::with_catalog(state.models_dir.clone());
    config.preferred = lock(&state.preferred).clone();
    let library_id = library.info().id.clone();
    let tagging = Tagging::start(library, Arc::new(tagger), config);
    if state.paused.load(Ordering::SeqCst) {
        tagging.pause();
    }
    *lock(&state.current) = Some(ActiveTagging {
        library_id,
        tagging,
    });
}

/// 结束活动库的打标并等它退出；之后整个资料库文件夹可以移动。在阻塞任务里调用。
pub fn detach<R: Runtime>(app: &AppHandle<R>) {
    let old = lock(&app.state::<TaggingState>().current).take();
    drop(old);
}

/// 有新图进库时立即检查。
pub fn wake<R: Runtime>(app: &AppHandle<R>) {
    if let Some(t) = lock(&app.state::<TaggingState>().current).as_ref() {
        t.tagging.wake();
    }
}

/// 只对界面正在操作的资料库执行；资料库已切换时返回错误，不碰新库。
async fn with<T: Send + 'static>(
    state: &TaggingState,
    library_id: String,
    f: impl FnOnce(&ActiveTagging) -> T + Send + 'static,
) -> Result<T, String> {
    let current = state.current.clone();
    tauri::async_runtime::spawn_blocking(move || {
        lock(&current)
            .as_ref()
            .filter(|active| active.library_id == library_id)
            .map(f)
            .ok_or_else(|| "资料库已切换或关闭，请在当前资料库重新操作".to_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 自动标签的当前状态。
#[tauri::command]
pub async fn tagging_status(
    state: State<'_, TaggingState>,
    library_id: String,
) -> Result<LibraryTaggingStatus, String> {
    with(&state, library_id, ActiveTagging::status).await
}

/// 画师确认后下载模型（可续传）。
#[tauri::command]
pub async fn tagging_download(
    state: State<'_, TaggingState>,
    library_id: String,
) -> Result<(), String> {
    with(&state, library_id, |active| active.tagging.download()).await
}

/// 暂停打标：立即结束打标子进程，归还显存。暂停属于本设备，换资料库后仍暂停。
#[tauri::command]
pub async fn tagging_pause(
    state: State<'_, TaggingState>,
    library_id: String,
) -> Result<(), String> {
    with(&state, library_id, |active| active.tagging.pause()).await?;
    state.paused.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn tagging_resume(
    state: State<'_, TaggingState>,
    library_id: String,
) -> Result<(), String> {
    with(&state, library_id, |active| active.tagging.resume()).await?;
    state.paused.store(false, Ordering::SeqCst);
    Ok(())
}

/// 设置中的模型列表：每个模型的显存或内存需求、大小、是否已装好，以及画师选的模型。
#[tauri::command]
pub async fn tagging_models(state: State<'_, TaggingState>) -> Result<ModelChoice, String> {
    Ok(state.choice())
}

/// 换用画师选的模型（`null` 为自动）：先保存到设置，再交给正在运行的打标。
#[tauri::command]
pub async fn tagging_set_model(
    state: State<'_, TaggingState>,
    shell: State<'_, ShellState>,
    key: Option<String>,
) -> Result<ModelChoice, String> {
    if let Some(key) = &key
        && !catalog().iter().any(|m| &m.key == key)
    {
        return Err("没有这个模型".into());
    }
    shell
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .settings
        .set_tagging_model(key.as_deref())
        .map_err(|e| e.to_string())?;
    *lock(&state.preferred) = key.clone();
    if let Some(t) = lock(&state.current).as_ref() {
        t.tagging.set_model(key);
    }
    Ok(state.choice())
}

/// 选择要导入的模型包（zip）；取消时为 `null`。
#[tauri::command]
pub async fn tagging_pick_package(app: AppHandle) -> Result<Option<PathBuf>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("模型包", &["zip"])
            .blocking_pick_file()
            .and_then(|p| p.into_path().ok())
    })
    .await
    .map_err(|e| e.to_string())
}

/// 从文件导入模型包并校验（没有网络时）。成功后打标随即用上，不再询问下载。
#[tauri::command]
pub async fn tagging_import_package(app: AppHandle, path: PathBuf) -> Result<ModelChoice, String> {
    let models_dir = app.state::<TaggingState>().models_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        ModelStore::new(models_dir, HUGGING_FACE).import_package(&path, &catalog())
    })
    .await
    .map_err(|e| e.to_string())??;
    let state = app.state::<TaggingState>();
    if let Some(t) = lock(&state.current).as_ref() {
        t.tagging.wake();
    }
    Ok(state.choice())
}
