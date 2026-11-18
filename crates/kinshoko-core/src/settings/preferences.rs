//! 设置里的几种取值：查看器背景、标签外观与可绑定全局快捷键的动作。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ViewerBackground {
    Dark,
    Mid,
    Light,
    Checker,
}

/// 详情面板与查看器里标签的外观（#160）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TagStyle {
    /// 按准不准分三档（默认，#482）：人写的与模型高档有底，中档细线框，低档虚线框。
    #[default]
    Bands,
    /// 详情面板按出处分组，模型标签底边一条可信度刻度。
    Grouped,
}

/// 标签外观与可信度分档（#160）。阈值按两位小数保存，必须满足 `0 ≤ low < high ≤ 1`。
/// 旧设置文件里的 `lowOutline`（低档虚线框开关，#482 去掉，虚线一直显示）读入时忽略，再保存时不写。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct TagDisplay {
    pub style: TagStyle,
    /// 高档下限：可信度不低于它的模型标签归高档。
    pub high: f32,
    /// 低档上限：可信度低于它的模型标签归低档。
    pub low: f32,
}

impl Default for TagDisplay {
    /// 默认阈值来自维护者测试库的 13,837 个模型标签：0.80 / 0.40 让高、中、低三档大约各占三分之一。
    fn default() -> Self {
        TagDisplay {
            style: TagStyle::Bands,
            high: 0.8,
            low: 0.4,
        }
    }
}

impl TagDisplay {
    pub(super) fn thresholds_valid(&self) -> bool {
        (0.0..=1.0).contains(&self.low) && (0.0..=1.0).contains(&self.high) && self.low < self.high
    }
}

/// 可以绑定全局快捷键的动作。默认键沿用 Snipaste 的习惯。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ShortcutAction {
    /// 框选屏幕区域截图。
    Capture,
    /// 把剪贴板里的图片钉到桌面。
    PinClipboard,
    /// 把全部钉图收到屏幕边缘，再按一次回到原位。
    HideAllPins,
    /// 桌面换成切换列表里的上一个参考组（#594；只在参考组改成桌面的开关打开时可用）。
    PreviousGroup,
    /// 桌面换成切换列表里的下一个参考组（#594）。
    NextGroup,
    /// 换到一张新的空桌（#594）。
    NewGroup,
}

impl ShortcutAction {
    pub const ALL: [ShortcutAction; 6] = [
        ShortcutAction::Capture,
        ShortcutAction::PinClipboard,
        ShortcutAction::HideAllPins,
        ShortcutAction::PreviousGroup,
        ShortcutAction::NextGroup,
        ShortcutAction::NewGroup,
    ];

    /// 参考组改成桌面（#588）的动作：开关关着时不注册、不在设置里显示。
    pub fn needs_desk_groups(self) -> bool {
        matches!(
            self,
            ShortcutAction::PreviousGroup | ShortcutAction::NextGroup | ShortcutAction::NewGroup
        )
    }

    /// 动作名称，只用在快捷键冲突的日志说明里；界面按动作代码从 src/i18n 取名称。
    // 不上界面：只用于 ShortcutError 的 Display（日志）
    pub fn label(self) -> &'static str {
        match self {
            ShortcutAction::Capture => "截图",
            ShortcutAction::PinClipboard => "钉剪贴板",
            ShortcutAction::HideAllPins => "收起全部钉图",
            ShortcutAction::PreviousGroup => "上个参考组",
            ShortcutAction::NextGroup => "下个参考组",
            ShortcutAction::NewGroup => "新参考组",
        }
    }

    /// 默认键；拿不准的不绑定（#594：参考组的三个动作等维护者定）。
    pub(super) fn default_accelerator(self) -> Option<&'static str> {
        match self {
            ShortcutAction::Capture => Some("F1"),
            ShortcutAction::PinClipboard => Some("F3"),
            ShortcutAction::HideAllPins => Some("F4"),
            ShortcutAction::PreviousGroup
            | ShortcutAction::NextGroup
            | ShortcutAction::NewGroup => None,
        }
    }
}
