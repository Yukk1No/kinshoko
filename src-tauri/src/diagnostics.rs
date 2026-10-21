//! 诊断（#70）：“强制 sRGB”的 WebView2 启动参数与诊断信息。
//!
//! 规则与脱敏在 `kinshoko_core::diagnostics`；这里只向 Windows 查询系统信息、接保存对话框。
//! 诊断信息连同最近几天的运行日志（`crate::run_log`）一起存成 zip（#219）。

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use kinshoko_core::AppSettings;
use kinshoko_core::diagnostics::{
    AppFacts, DisplayColourMode, DisplayFacts, RuntimeCapabilities, RuntimeStatus, SystemFacts,
    report_with_runtime, scrub, webview_browser_args,
};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt as _;

use crate::shell::ShellState;

static BROWSER_ARGS: OnceLock<String> = OnceLock::new();

/// 按启动时的设置定下 WebView2 启动参数、打开运行日志。在建任何窗口之前调用一次。
pub fn start(app: &AppHandle, settings: &AppSettings) -> tauri::Result<()> {
    let _ = BROWSER_ARGS.set(webview_browser_args(settings.force_srgb_in_effect()));
    crate::run_log::start(app, settings);
    Ok(())
}

/// 本进程所有窗口共用的 WebView2 启动参数（同一 WebView2 环境要求参数一致）。
pub fn browser_args() -> &'static str {
    BROWSER_ARGS.get_or_init(|| webview_browser_args(false))
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

fn app_facts(app: &AppHandle, state: &State<'_, ShellState>) -> Result<AppFacts, String> {
    let migration_problem = crate::data_dirs::migration_problem(app);
    let shell = state.0.lock().map_err(|e| e.to_string())?;
    Ok(AppFacts {
        data_migration_problem: migration_problem,
        version: env!("CARGO_PKG_VERSION").to_owned(),
        force_srgb: shell.settings.force_srgb(),
        force_srgb_in_effect: shell.settings.force_srgb_in_effect(),
        run_log: shell.settings.run_log(),
    })
}

/// 诊断日志全文（纯文本），设置界面显示并可复制。
#[tauri::command]
pub async fn diagnostics_report(
    app: AppHandle,
    state: State<'_, ShellState>,
    runtime: Option<RuntimeCapabilities>,
) -> Result<String, String> {
    let app = app_facts(&app, &state)?;
    tauri::async_runtime::spawn_blocking(move || {
        report_with_runtime(&app, &system_facts(), now(), runtime.as_ref())
    })
    .await
    .map_err(|e| e.to_string())
}

/// 把诊断信息连同最近几天的运行日志存成 zip；画师取消时返回 false。
#[tauri::command]
pub async fn export_diagnostics(
    app: AppHandle,
    state: State<'_, ShellState>,
    runtime: Option<RuntimeCapabilities>,
) -> Result<bool, String> {
    let facts = app_facts(&app, &state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let text = report_with_runtime(&facts, &system_facts(), now(), runtime.as_ref());
        let name = format!(
            "kinshoko-诊断信息-{}.zip",
            chrono::Local::now().format("%Y%m%d-%H%M")
        );
        let Some(path) = save_dialog(&app, &name, "zip 压缩包", "zip") else {
            return Ok(false);
        };
        let saved = match crate::run_log::log() {
            Some(log) => log.export(&path, &text),
            None => Err(std::io::Error::other("运行日志没有打开")),
        };
        saved
            .map(|()| true)
            .map_err(|e| format!("保存诊断信息失败：{e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 只解释当前窗口实测状态。版本查询失败不能替代能力检查，也不能用版本豁免质量失败。
#[tauri::command]
pub fn runtime_status(runtime: RuntimeCapabilities) -> RuntimeStatus {
    RuntimeStatus {
        webview2: tauri::webview_version().ok().map(|version| scrub(&version)),
        assessment: runtime.assess(),
    }
}

/// 固定的官方入口。只由用户点击打开，不接收任意 URL，不下载安装、不重启或退出程序。
#[tauri::command]
pub fn open_runtime_update() -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg("https://developer.microsoft.com/en-us/microsoft-edge/webview2/")
            .spawn()
            .map(|_| ())
            .map_err(|_| "无法打开微软 WebView2 下载页。请在浏览器访问 https://developer.microsoft.com/en-us/microsoft-edge/webview2/".to_owned())
    }
    #[cfg(not(windows))]
    Err("请在浏览器访问 https://developer.microsoft.com/en-us/microsoft-edge/webview2/".to_owned())
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
            run_log: false,
            data_migration_problem: None,
        };
        let facts = system_facts();
        let text = report_with_runtime(&app, &facts, now(), None);
        println!("{text}");
        assert_eq!(
            facts.displays.len(),
            xcap::Monitor::all().unwrap_or_default().len()
        );
        assert!(!text.contains(r"\Users\"), "{text}");
        assert!(!text.contains(r"spool\drivers"), "{text}");
    }
}
