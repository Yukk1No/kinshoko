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
    /// 模型标签按可信度分三档底色（默认）。
    #[default]
    Bands,
    /// 详情面板按出处分组，模型标签底边一条可信度刻度。
    Grouped,
}

/// 标签外观与可信度分档（#160）。阈值按两位小数保存，必须满足 `0 ≤ low < high ≤ 1`。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct TagDisplay {
    pub style: TagStyle,
    /// 高档下限：可信度不低于它的模型标签归高档。
    pub high: f32,
    /// 低档上限：可信度低于它的模型标签归低档。
    pub low: f32,
    /// 低档标签加虚线外框；默认开（维护者验收决定），关掉后只把字变浅。
    pub low_outline: bool,
}

impl Default for TagDisplay {
    /// 默认阈值来自维护者测试库的 13,837 个模型标签：0.80 / 0.40 让高、中、低三档大约各占三分之一。
    fn default() -> Self {
        TagDisplay {
            style: TagStyle::Bands,
            high: 0.8,
            low: 0.4,
            low_outline: true,
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
}

impl ShortcutAction {
    pub const ALL: [ShortcutAction; 3] = [
        ShortcutAction::Capture,
        ShortcutAction::PinClipboard,
        ShortcutAction::HideAllPins,
    ];

    /// 动作名称，只用在快捷键冲突的日志说明里；界面按动作代码从 src/i18n 取名称。
    // 不上界面：只用于 ShortcutError 的 Display（日志）
    pub fn label(self) -> &'static str {
        match self {
            ShortcutAction::Capture => "截图",
            ShortcutAction::PinClipboard => "钉剪贴板",
            ShortcutAction::HideAllPins => "收起全部钉图",
        }
    }

    pub(super) fn default_accelerator(self) -> &'static str {
        match self {
            ShortcutAction::Capture => "F1",
            ShortcutAction::PinClipboard => "F3",
            ShortcutAction::HideAllPins => "F4",
        }
    }
}
