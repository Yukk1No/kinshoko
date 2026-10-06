//! 自动标签的命令层：为当前资料库运行 `kinshoko_core::tagging::Tagging`，打标子进程是本 exe 的
//! `tagger` 子命令（ADR-0004）。状态变化推送为窗口事件 `tagging-status`。
//!
//! 模型选择与模型目录属于本设备，不随资料库变：换资料库时沿用画师选的模型与暂停状态。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kinshoko_core::Library;
use kinshoko_core::tagging::{
    HUGGING_FACE, ModelChoice, ModelStore, ProcessTagger, Tagging, TaggingConfig, TaggingStatus,
    catalog,
};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt as _;

use crate::shell::ShellState;

const EVENT: &str = "tagging-status";

pub struct TaggingState {
    models_dir: PathBuf,
    current: Arc<Mutex<Option<Tagging>>>,
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

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 应用启动时登记状态，并开始推送状态变化。`preferred` 是设置里保存的模型选择。
pub fn setup<R: Runtime>(app: &AppHandle<R>, models_dir: PathBuf, preferred: Option<String>) {
    let current: Arc<Mutex<Option<Tagging>>> = Arc::default();
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
                let status = lock(&current).as_ref().map(Tagging::status);
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

/// 为新打开的资料库开始自动标签；旧资料库的打标随之停止（结束子进程）。
pub fn attach<R: Runtime>(app: &AppHandle<R>, library: Arc<Library>) {
    let state = app.state::<TaggingState>();
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(_) => return,
    };
    let tagger = ProcessTagger::new(exe, vec![kinshoko_tagger::SUBCOMMAND.into()]);
    let mut config = TaggingConfig::with_catalog(state.models_dir.clone());
    config.preferred = lock(&state.preferred).clone();
    let tagging = Tagging::start(library, Arc::new(tagger), config);
    if state.paused.load(Ordering::SeqCst) {
        tagging.pause();
    }
    let old = lock(&state.current).replace(tagging);
    // 停下旧的会立即结束子进程，但仍放到后台，不挡住打开资料库。
    if let Some(old) = old {
        std::thread::spawn(move || drop(old));
    }
}

/// 有新图进库时立即检查。
pub fn wake<R: Runtime>(app: &AppHandle<R>) {
    if let Some(t) = lock(&app.state::<TaggingState>().current).as_ref() {
        t.wake();
    }
}

fn with<T>(state: &TaggingState, f: impl FnOnce(&Tagging) -> T) -> Result<T, String> {
    lock(&state.current)
        .as_ref()
        .map(f)
        .ok_or_else(|| "还没有打开资料库".to_owned())
}

/// 自动标签的当前状态。
#[tauri::command]
pub fn tagging_status(state: State<'_, TaggingState>) -> Result<TaggingStatus, String> {
    with(&state, Tagging::status)
}

/// 画师确认后下载模型（可续传）。
#[tauri::command]
pub fn tagging_download(state: State<'_, TaggingState>) -> Result<(), String> {
    with(&state, Tagging::download)
}

/// 暂停打标：立即结束打标子进程，归还显存。
#[tauri::command]
pub fn tagging_pause(state: State<'_, TaggingState>) -> Result<(), String> {
    state.paused.store(true, Ordering::SeqCst);
    with(&state, Tagging::pause)
}

#[tauri::command]
pub fn tagging_resume(state: State<'_, TaggingState>) -> Result<(), String> {
    state.paused.store(false, Ordering::SeqCst);
    with(&state, Tagging::resume)
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
        t.set_model(key);
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
        t.wake();
    }
    Ok(state.choice())
}
