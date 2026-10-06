//! 色彩描述：导入时记录的、原图如何声明自己的颜色。以后据此只重建受影响的派生图。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 一张原图的色彩描述（ADR-0005）。字段按文件内容识别，不看扩展名。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ColourDescription {
    /// 文件格式：`jpeg`、`png`、`webp` 或 `gif`。
    pub format: String,
    /// 每个通道的位深（PNG 可为 1、2、4、8、16）。
    pub bit_depth: u8,
    pub colour_model: ColourModel,
    /// 按 Chromium 的优先级实际生效的色彩声明。文件里带了但被忽略的 ICC 仍记在 `icc`。
    pub declaration: ColourDeclaration,
    /// 文件里嵌入的 ICC 配置文件。
    pub icc: Option<IccSummary>,
    /// PNG cICP 块（或 ICC 中的 cicp 标签）。
    pub cicp: Option<Cicp>,
    pub alpha: bool,
    /// EXIF 方向 1～8。
    pub orientation: u8,
    /// HDR 标记。带标记的原图首版只显示 `sdr` 派生图。
    pub hdr: Option<HdrKind>,
    /// 是否带 HDR 母版显示器或亮度信息（PNG mDCV／cLLI）。
    pub hdr_metadata: bool,
    /// 是否动图（GIF、动态 WebP、APNG）。首版只显示首帧。
    pub animated: bool,
}

impl ColourDescription {
    /// 首版不交给 WebView2 直接显示、任何缩放都用 `sdr` 派生图的原图（ADR-0005）。
    pub fn needs_sdr_derivative(&self) -> bool {
        self.animated || self.hdr.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ColourModel {
    Rgb,
    Gray,
    Cmyk,
}

/// 色彩声明的来源，顺序与 Chromium 一致：PNG 为 cICP → iCCP → sRGB 块 → gAMA＋cHRM → 仅 gAMA。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ColourDeclaration {
    /// 没有（或被忽略的）声明，按 sRGB 解释。
    None,
    Icc,
    Cicp,
    /// PNG sRGB 块。
    Srgb,
    /// PNG gAMA＋cHRM。
    GammaChromaticities,
    /// PNG 只有 gAMA：sRGB 原色加该 gamma。
    Gamma,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IccSummary {
    /// 配置文件字节的 SHA-256。
    pub sha256: String,
    /// 头部的版本号，例如 `4.3`、`2.1`。
    pub version: String,
    pub kind: IccKind,
}

/// ICC 配置文件的类型。LUT 型与 CMYK 不能由矩阵精确表示，转换误差须单独验收。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum IccKind {
    /// RGB 矩阵＋曲线。
    Matrix,
    /// 带 A2B 查找表（含全部 CMYK 配置文件）。
    Lut,
    /// 灰度曲线。
    Gray,
    /// 无法解析。Chromium 丢弃这类配置文件，按 sRGB 解释。
    Invalid,
}

/// ITU-T H.273 编码无关码点。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Cicp {
    pub primaries: u8,
    pub transfer: u8,
    pub matrix: u8,
    pub full_range: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum HdrKind {
    /// SMPTE ST 2084 传递函数。
    Pq,
    /// ARIB STD-B67 传递函数。
    Hlg,
    /// Ultra HDR／ISO 21496-1 增益图；基础图本身是 SDR。
    GainMap,
}
