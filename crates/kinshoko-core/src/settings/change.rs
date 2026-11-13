//! 一项程序设置的改动（#527）：前端改这几项设置都走同一条命令 `change_setting`。
//!
//! 只收“改一个值、保存、回整份设置”的设置，以及改完只需通知一下的。有自己的状态或规则的
//! （快捷键、更新通道、安全模式范围、界面缩放、运行日志、界面语言）各走各的命令。
//!
//! 新加一项这样的设置：
//! 1. 在 [`SettingsSnapshot`](super::SettingsSnapshot) 加字段，在 [`AppSettings`] 加读写方法；
//! 2. 在 [`SettingChange`] 加一个分支，分支名与 `ShellSettingsView` 的字段名对应；
//! 3. 在 [`AppSettings::apply`] 加一行；
//! 4. 改完要通知别处（例如钉图）或先改系统时，在 `src-tauri` 的 `change_setting` 里对应的 `match` 加一行。

use serde::Deserialize;
use ts_rs::TS;

use super::{AppSettings, SettingsError, TagDisplay, ViewerBackground};

/// 一项程序设置的改动。
#[derive(Debug, Clone, PartialEq, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum SettingChange {
    ShowApproxSource { on: bool },
    KeepSelectionOnSafeMode { on: bool },
    ForceSrgb { on: bool },
    PinEdgeContrast { on: bool },
    Autostart { on: bool },
    TagDisplay { display: TagDisplay },
    ViewerBackground { background: ViewerBackground },
    InspectorWidth { width: u32 },
    InspectorOpen { open: bool },
}

impl AppSettings {
    /// 应用一项改动并保存；失败时原来的设置不变。
    pub fn apply(&mut self, change: &SettingChange) -> Result<(), SettingsError> {
        match *change {
            SettingChange::ShowApproxSource { on } => self.set_show_approx_source(on),
            SettingChange::KeepSelectionOnSafeMode { on } => {
                self.set_keep_selection_on_safe_mode(on)
            }
            SettingChange::ForceSrgb { on } => self.set_force_srgb(on),
            SettingChange::PinEdgeContrast { on } => self.set_pin_edge_contrast(on),
            SettingChange::Autostart { on } => self.set_autostart(on),
            SettingChange::TagDisplay { display } => self.set_tag_display(display),
            SettingChange::ViewerBackground { background } => {
                self.set_viewer_background(background)
            }
            SettingChange::InspectorWidth { width } => self.set_inspector_width(width),
            SettingChange::InspectorOpen { open } => self.set_inspector_open(open),
        }
    }
}
