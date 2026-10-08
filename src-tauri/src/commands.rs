//! 前端可调用的 Tauri 命令。每个命令只转发到 `kinshoko_core`，不放领域逻辑。
//!
//! 会调用窗口或系统 API 的命令写成 `async`，不在主线程上运行（见 `shell` 的线程规则）。

use kinshoko_core::{AppInfo, ShellSettingsView, ShortcutAction};
use tauri::{AppHandle, State};

use crate::diagnostics::UsageState;
use crate::shell::{self, ShellState};

#[tauri::command]
pub fn app_info() -> AppInfo {
    kinshoko_core::app_info()
}

#[tauri::command]
pub async fn shell_settings(state: State<'_, ShellState>) -> Result<ShellSettingsView, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.view())
}

/// 开关开机自启：先改系统，成功后再保存设置。
#[tauri::command]
pub async fn set_autostart(
    app: AppHandle,
    state: State<'_, ShellState>,
    on: bool,
) -> Result<ShellSettingsView, String> {
    let mut shell = state.0.lock().map_err(|e| e.to_string())?;
    shell::apply_autostart(&app, on).map_err(|e| format!("无法更改开机自启：{e}"))?;
    if let Err(e) = shell.settings.set_autostart(on) {
        let _ = shell::apply_autostart(&app, !on);
        return Err(e.to_string());
    }
    Ok(shell.view())
}

/// 开关查找条件里相近标签的来源标记（内置／个人）。
#[tauri::command]
pub async fn set_show_approx_source(
    state: State<'_, ShellState>,
    on: bool,
) -> Result<ShellSettingsView, String> {
    let mut shell = state.0.lock().map_err(|e| e.to_string())?;
    shell
        .settings
        .set_show_approx_source(on)
        .map_err(|e| e.to_string())?;
    Ok(shell.view())
}

/// 开关诊断开关“强制 sRGB”。WebView2 环境在启动时建好，重启 Kinshoko 后生效。
#[tauri::command]
pub async fn set_force_srgb(
    state: State<'_, ShellState>,
    on: bool,
) -> Result<ShellSettingsView, String> {
    let mut shell = state.0.lock().map_err(|e| e.to_string())?;
    shell
        .settings
        .set_force_srgb(on)
        .map_err(|e| e.to_string())?;
    Ok(shell.view())
}

/// 开关使用日志，立即生效。关闭后已记录的内容保留，由画师决定导出或清除。
#[tauri::command]
pub async fn set_usage_log(
    state: State<'_, ShellState>,
    usage: State<'_, UsageState>,
    on: bool,
) -> Result<ShellSettingsView, String> {
    let mut shell = state.0.lock().map_err(|e| e.to_string())?;
    shell
        .settings
        .set_usage_log(on)
        .map_err(|e| e.to_string())?;
    usage.0.set_enabled(on);
    Ok(shell.view())
}

/// 更换（`accelerator` 为 `null` 时清除）一个动作的全局快捷键，立即生效。
#[tauri::command]
pub async fn rebind_shortcut(
    state: State<'_, ShellState>,
    action: ShortcutAction,
    accelerator: Option<String>,
) -> Result<ShellSettingsView, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let shell = &mut *guard;
    shell
        .shortcuts
        .rebind(&mut shell.settings, action, accelerator.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(shell.view())
}

#[tauri::command]
pub async fn set_viewer_background(
    state: State<'_, ShellState>,
    background: kinshoko_core::ViewerBackground,
) -> Result<ShellSettingsView, String> {
    let mut shell = state.0.lock().map_err(|e| e.to_string())?;
    shell
        .settings
        .set_viewer_background(background)
        .map_err(|e| e.to_string())?;
    Ok(shell.view())
}
#[tauri::command]
pub async fn migrate_viewer_background(
    state: State<'_, ShellState>,
    background: kinshoko_core::ViewerBackground,
) -> Result<ShellSettingsView, String> {
    let mut shell = state.0.lock().map_err(|e| e.to_string())?;
    shell
        .settings
        .migrate_viewer_background(background)
        .map_err(|e| e.to_string())?;
    Ok(shell.view())
}
