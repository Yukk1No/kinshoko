//! 前端可调用的 Tauri 命令。每个命令只转发到 `kinshoko_core`，不放领域逻辑。
//!
//! 会调用窗口或系统 API 的命令写成 `async`，不在主线程上运行（见 `shell` 的线程规则）。

use kinshoko_core::CommandError;
use kinshoko_core::{AppInfo, ShellSettingsView, ShortcutAction};
use tauri::{AppHandle, State};

use crate::shell::{self, ShellState, UiScaleState};

#[tauri::command]
pub fn app_info() -> AppInfo {
    kinshoko_core::app_info()
}

#[tauri::command]
pub async fn shell_settings(
    state: State<'_, ShellState>,
) -> Result<ShellSettingsView, CommandError> {
    Ok(state.0.lock().map_err(CommandError::message)?.view())
}

/// 开关开机自启：先改系统，成功后再保存设置。
#[tauri::command]
pub async fn set_autostart(
    app: AppHandle,
    state: State<'_, ShellState>,
    on: bool,
) -> Result<ShellSettingsView, CommandError> {
    let mut shell = state.0.lock().map_err(CommandError::message)?;
    shell::apply_autostart(&app, on)
        .map_err(|e| CommandError::message(format!("无法更改开机自启：{e}")))?;
    if let Err(e) = shell.settings.set_autostart(on) {
        let _ = shell::apply_autostart(&app, !on);
        return Err(e.to_string().into());
    }
    Ok(shell.view())
}

/// 开关查找条件里相近标签的来源标记（内置／个人）。
#[tauri::command]
pub async fn set_show_approx_source(
    state: State<'_, ShellState>,
    on: bool,
) -> Result<ShellSettingsView, CommandError> {
    let mut shell = state.0.lock().map_err(CommandError::message)?;
    shell
        .settings
        .set_show_approx_source(on)
        .map_err(CommandError::from)?;
    Ok(shell.view())
}

/// 保存标签外观与可信度分档（#160）；阈值交叉时拒绝，原来的设置不变。
#[tauri::command]
pub async fn set_tag_display(
    state: State<'_, ShellState>,
    display: kinshoko_core::TagDisplay,
) -> Result<ShellSettingsView, CommandError> {
    let mut shell = state.0.lock().map_err(CommandError::message)?;
    shell
        .settings
        .set_tag_display(display)
        .map_err(CommandError::from)?;
    Ok(shell.view())
}

/// 开关“切换安全模式时保留选择”。
#[tauri::command]
pub async fn set_keep_selection_on_safe_mode(
    state: State<'_, ShellState>,
    on: bool,
) -> Result<ShellSettingsView, CommandError> {
    let mut shell = state.0.lock().map_err(CommandError::message)?;
    shell
        .settings
        .set_keep_selection_on_safe_mode(on)
        .map_err(CommandError::from)?;
    Ok(shell.view())
}

/// 开关“增强钉图边缘”（#239）：保存后已经钉着的钉图立即重画。
#[tauri::command]
pub async fn set_pin_edge_contrast(
    app: AppHandle,
    state: State<'_, ShellState>,
    on: bool,
) -> Result<ShellSettingsView, CommandError> {
    let view = {
        let mut shell = state.0.lock().map_err(CommandError::message)?;
        shell
            .settings
            .set_pin_edge_contrast(on)
            .map_err(CommandError::from)?;
        shell.view()
    };
    crate::desktop::pin_edge_contrast_changed(&app);
    Ok(view)
}

/// 开关诊断开关“强制 sRGB”。WebView2 环境在启动时建好，重启 Kinshoko 后生效。
#[tauri::command]
pub async fn set_force_srgb(
    state: State<'_, ShellState>,
    on: bool,
) -> Result<ShellSettingsView, CommandError> {
    let mut shell = state.0.lock().map_err(CommandError::message)?;
    shell
        .settings
        .set_force_srgb(on)
        .map_err(CommandError::from)?;
    Ok(shell.view())
}

/// 更换（`accelerator` 为 `null` 时清除）一个动作的全局快捷键，立即生效。
#[tauri::command]
pub async fn rebind_shortcut(
    state: State<'_, ShellState>,
    action: ShortcutAction,
    accelerator: Option<String>,
) -> Result<ShellSettingsView, CommandError> {
    let mut guard = state.0.lock().map_err(CommandError::message)?;
    let shell = &mut *guard;
    shell
        .shortcuts
        .rebind(&mut shell.settings, action, accelerator.as_deref())
        .map_err(CommandError::from)?;
    Ok(shell.view())
}

#[tauri::command]
pub async fn set_viewer_background(
    state: State<'_, ShellState>,
    background: kinshoko_core::ViewerBackground,
) -> Result<ShellSettingsView, CommandError> {
    let mut shell = state.0.lock().map_err(CommandError::message)?;
    shell
        .settings
        .set_viewer_background(background)
        .map_err(CommandError::from)?;
    Ok(shell.view())
}
/// 保存主窗口详情面板的宽度（#157），超出 280–560 时停在边界上。
#[tauri::command]
pub async fn set_inspector_width(
    state: State<'_, ShellState>,
    width: u32,
) -> Result<ShellSettingsView, CommandError> {
    let mut shell = state.0.lock().map_err(CommandError::message)?;
    shell
        .settings
        .set_inspector_width(width)
        .map_err(CommandError::from)?;
    Ok(shell.view())
}
#[tauri::command]
pub async fn migrate_viewer_background(
    state: State<'_, ShellState>,
    background: kinshoko_core::ViewerBackground,
) -> Result<ShellSettingsView, CommandError> {
    let mut shell = state.0.lock().map_err(CommandError::message)?;
    shell
        .settings
        .migrate_viewer_background(background)
        .map_err(CommandError::from)?;
    Ok(shell.view())
}

/// 系统的双击设置（#179）：图片墙按“第一下的图”判定双击时用。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoubleClick {
    /// 双击间隔（毫秒）。
    interval_ms: u32,
    /// 以第一下为中心的判定矩形（物理像素）。
    width: i32,
    height: i32,
}

/// 读不到系统设置（或不是 Windows）时为 `None`，前端用 500 ms / 4 px。
#[tauri::command]
pub async fn double_click() -> Option<DoubleClick> {
    #[cfg(windows)]
    {
        crate::desktop::win32::double_click().map(|(interval_ms, width, height)| DoubleClick {
            interval_ms,
            width,
            height,
        })
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// 当前界面语言（#354）。
#[tauri::command]
pub fn interface_language() -> &'static str {
    kinshoko_core::interface_lang::current()
}

/// 换界面语言：主窗口、钉图菜单与截图窗口随即更新，不需要重启。设置里的选项随 #358 上线。
#[tauri::command]
pub fn set_interface_language(app: AppHandle, lang: String) -> Result<&'static str, CommandError> {
    let lang = kinshoko_core::interface_lang::set(&lang)
        .ok_or_else(|| format!("没有这种界面语言：{lang}"))?;
    shell::announce_interface_language(&app, lang);
    Ok(lang)
}

/// 本机的界面缩放档位（百分比）。
#[tauri::command]
pub async fn ui_scale(state: State<'_, UiScaleState>) -> Result<u16, CommandError> {
    Ok(state.0.lock().map_err(CommandError::message)?.percent())
}

/// 换一档界面缩放：保存后立即缩放主窗口，不需要重启。
#[tauri::command]
pub async fn set_ui_scale(
    app: AppHandle,
    state: State<'_, UiScaleState>,
    percent: u16,
) -> Result<u16, CommandError> {
    let factor = {
        let mut scale = state.0.lock().map_err(CommandError::message)?;
        scale.set(percent).map_err(CommandError::from)?;
        scale.factor()
    };
    shell::apply_ui_scale(&app, factor);
    Ok(percent)
}
