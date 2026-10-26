//! 截图与钉图窗口和应用壳之间传递的类型。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::ScreenRect;

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

/// 查看器当前显示的参考图与客户区内的物理像素范围。F1 用它恢复来源与原图裁切。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CaptureReference {
    pub library_id: String,
    pub image_id: String,
    pub shown: ScreenRect,
    pub visible: ScreenRect,
    #[serde(default)]
    pub covered: Vec<ScreenRect>,
}

/// A current WebView frame, confirmed again after native screen capture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CaptureReferenceFrame {
    pub instance: String,
    #[ts(type = "number")]
    pub generation: u64,
    pub dpr: f64,
    pub references: Vec<CaptureReference>,
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

/// 框选读数（#103）：选区得到参考视图时，结果在原图中的尺寸（原始像素）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct OriginalPixels {
    pub width: u32,
    pub height: u32,
}

/// 钉图怎样到达新的位置（#64）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PinMotion {
    /// 直接到（翻转、旋转、恢复）。
    Jump,
    /// 拖动：直接到。
    Drag,
    /// 缩放动画。
    Zoom,
    /// 贴边收起、滑出与回到原位的动画。
    Slide,
}

/// 钉图的翻转与旋转（中心不动）。快捷键 H/V/R/Shift+R 与右键菜单共用（#63、#64）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Turn {
    FlipHorizontal,
    FlipVertical,
    RotateClockwise,
    RotateCounterClockwise,
}
