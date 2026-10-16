//! 诊断（#70）：“强制 sRGB”的 WebView2 启动参数、诊断日志与使用日志。
//!
//! 规则与脱敏在 `kinshoko_core::diagnostics`；这里只向 Windows 查询系统信息、接保存对话框。
//! 使用日志放在本机数据目录的 `logs/`，不上传。

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use kinshoko_core::AppSettings;
use kinshoko_core::diagnostics::{
    AppFacts, DisplayColourMode, DisplayFacts, SystemFacts, UsageEvent, UsageLog, report,
    webview_browser_args,
};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt as _;

use crate::shell::ShellState;

/// 与资料库插件相同：设置时日志也放进这个目录。
const DATA_DIR_ENV: &str = "KINSHOKO_DATA_DIR";
const LOG_DIR: &str = "logs";

static BROWSER_ARGS: OnceLock<String> = OnceLock::new();

pub struct UsageState(pub UsageLog);

/// 按启动时的设置定下 WebView2 启动参数、打开使用日志。在建任何窗口之前调用一次。
pub fn start(app: &AppHandle, settings: &AppSettings) -> tauri::Result<()> {
    let _ = BROWSER_ARGS.set(webview_browser_args(settings.force_srgb_in_effect()));
    let dir = match std::env::var_os(DATA_DIR_ENV) {
        Some(dir) => PathBuf::from(dir),
        None => app.path().app_local_data_dir()?,
    };
    let log = UsageLog::open(&dir.join(LOG_DIR), settings.usage_log());
    log.record(UsageEvent::AppStarted);
    app.manage(UsageState(log));
    Ok(())
}

/// 本进程所有窗口共用的 WebView2 启动参数（同一 WebView2 环境要求参数一致）。
pub fn browser_args() -> &'static str {
    BROWSER_ARGS.get_or_init(|| webview_browser_args(false))
}

/// 记一条使用日志；日志关闭时什么也不做。可以在主线程上调用。
pub fn record<R: Runtime>(app: &AppHandle<R>, event: UsageEvent) {
    if let Some(state) = app.try_state::<UsageState>() {
        state.0.record(event);
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn system_facts() -> SystemFacts {
    let monitors = xcap::Monitor::all().unwrap_or_default();
    #[cfg(windows)]
    {
        use crate::desktop::win32;
        let colours = win32::display_colours();
        let displays = monitors
            .iter()
            .map(|m| {
                let gdi = m.name().unwrap_or_default();
                let colour = colours.iter().find(|c| c.gdi_name == gdi);
                DisplayFacts {
                    name: colour
                        .map(|c| c.friendly_name.clone())
                        .filter(|n| !n.is_empty())
                        .unwrap_or_else(|| "（未知型号）".to_owned()),
                    primary: m.is_primary().unwrap_or(false),
                    width: m.width().unwrap_or(0),
                    height: m.height().unwrap_or(0),
                    scale: m.scale_factor().unwrap_or(1.0) as f64,
                    colour_mode: colour.map_or(DisplayColourMode::Unknown, |c| c.mode),
                    bits_per_channel: colour.and_then(|c| c.bits_per_channel),
                    icc: win32::display_profile(&gdi),
                }
            })
            .collect();
        SystemFacts {
            windows: win32::windows_version(),
            cpu: win32::cpu_name(),
            memory_bytes: win32::total_memory(),
            gpus: win32::gpu_names(),
            webview2: tauri::webview_version().ok(),
            displays,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = monitors;
        SystemFacts {
            windows: std::env::consts::OS.to_owned(),
            cpu: String::new(),
            memory_bytes: 0,
            gpus: Vec::new(),
            webview2: tauri::webview_version().ok(),
            displays: Vec::new(),
        }
    }
}

fn app_facts(state: &State<'_, ShellState>) -> Result<AppFacts, String> {
    let shell = state.0.lock().map_err(|e| e.to_string())?;
    Ok(AppFacts {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        force_srgb: shell.settings.force_srgb(),
        force_srgb_in_effect: shell.settings.force_srgb_in_effect(),
        usage_log: shell.settings.usage_log(),
    })
}

/// 诊断日志全文（纯文本），设置界面显示并可复制。
#[tauri::command]
pub async fn diagnostics_report(state: State<'_, ShellState>) -> Result<String, String> {
    let app = app_facts(&state)?;
    tauri::async_runtime::spawn_blocking(move || report(&app, &system_facts(), now()))
        .await
        .map_err(|e| e.to_string())
}

/// 把诊断日志存成文本文件；画师取消时返回 false。
#[tauri::command]
pub async fn export_diagnostics(
    app: AppHandle,
    state: State<'_, ShellState>,
) -> Result<bool, String> {
    let facts = app_facts(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let text = report(&facts, &system_facts(), now());
        let Some(path) = save_dialog(&app, "kinshoko-诊断信息.txt", "文本", "txt") else {
            return Ok(false);
        };
        std::fs::write(path, text.replace('\n', "\r\n"))
            .map(|()| true)
            .map_err(|e| format!("保存诊断信息失败：{e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把使用日志导出成文件；画师取消时返回 false。
#[tauri::command]
pub async fn export_usage_log(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = save_dialog(&app, "kinshoko-使用日志.jsonl", "JSON Lines", "jsonl")
        else {
            return Ok(false);
        };
        app.state::<UsageState>()
            .0
            .export(&path)
            .map(|()| true)
            .map_err(|e| format!("导出使用日志失败：{e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删掉已记录的使用日志。
#[tauri::command]
pub async fn clear_usage_log(usage: State<'_, UsageState>) -> Result<(), String> {
    usage
        .0
        .clear()
        .map_err(|e| format!("清除使用日志失败：{e}"))
}

fn save_dialog(app: &AppHandle, name: &str, filter: &str, ext: &str) -> Option<PathBuf> {
    app.dialog()
        .file()
        .set_file_name(name)
        .add_filter(filter, &[ext])
        .blocking_save_file()
        .and_then(|p| p.into_path().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 在本机实际查询一遍：每台显示器都查到了，报告里没有用户目录与配置文件位置。
    #[test]
    fn the_report_of_this_machine_lists_its_displays_without_paths() {
        let app = AppFacts {
            version: "0.0.0".into(),
            force_srgb: false,
            force_srgb_in_effect: false,
            usage_log: false,
        };
        let facts = system_facts();
        let text = report(&app, &facts, now());
        println!("{text}");
        assert_eq!(
            facts.displays.len(),
            xcap::Monitor::all().unwrap_or_default().len()
        );
        assert!(!text.contains(r"\Users\"), "{text}");
        assert!(!text.contains(r"spool\drivers"), "{text}");
    }
}
