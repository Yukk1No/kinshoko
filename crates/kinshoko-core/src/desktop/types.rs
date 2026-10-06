//! 截图与钉图窗口和应用壳之间传递的类型。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 框选完成后做什么。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CaptureAction {
    /// 钉到桌面。
    Pin,
    /// 复制到剪贴板。
    Copy,
}

/// 框选窗口要显示的冻结屏幕：整台显示器的物理像素尺寸，以及取图用的一次性标记。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FrozenScreen {
    pub width: u32,
    pub height: u32,
    /// 冻结屏幕的地址：`screen/<标记>`，由应用壳映射到自定义协议 `capture`。
    pub image: String,
}
