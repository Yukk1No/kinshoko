//! 自动标签的命令层：全设备一个 `kinshoko_core::tagging::Tagging`，覆盖本设备登记的所有资料库
//! （ADR-0008 修订，#414）；打标子进程是本 exe 的 `tagger` 子命令（ADR-0004）。状态变化推送为窗口事件
//! `tagging-status`，是所有资料库的合计。
//!
//! 硬件档、模型目录与暂停属于本设备，不按资料库区分。画师整理某个库时只把它设为优先（[`prefer`]），
//! 不挂上、拆下打标；订阅等后台写入不必通知，调度器空闲时自己去各库找未打标的图。
//! 开始、结束、暂停、出错与子进程的显存额度、标准错误记进运行日志（#219）。

use crate::ui_text::{Text, text};
use kinshoko_core::CommandError;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use kinshoko_core::Library;
use kinshoko_core::diagnostics::{LogEvent, PauseReason};
use kinshoko_core::tagging::{
    Device, ForegroundCheck, HUGGING_FACE, ModelChoice, ModelStore, ProcessTagger, Tagging,
    TaggingConfig, TaggingLibraries, TaggingLog, TaggingStatus, UserNotificationState, catalog,
    yields_to_foreground,
};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt as _;

use crate::shell::ShellState;

const EVENT: &str = "tagging-status";

pub struct TaggingState {
    models_dir: PathBuf,
    /// 拿不到本 exe 的路径、无法启动打标子进程时为空。
    tagging: Option<Arc<Tagging>>,
    /// 画师在设置中选的硬件档；`None` 为自动。
    preferred: Mutex<Option<Device>>,
}

impl TaggingState {
    fn choice(&self) -> ModelChoice {
        ModelStore::new(self.models_dir.clone(), HUGGING_FACE)
            .choice(&catalog(), *lock(&self.preferred))
    }

    fn tagging(&self) -> Result<&Tagging, CommandError> {
        self.tagging
            .as_deref()
            .ok_or_else(|| CommandError::system("auto-tagging is not running"))
    }
}

/// 打标的资料库来源：本设备的登记与可写句柄（`DeviceLibraries`，经资料库模块的入口）。
struct DeviceTaggingLibraries<R: Runtime> {
    app: AppHandle<R>,
    /// 已经设好译名表与闸门的句柄；新打开的句柄第一次交给打标时设一次。
    configured: Mutex<Vec<Weak<Library>>>,
}

impl<R: Runtime> TaggingLibraries for DeviceTaggingLibraries<R> {
    fn library_ids(&self) -> Vec<String> {
        crate::library::registered_library_ids(&self.app)
    }

    fn writer(&self, library_id: &str) -> Result<Arc<Library>, CommandError> {
        crate::library::tagging_writer(&self.app, library_id, |library| {
            let mut configured = lock(&self.configured);
            configured.retain(|handle| handle.strong_count() > 0);
            let weak = Arc::downgrade(library);
            if configured.iter().any(|handle| Weak::ptr_eq(handle, &weak)) {
                return false;
            }
            configured.push(weak);
            true
        })
    }
}

/// 本机已就绪模型的词表 `selected_tags.csv`：优先画师选的硬件档，没有就绪时取任一已就绪的。
/// 迁入向导（#59）用它作外部词表；没有模型时返回 `None`。会读文件，不要在主线程上调用。
pub fn vocabulary_csv<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let state = app.state::<TaggingState>();
    let store = ModelStore::new(state.models_dir.clone(), HUGGING_FACE);
    let preferred = *lock(&state.preferred);
    let models = catalog();
    models
        .iter()
        .filter(|m| preferred == Some(m.device))
        .chain(models.iter())
        .find_map(|m| store.ready(m))
        .map(|m| m.tags_csv)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 应用启动时开始自动标签并推送状态变化。`preferred` 是设置里保存的硬件档。资料库状态
/// （`LibraryState`）要先登记好：发布闸门取自它。
pub fn setup<R: Runtime>(app: &AppHandle<R>, models_dir: PathBuf, preferred: Option<Device>) {
    let tagging = start(app, &models_dir, preferred).map(Arc::new);
    app.manage(TaggingState {
        models_dir,
        tagging: tagging.clone(),
        preferred: Mutex::new(preferred),
    });
    let Some(tagging) = tagging else {
        return;
    };
    let app = app.clone();
    std::thread::Builder::new()
        .name("kinshoko-tagging-status".into())
        .spawn(move || {
            let mut log = TaggingLog::new(None);
            let mut last = None;
            loop {
                let status = tagging.status();
                let library = tagging.tagging_library();
                log.set_library(library.and_then(|id| crate::library::library_no(&app, &id)));
                if let Some(event) = log.observe(&status, Instant::now()) {
                    crate::run_log::record(event);
                }
                if last.as_ref() != Some(&status) {
                    let _ = app.emit(EVENT, &status);
                    last = Some(status);
                }
                std::thread::sleep(Duration::from_millis(300));
            }
        })
        .expect("无法启动打标状态线程");
}

fn start<R: Runtime>(
    app: &AppHandle<R>,
    models_dir: &Path,
    preferred: Option<Device>,
) -> Option<Tagging> {
    let exe = std::env::current_exe().ok()?;
    let mut tagger = ProcessTagger::new(exe, vec![kinshoko_tagger::SUBCOMMAND.into()]);
    if let Some(log) = crate::run_log::log() {
        tagger = tagger.log_to(log.clone());
    }
    let mut config = TaggingConfig::with_catalog(models_dir.to_path_buf());
    config.preferred = preferred;
    config.publication_gate = Some(crate::library::visibility_publication_gate(app));
    config.foreground = Some(ForegroundCheck::new(|| {
        yields_to_foreground(user_notification_state(), foreground_is_ours())
    }));
    let libraries = DeviceTaggingLibraries {
        app: app.clone(),
        configured: Mutex::default(),
    };
    Some(Tagging::start(
        Arc::new(libraries),
        Arc::new(tagger),
        config,
    ))
}

/// 画师在整理这个库（切换了可写句柄）：下一批先打它。
pub fn prefer<R: Runtime>(app: &AppHandle<R>, library_id: &str) {
    if let Some(tagging) = app.state::<TaggingState>().tagging.as_deref() {
        tagging.prefer(library_id);
    }
}

/// 这个库取消了登记：正在打它时中止那一批，等打标放下它的句柄。调用方不能持有发布闸门。
pub fn release<R: Runtime>(app: &AppHandle<R>, library_id: &str) {
    if let Some(tagging) = app.state::<TaggingState>().tagging.as_deref() {
        tagging.release(library_id);
    }
}

/// 系统报告的通知状态（全屏程序、演示模式、忙碌等，#212；报告不了 Windows 设置里的“请勿打扰”开关）；读不到时为 `None`。
#[cfg(windows)]
#[allow(unsafe_code)]
fn user_notification_state() -> Option<UserNotificationState> {
    let mut state = 0;
    // SAFETY：只写入本函数持有的 `state`。
    let hr = unsafe { windows_sys::Win32::UI::Shell::SHQueryUserNotificationState(&mut state) };
    (hr >= 0)
        .then_some(state)
        .and_then(UserNotificationState::from_raw)
}

#[cfg(not(windows))]
fn user_notification_state() -> Option<UserNotificationState> {
    None
}

/// 前台窗口属于本进程（截图框选、钉图菜单等窗口打开时系统也报忙碌，不能因此让出）。
#[cfg(windows)]
fn foreground_is_ours() -> bool {
    crate::desktop::win32::foreground_window().is_some_and(|(_, pid)| pid == std::process::id())
}

#[cfg(not(windows))]
fn foreground_is_ours() -> bool {
    false
}

/// 有新图进库时立即检查。不调用也会被下一轮拉取覆盖，只是晚一点开始。
pub fn wake<R: Runtime>(app: &AppHandle<R>) {
    if let Some(tagging) = app.state::<TaggingState>().tagging.as_deref() {
        tagging.wake();
    }
}

/// 自动标签的当前状态，所有资料库合计。
#[tauri::command]
pub async fn tagging_status(state: State<'_, TaggingState>) -> Result<TaggingStatus, CommandError> {
    Ok(state.tagging()?.status())
}

/// 画师确认后下载模型（可续传）。
#[tauri::command]
pub async fn tagging_download(state: State<'_, TaggingState>) -> Result<(), CommandError> {
    state.tagging()?.download();
    Ok(())
}

/// 取消下载模型（#213）：回到需要下载，已下的部分保留以便下次续传。
#[tauri::command]
pub async fn tagging_cancel_download(state: State<'_, TaggingState>) -> Result<(), CommandError> {
    state.tagging()?.cancel_download();
    Ok(())
}

/// 暂停打标：立即结束打标子进程，归还显存。暂停属于本设备，整理别的库时仍暂停。
#[tauri::command]
pub async fn tagging_pause(state: State<'_, TaggingState>) -> Result<(), CommandError> {
    state.tagging()?.pause();
    crate::run_log::record(LogEvent::TaggingPaused {
        reason: PauseReason::Artist,
    });
    Ok(())
}

#[tauri::command]
pub async fn tagging_resume(state: State<'_, TaggingState>) -> Result<(), CommandError> {
    state.tagging()?.resume();
    crate::run_log::record(LogEvent::TaggingResumed);
    Ok(())
}

/// 设置中的模型一节：打标模型名称、各硬件档的显存或内存需求、大小、是否已下载，以及画师选的档。
#[tauri::command]
pub async fn tagging_models(state: State<'_, TaggingState>) -> Result<ModelChoice, CommandError> {
    Ok(state.choice())
}

/// 换用画师选的硬件档（`null` 为自动）：先保存到设置，再交给正在运行的打标。
#[tauri::command]
pub async fn tagging_set_device(
    state: State<'_, TaggingState>,
    shell: State<'_, ShellState>,
    device: Option<Device>,
) -> Result<ModelChoice, CommandError> {
    shell
        .0
        .lock()
        .map_err(CommandError::system)?
        .settings
        .set_tagging_device(device)
        .map_err(CommandError::from)?;
    apply_device(&state, device);
    Ok(state.choice())
}

/// 选择要导入的模型包（zip）；取消时为 `null`。
#[tauri::command]
pub async fn tagging_pick_package(app: AppHandle) -> Result<Option<PathBuf>, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter(text(Text::FilterModelPackage), &["zip"])
            .blocking_pick_file()
            .and_then(|p| p.into_path().ok())
    })
    .await
    .map_err(CommandError::system)
}

/// 从文件导入模型包并校验（没有网络时）。成功后打标随即用上，不再询问下载。
#[tauri::command]
pub async fn tagging_import_package(
    app: AppHandle,
    path: PathBuf,
) -> Result<ModelChoice, CommandError> {
    let models_dir = app.state::<TaggingState>().models_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        ModelStore::new(models_dir, HUGGING_FACE).import_package(&path, &catalog())
    })
    .await
    .map_err(CommandError::system)??;
    wake(&app);
    Ok(app.state::<TaggingState>().choice())
}

fn apply_device(state: &TaggingState, device: Option<Device>) {
    *lock(&state.preferred) = device;
    if let Some(tagging) = state.tagging.as_deref() {
        tagging.set_device(device);
    }
}
pub fn apply_device_setting<R: Runtime>(app: &AppHandle<R>, device: Option<Device>) {
    apply_device(&app.state::<TaggingState>(), device);
}
