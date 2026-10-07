//! 截取到的像素。

use std::io::Write;

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ImageEncoder, RgbaImage};

/// 一张截图：显示器上的原样像素，以及截取时这台显示器的配置文件（ICC）。
///
/// 像素是已经按显示器配置文件编码好的值；把配置文件标在文件上，WebView2 回显时的颜色
/// 转换就是“显示器 → 同一显示器”，即恒等变换（技术路线“截图标注截取时的显示器配置文件”）。
/// 剪贴板里的图片没有配置文件时为 `None`，按 sRGB 解释。
#[derive(Debug, Clone, PartialEq)]
pub struct Screenshot {
    pub image: RgbaImage,
    pub icc: Option<Vec<u8>>,
}

impl Screenshot {
    /// 裁下一块区域（超出截图的部分截掉），配置文件不变。区域为空或完全在截图外时为 `None`。
    pub fn crop(&self, region: Region) -> Option<Screenshot> {
        let (w, h) = self.image.dimensions();
        let right = region.x.saturating_add(region.width).min(w);
        let bottom = region.y.saturating_add(region.height).min(h);
        if region.x >= right || region.y >= bottom {
            return None;
        }
        let image = image::imageops::crop_imm(
            &self.image,
            region.x,
            region.y,
            right - region.x,
            bottom - region.y,
        )
        .to_image();
        Some(Screenshot {
            image,
            icc: self.icc.clone(),
        })
    }

    /// 编码为 PNG（无损、内嵌配置文件）。`fast` 用于需要马上显示的冻结屏幕。
    pub fn write_png(&self, out: impl Write, fast: bool) -> image::ImageResult<()> {
        let (compression, filter) = if fast {
            (CompressionType::Fast, FilterType::Sub)
        } else {
            (CompressionType::Default, FilterType::Adaptive)
        };
        let mut encoder = PngEncoder::new_with_quality(out, compression, filter);
        if let Some(icc) = &self.icc {
            // PNG 编码器总是支持 iCCP；失败只可能是实现变化，此时宁可报错也不悄悄丢掉。
            encoder
                .set_icc_profile(icc.clone())
                .map_err(image::ImageError::Unsupported)?;
        }
        encoder.write_image(
            self.image.as_raw(),
            self.image.width(),
            self.image.height(),
            image::ExtendedColorType::Rgba8,
        )
    }
}

/// 截图上的一块区域，单位是物理像素，相对截图左上角。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}
