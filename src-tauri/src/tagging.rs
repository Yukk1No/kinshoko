//! 自动标签的命令层：为当前资料库运行 `kinshoko_core::tagging::Tagging`，打标子进程是本 exe 的
//! `tagger` 子命令（ADR-0004）。状态变化推送为窗口事件 `tagging-status`。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kinshoko_core::Library;
use kinshoko_core::tagging::{ProcessTagger, Tagging, TaggingConfig, TaggingStatus};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

const EVENT: &str = "tagging-status";

pub struct TaggingState {
    models_dir: PathBuf,
    current: Arc<Mutex<Option<Tagging>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 应用启动时登记状态，并开始推送状态变化。
pub fn setup<R: Runtime>(app: &AppHandle<R>, models_dir: PathBuf) {
    let current: Arc<Mutex<Option<Tagging>>> = Arc::default();
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
    let config = TaggingConfig::with_catalog(state.models_dir.clone());
    let old = lock(&state.current).replace(Tagging::start(library, Arc::new(tagger), config));
    // 停下旧的要等它手上那张图（最多一张的时间），放到后台，不挡住打开资料库。
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

/// 暂停打标：结束打标子进程，归还显存。
#[tauri::command]
pub fn tagging_pause(state: State<'_, TaggingState>) -> Result<(), String> {
    with(&state, Tagging::pause)
}

#[tauri::command]
pub fn tagging_resume(state: State<'_, TaggingState>) -> Result<(), String> {
    with(&state, Tagging::resume)
}
