//! 截图与钉图窗口和应用壳之间传递的类型。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{SavedPin, ScreenRect};

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

/// 钉图怎样到达新的位置（#64）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PinMotion {
    /// 直接到（拖动、翻转、旋转、恢复、动画结束后改窗口）。
    Jump,
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

/// 应用壳发给钉图窗口的一帧：画什么、原生窗口此刻在哪、内容要到哪（#64）。
///
/// 内容在窗口里变换，不逐帧改原生窗口；`window` 与 `content` 不同时（动画中、收起时），
/// 页面把内容画在 `content` 相对 `window` 的位置。
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PinFrame {
    pub pin: SavedPin,
    pub window: ScreenRect,
    pub content: ScreenRect,
    pub motion: PinMotion,
    /// 原位遮蔽（模糊并显示小圆锁）：安全模式开启时被封印的参考图，或资料库没打开、核对不了的
    /// 参考图（#60、#65）。画师确认显示这一张后为 false；截图钉图总是 false。
    pub veiled: bool,
    /// 资料库钉图暂时不能显示的原因（资料库没登记、不可用、图已删除、原图缺失，#66）；
    /// 能显示时没有。钉图保留位置与尺寸，画占位并写出原因。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub unavailable: Option<String>,
    /// 动画结束后页面带着它调用 `settle_pin`；不是最新一帧的就不再改窗口。
    pub generation: u32,
}
