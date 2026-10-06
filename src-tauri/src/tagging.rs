//! 自动标签的命令层：为当前资料库运行 `kinshoko_core::tagging::Tagging`，打标子进程是本 exe 的
//! `tagger` 子命令（ADR-0004）。状态变化推送为窗口事件 `tagging-status`。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kinshoko_core::Library;
use kinshoko_core::tagging::{LibraryTaggingStatus, ProcessTagger, Tagging, TaggingConfig};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

const EVENT: &str = "tagging-status";

pub struct TaggingState {
    models_dir: PathBuf,
    current: Arc<Mutex<Option<ActiveTagging>>>,
}

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

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 应用启动时登记状态，并开始推送状态变化。
pub fn setup<R: Runtime>(app: &AppHandle<R>, models_dir: PathBuf) {
    let current: Arc<Mutex<Option<ActiveTagging>>> = Arc::default();
    app.manage(TaggingState {
        models_dir,
        current: current.clone(),
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

/// 在资料库切换的阻塞任务里调用；先结束旧库打标并释放句柄，再为新库开始自动标签。
pub fn attach<R: Runtime>(app: &AppHandle<R>, library: Arc<Library>) {
    let state = app.state::<TaggingState>();
    let mut current = lock(&state.current);
    drop(current.take());
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(_) => return,
    };
    let tagger = ProcessTagger::new(exe, vec![kinshoko_tagger::SUBCOMMAND.into()]);
    let config = TaggingConfig::with_catalog(state.models_dir.clone());
    *current = Some(ActiveTagging {
        library_id: library.info().id.clone(),
        tagging: Tagging::start(library, Arc::new(tagger), config),
    });
}

/// 取消登记活动库时等待打标退出，之后整个资料库文件夹可以移动。
pub fn detach<R: Runtime>(app: &AppHandle<R>) {
    drop(lock(&app.state::<TaggingState>().current).take());
}

/// 有新图进库时立即检查。
pub fn wake<R: Runtime>(app: &AppHandle<R>) {
    if let Some(t) = lock(&app.state::<TaggingState>().current).as_ref() {
        t.tagging.wake();
    }
}

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

/// 暂停打标：结束打标子进程，归还显存。
#[tauri::command]
pub async fn tagging_pause(
    state: State<'_, TaggingState>,
    library_id: String,
) -> Result<(), String> {
    with(&state, library_id, |active| active.tagging.pause()).await
}

#[tauri::command]
pub async fn tagging_resume(
    state: State<'_, TaggingState>,
    library_id: String,
) -> Result<(), String> {
    with(&state, library_id, |active| active.tagging.resume()).await
}
