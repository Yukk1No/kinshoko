//! 运行日志（#219）的应用壳一侧：按系统时区计时、把日志放在数据根目录的 `logs/`，
//! 记下 panic，并给其他模块一个不必带 `AppHandle` 的入口。能写什么见
//! `kinshoko_core::diagnostics::LogEvent`；日志不上传，由画师在设置里导出。

use std::fmt::Display;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use kinshoko_core::AppSettings;
use kinshoko_core::diagnostics::{Clock, Detail, Level, LogEvent, Moment, RunLog, WindowKind};
use tauri::{AppHandle, State};

use crate::shell::ShellState;

static LOG: OnceLock<RunLog> = OnceLock::new();

struct LocalClock;

impl Clock for LocalClock {
    fn now(&self) -> Moment {
        let now = chrono::Local::now();
        Moment {
            unix_ms: now.timestamp_millis(),
            utc_offset_secs: now.offset().local_minus_utc(),
        }
    }
}

/// 按设置打开运行日志并记下 panic。在建任何窗口之前调用一次。
pub fn start(app: &AppHandle, settings: &AppSettings) {
    let dir = crate::data_dirs::app_data(app).logs();
    let log = RunLog::open(dir, settings.run_log(), Arc::new(LocalClock));
    if LOG.set(log).is_err() {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        // 只留源文件名（不带扩展名，免得被当成文件名脱敏掉）与行号。
        let place = info.location().map(|l| {
            let file = std::path::Path::new(l.file())
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            format!("（{file} 第 {} 行）", l.line())
        });
        record(LogEvent::Problem {
            level: Level::Error,
            site: "程序出错（panic）",
            detail: Detail::new(format!("{message}{}", place.unwrap_or_default())),
        });
        previous(info);
    }));
    record(LogEvent::AppStarted {
        version: env!("CARGO_PKG_VERSION"),
    });
}

/// 本次运行的运行日志；还没打开时为空。
pub fn log() -> Option<&'static RunLog> {
    LOG.get()
}

/// 记一条；日志关闭时什么也不做。可以在任何线程上调用。
pub fn record(event: LogEvent) {
    if let Some(log) = LOG.get() {
        log.record(event);
    }
}

/// 记一个错误。开发构建同时在控制台输出。
pub fn error(site: &'static str, detail: impl Display) {
    problem(Level::Error, site, detail);
}

/// 记一个警告。开发构建同时在控制台输出。
pub fn warn(site: &'static str, detail: impl Display) {
    problem(Level::Warn, site, detail);
}

fn problem(level: Level, site: &'static str, detail: impl Display) {
    let detail = detail.to_string();
    eprintln!("{site}：{detail}");
    record(LogEvent::Problem {
        level,
        site,
        detail: Detail::new(detail),
    });
}

/// 从 `started` 起到现在的毫秒数。
pub fn ms_since(started: Instant) -> u32 {
    started.elapsed().as_millis().min(u32::MAX as u128) as u32
}

/// 记下建好了一个窗口。
pub fn window_created(window: WindowKind, started: Instant) {
    record(LogEvent::WindowCreated {
        window,
        ms: ms_since(started),
    });
}

/// 开关运行日志，立即生效。关闭后已记录的内容保留，由画师决定导出或清除。
#[tauri::command]
pub async fn set_run_log(
    state: State<'_, ShellState>,
    on: bool,
) -> Result<kinshoko_core::ShellSettingsView, String> {
    let mut shell = state.0.lock().map_err(|e| e.to_string())?;
    shell.settings.set_run_log(on).map_err(|e| e.to_string())?;
    if let Some(log) = log() {
        log.set_enabled(on);
    }
    Ok(shell.view())
}

/// 删掉已记录的运行日志。
#[tauri::command]
pub async fn clear_run_log() -> Result<(), String> {
    match log() {
        Some(log) => log.clear().map_err(|e| format!("清除运行日志失败：{e}")),
        None => Ok(()),
    }
}

/// 界面里没有接住的错误。文字在写入前脱敏；条数由界面限制（`src/runLog.ts`）。
#[tauri::command]
pub fn log_frontend(level: Level, message: String) {
    record(LogEvent::Frontend {
        level,
        detail: Detail::new(message),
    });
}
