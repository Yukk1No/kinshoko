//! 前端可调用的 Tauri 命令。每个命令只转发到 `kinshoko_core`，不放领域逻辑。
//!
//! 会调用窗口或系统 API 的命令写成 `async`，不在主线程上运行（见 `shell` 的线程规则）。

use kinshoko_core::CommandError;
use kinshoko_core::command_error::ErrorKind;
use kinshoko_core::{AppInfo, SettingChange, ShellSettingsView, ShortcutAction};
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
    Ok(state.0.lock().map_err(CommandError::system)?.view())
}

/// 改一项程序设置（#527），返回改后的整份设置。哪些设置走这里、怎样加一项，见 `SettingChange`。
///
/// 开机自启先改系统，保存失败时把系统改回去；增强钉图边缘保存后让已经钉着的钉图立即重画。
// 改之前、改之后各一个 `match`，新设置要做系统动作或通知时在里面加一行，所以不写成 `if let`。
#[allow(clippy::single_match)]
#[tauri::command]
pub async fn change_setting(
    app: AppHandle,
    state: State<'_, ShellState>,
    change: SettingChange,
) -> Result<ShellSettingsView, CommandError> {
    let view = {
        let mut shell = state.0.lock().map_err(CommandError::system)?;
        match change {
            SettingChange::Autostart { on } => {
                shell::apply_autostart(&app, on).map_err(|e| {
                    CommandError::caused_by(
                        e,
                        |cause| ErrorKind::AutostartFailed { cause },
                        |e| format!("无法更改开机自启：{e}"),
                    )
                })?;
            }
            _ => {}
        }
        if let Err(e) = shell.settings.apply(&change) {
            if let SettingChange::Autostart { on } = change {
                let _ = shell::apply_autostart(&app, !on);
            }
            return Err(e.into());
        }
        shell.view()
    };
    match change {
        SettingChange::PinEdgeContrast { .. } => crate::desktop::pin_edge_contrast_changed(&app),
        _ => {}
    }
    Ok(view)
}

/// 更换（`accelerator` 为 `null` 时清除）一个动作的全局快捷键，立即生效。
#[tauri::command]
pub async fn rebind_shortcut(
    state: State<'_, ShellState>,
    action: ShortcutAction,
    accelerator: Option<String>,
) -> Result<ShellSettingsView, CommandError> {
    let mut guard = state.0.lock().map_err(CommandError::system)?;
    let shell = &mut *guard;
    shell
        .shortcuts
        .rebind(&mut shell.settings, action, accelerator.as_deref())
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
    let lang = kinshoko_core::interface_lang::set(&lang).ok_or_else(|| {
        CommandError::new(
            ErrorKind::UnknownInterfaceLanguage { lang: lang.clone() },
            format!("没有这种界面语言：{lang}"),
        )
    })?;
    shell::announce_interface_language(&app, lang);
    Ok(lang)
}

/// 本机的界面缩放档位（百分比）。
#[tauri::command]
pub async fn ui_scale(state: State<'_, UiScaleState>) -> Result<u16, CommandError> {
    Ok(state.0.lock().map_err(CommandError::system)?.percent())
}

/// 换一档界面缩放：保存后立即缩放主窗口，不需要重启。
#[tauri::command]
pub async fn set_ui_scale(
    app: AppHandle,
    state: State<'_, UiScaleState>,
    percent: u16,
) -> Result<u16, CommandError> {
    let factor = {
        let mut scale = state.0.lock().map_err(CommandError::system)?;
        scale.set(percent).map_err(CommandError::from)?;
        scale.factor()
    };
    shell::apply_ui_scale(&app, factor);
    Ok(percent)
}
