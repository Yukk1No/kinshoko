//! 派生图管线：解码 → 按来源色彩声明转到线性光工作空间（f32）→ 转正方向 → 预乘 alpha 的
//! Lanczos3 缩放 → 转到存储空间、四舍五入量化 → 无损编码。
//!
//! 缩放所在的空间是管线参数（[`Downscale`]，#48）：默认线性光；编码值空间则先转到存储空间
//! 再缩放，与多数绘画软件和浏览器相同。画师用探测程序对比后决定默认值。
//!
//! 存储按来源分档（核查第 3 节）：
//! - sRGB／无声明：8 位无损 WebP，不带 ICC（与原图同按 sRGB 解释）；
//! - 矩阵型 RGB ICC：保留同一 ICC，8 位无损 WebP；
//! - 其余（LUT 型、CMYK、灰度 ICC、gAMA/cHRM、非 sRGB 的 cICP、PQ/HLG）：转换到 Display P3；
//! - 转换到 Display P3 的，以及 16 位来源：16 位 PNG（＋iCCP）。
//!
//! 动图取首帧；增益图取基础图；PQ/HLG 色调映射到 SDR。派生图不带方向。

use std::io::Cursor;

use fast_image_resize::{self as fr, ResizeAlg, ResizeOptions, Resizer};
use image::codecs::png::PngEncoder;
use image::codecs::webp::WebPEncoder;
use image::{
    AnimationDecoder, DynamicImage, ExtendedColorType, ImageEncoder, ImageFormat, ImageReader,
    Rgba32FImage, metadata::Orientation,
};
use moxcms::{
    CicpColorPrimaries, CicpProfile, ColorPrimaries, ColorProfile, DataColorSpace, Layout,
    MatrixCoefficients, RenderingIntent, TransferCharacteristics, TransformOptions, XyY,
    curve_from_gamma,
};

use super::budget;
use super::description::{Cicp, ColourDeclaration, ColourDescription, ColourModel, IccKind};
use super::inspect::{Inspection, inspect};
use super::profiles;

mod decode;
use decode::*;

/// 能按 cICP 解释的原色与传递函数（与 Chromium 支持的常见组合一致）。
pub(crate) fn cicp_supported(cicp: Cicp) -> bool {
    matches!(cicp.primaries, 1 | 9 | 12)
        && matches!(cicp.transfer, 1 | 6 | 8 | 13 | 14 | 15 | 16 | 18)
}

/// 派生图的存储空间。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Space {
    Srgb,
    /// 保留来源的矩阵型 ICC。
    SourceIcc,
    DisplayP3,
}

/// 派生图的容器。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Container {
    /// 8 位无损 WebP。
    WebP,
    /// 16 位 PNG。
    Png16,
}

impl Container {
    pub(crate) fn extension(self) -> &'static str {
        match self {
            Container::WebP => "webp",
            Container::Png16 => "png",
        }
    }

    pub(crate) fn mime(self) -> &'static str {
        match self {
            Container::WebP => "image/webp",
            Container::Png16 => "image/png",
        }
    }
}

fn space(d: &ColourDescription) -> Space {
    match d.declaration {
        ColourDeclaration::None | ColourDeclaration::Srgb => Space::Srgb,
        ColourDeclaration::Cicp if d.cicp.is_some_and(|c| c.primaries == 1 && c.transfer == 13) => {
            Space::Srgb
        }
        ColourDeclaration::Icc
            if d.colour_model == ColourModel::Rgb
                && d.icc.as_ref().is_some_and(|i| i.kind == IccKind::Matrix) =>
        {
            Space::SourceIcc
        }
        _ => Space::DisplayP3,
    }
}

/// 只看色彩描述就能确定派生图的容器，因而缓存路径不必先解码。
pub(crate) fn container(d: &ColourDescription) -> Container {
    if d.bit_depth > 8 || space(d) == Space::DisplayP3 {
        Container::Png16
    } else {
        Container::WebP
    }
}

/// 缩小时在哪个空间里做卷积（核查“线性光缩小是否等于还原”，#48）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Downscale {
    /// 线性光（物理上正确）：白底黑细线缩小后显得更浅、更细。
    LinearLight,
    /// 存储空间的编码值（非线性）：与多数绘画软件、浏览器的缩小相同，细线保持更深。
    EncodedValue,
}

/// 管线默认的缩小方式。改动它即改变缩略图管线版本（`library::thumbnail`），旧缓存整体作废。
/// 首版按核查建议用线性光；画师用探测程序（`tools/downscale-probe`）选定后补记在验收约定。
pub const DEFAULT_DOWNSCALE: Downscale = Downscale::LinearLight;

/// 一张 `sdr` 派生图的编码结果。
#[derive(Debug, Clone)]
pub struct SdrDerivative {
    /// 编码后的文件字节（8 位无损 WebP 或 16 位 PNG）。
    pub bytes: Vec<u8>,
    /// 内容类型：`image/webp` 或 `image/png`。
    pub mime: &'static str,
    /// 转正后的像素尺寸。
    pub width: u32,
    pub height: u32,
}

/// 生成 `sdr` 派生图：宽度不超过 `max_width`，不放大；`downscale` 决定在哪个空间缩小。
/// 先等整图解码预算（[`budget`]），超过上限时排队。
pub fn render_sdr(
    bytes: &[u8],
    max_width: u32,
    downscale: Downscale,
) -> Result<SdrDerivative, String> {
    let inspection = inspect(bytes)?.ok_or("不支持的格式")?;
    let permit = budget::reserve_decode(&inspection, None).expect("不可取消的等待总会占到");
    render_sdr_widths(&permit, bytes, &inspection, &[max_width], downscale)?
        .pop()
        .expect("一个宽度一份结果")
}

/// 解码一次，按每个宽度各出一份 `sdr` 派生图：导入时校验像素、生成占位图与网格缩略图共用这一次解码
/// （#120、#123）。每一份与单独调用 [`render_sdr`] 的结果逐字节相同。
/// 调用方先为这张图占好整图解码预算（`_permit`）。
/// 外层错误是解码失败，文件头有效、压缩像素却损坏的原图在这里失败，导入在暂存与发布之前据此拒绝；
/// 内层是解码之后某一份的缩放或编码失败，导入照常进行，只是这张图暂时缺这一份派生图。
pub(crate) fn render_sdr_widths(
    _permit: &budget::DecodePermit,
    bytes: &[u8],
    inspection: &Inspection,
    max_widths: &[u32],
    downscale: Downscale,
) -> Result<Vec<Result<SdrDerivative, String>>, String> {
    let _rendering = budget::rendering(budget::estimate(inspection));
    let d = &inspection.description;
    let space = space(d);
    let container = container(d);

    let output = output_profile(space, inspection)?;
    let working = profiles::linear_of(&output);

    let (w, h, linear) = decode_linear(bytes, inspection, &working)?;
    // 转正方向。各个宽度都从这一份借用，不再各复制一份整图。
    let upright = (|| {
        let mut upright = DynamicImage::ImageRgba32F(
            Rgba32FImage::from_raw(w, h, linear).ok_or("像素缓冲尺寸不符")?,
        );
        upright.apply_orientation(inspection.orientation);
        Ok::<_, String>(upright.into_rgba32f())
    })();
    let icc = match space {
        Space::Srgb => None,
        Space::SourceIcc => inspection.icc.clone(),
        Space::DisplayP3 => Some(profiles::display_p3_icc()),
    };
    let render = |upright: &Rgba32FImage, max_width: u32| -> Result<SdrDerivative, String> {
        let (w, h, encoded) = match downscale {
            Downscale::LinearLight => match resize(upright, max_width)? {
                Some(resized) => {
                    let (w, h) = resized.dimensions();
                    (w, h, to_output(&resized, &working, &output)?)
                }
                None => {
                    let (w, h) = upright.dimensions();
                    (w, h, to_output(upright, &working, &output)?)
                }
            },
            Downscale::EncodedValue => {
                let (w, h) = upright.dimensions();
                let values = to_output(upright, &working, &output)?;
                let values = Rgba32FImage::from_raw(w, h, values).ok_or("像素缓冲尺寸不符")?;
                match resize(&values, max_width)? {
                    Some(resized) => {
                        let (w, h) = resized.dimensions();
                        (w, h, resized.into_raw())
                    }
                    None => (w, h, values.into_raw()),
                }
            }
        };
        let bytes = encode(&encoded, w, h, d.alpha, container, icc.clone())?;
        Ok(SdrDerivative {
            bytes,
            mime: container.mime(),
            width: w,
            height: h,
        })
    };
    let upright = upright?;
    Ok(max_widths
        .iter()
        .map(|&max_width| render(&upright, max_width))
        .collect())
}

/// 解码一张图，按来源色彩声明（与派生图同一套规则）转到线性光 `working`，转正方向；不缩放。
/// 钉图上传用（`desktop::pin_colour`）。先等整图解码预算。
pub(crate) fn decode_upright(bytes: &[u8], working: &ColorProfile) -> Result<Rgba32FImage, String> {
    let inspection = inspect(bytes)?.ok_or("不支持的格式")?;
    let _permit = budget::reserve_decode(&inspection, None).expect("不可取消的等待总会占到");
    let (w, h, linear) = decode_linear(bytes, &inspection, working)?;
    let mut upright =
        DynamicImage::ImageRgba32F(Rgba32FImage::from_raw(w, h, linear).ok_or("像素缓冲尺寸不符")?);
    upright.apply_orientation(inspection.orientation);
    Ok(upright.into_rgba32f())
}

/// 原尺寸显示源 → 剪贴板用的无配置文件 sRGB RGBA8。共用来源声明、首帧、色调映射和方向解码。
/// 不进行缩放；arboard 的图片接口不能携带 ICC，因此必须转换颜色，不能把 P3／ICC 数值当成 sRGB。
pub(crate) fn clipboard_rgba(bytes: &[u8]) -> Result<image::RgbaImage, String> {
    let inspection = inspect(bytes)?.ok_or("不支持的格式")?;
    clipboard_pixels(bytes, &inspection, None)
}

/// 原图中的一块（转正后的像素坐标）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct UprightCrop {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// 与 [`clipboard_rgba`] 后再裁下 `crop` 逐像素相同，但色彩转换只做选区（#127）：
/// 整张大图的 f32 线性光往返要数秒，而框选复制只要其中一小块。
/// 原图转正后的尺寸不是 `size` 时（来源已变）返回 `None`，只读文件头，不解码。
pub(crate) fn clipboard_rgba_crop(
    bytes: &[u8],
    size: (u32, u32),
    crop: UprightCrop,
) -> Result<Option<image::RgbaImage>, String> {
    let inspection = inspect(bytes)?.ok_or("不支持的格式")?;
    if (inspection.width, inspection.height) != size {
        return Ok(None);
    }
    clipboard_pixels(bytes, &inspection, Some(crop)).map(Some)
}

fn clipboard_pixels(
    bytes: &[u8],
    inspection: &Inspection,
    crop: Option<UprightCrop>,
) -> Result<image::RgbaImage, String> {
    // 选区之外也要整张解码（CMYK 与 HDR 还要整图转换），与派生图共用整图解码预算。
    let _permit = budget::reserve_decode(inspection, None).expect("不可取消的等待总会占到");
    let srgb = ColorProfile::new_srgb();
    let working = profiles::linear_of(&srgb);
    let (w, h, linear) = decode_linear_crop(bytes, inspection, &working, crop)?;
    let encoded = to_output(&linear, &working, &srgb)?;
    drop(linear);
    let pixels = encoded
        .into_iter()
        .map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect();
    let mut upright = DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(w, h, pixels).ok_or("像素缓冲尺寸不符")?,
    );
    upright.apply_orientation(inspection.orientation);
    Ok(upright.into_rgba8())
}

/// 转正后的选区 → 存储方向下的同一块像素（与 `apply_orientation` 互逆），`(x, y, 宽, 高)`。
fn stored_rect(
    orientation: Orientation,
    (w, h): (u32, u32),
    crop: UprightCrop,
) -> Result<(u32, u32, u32, u32), String> {
    let swaps = matches!(
        orientation,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    );
    let (uw, uh) = if swaps { (h, w) } else { (w, h) };
    if crop.width == 0
        || crop.height == 0
        || crop.x.checked_add(crop.width).is_none_or(|r| r > uw)
        || crop.y.checked_add(crop.height).is_none_or(|b| b > uh)
    {
        return Err("选区超出原图".into());
    }
    // 转正后的 (u, v) 对应存储方向下的 (x, y)。
    let stored = |u: u32, v: u32| match orientation {
        Orientation::NoTransforms => (u, v),
        Orientation::Rotate90 => (v, h - 1 - u),
        Orientation::Rotate180 => (w - 1 - u, h - 1 - v),
        Orientation::Rotate270 => (w - 1 - v, u),
        Orientation::FlipHorizontal => (w - 1 - u, v),
        Orientation::FlipVertical => (u, h - 1 - v),
        Orientation::Rotate90FlipH => (v, u),
        Orientation::Rotate270FlipH => (w - 1 - v, h - 1 - u),
    };
    let a = stored(crop.x, crop.y);
    let b = stored(crop.x + crop.width - 1, crop.y + crop.height - 1);
    let (x0, x1) = (a.0.min(b.0), a.0.max(b.0));
    let (y0, y1) = (a.1.min(b.1), a.1.max(b.1));
    Ok((x0, y0, x1 - x0 + 1, y1 - y0 + 1))
}

/// 已转到线性光的整图缓冲（RGBA f32）裁下一块。
fn crop_linear(
    (x, y, cw, ch): (u32, u32, u32, u32),
    (w, _h, linear): (u32, u32, Vec<f32>),
) -> (u32, u32, Vec<f32>) {
    // usize：超大 CMYK／HDR 原图的偏移会超出 u32。
    let (w, x, width) = (w as usize, x as usize, cw as usize);
    let mut out = Vec::with_capacity(width * ch as usize * 4);
    for row in y as usize..(y + ch) as usize {
        let start = (row * w + x) * 4;
        out.extend_from_slice(&linear[start..start + width * 4]);
    }
    (cw, ch, out)
}

/// 派生图的存储色彩空间。
fn output_profile(space: Space, inspection: &Inspection) -> Result<ColorProfile, String> {
    Ok(match space {
        Space::Srgb => ColorProfile::new_srgb(),
        Space::SourceIcc => inspection.profile.clone().ok_or("缺少来源 ICC")?,
        Space::DisplayP3 => profiles::display_p3(),
    })
}

fn options() -> TransformOptions {
    TransformOptions {
        rendering_intent: RenderingIntent::Perceptual,
        ..TransformOptions::default()
    }
}

/// 预乘 alpha 的 Lanczos3 缩放（在传入像素所在的空间里）；不放大，原图不比 `max_width` 宽时为 `None`。
/// 直接借用传入的缓冲，不另存一份整图大小的像素副本。
fn resize(image: &Rgba32FImage, max_width: u32) -> Result<Option<Rgba32FImage>, String> {
    let (w, h) = image.dimensions();
    if w <= max_width {
        return Ok(None);
    }
    let tw = max_width;
    let th = ((h as f64) * (tw as f64) / (w as f64)).round().max(1.0) as u32;
    let src = fr::images::ImageRef::new(
        w,
        h,
        bytemuck::cast_slice(image.as_raw()),
        fr::PixelType::F32x4,
    )
    .map_err(|e| e.to_string())?;
    let mut dst = fr::images::Image::new(tw, th, fr::PixelType::F32x4);
    Resizer::new()
        .resize(
            &src,
            &mut dst,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(fr::FilterType::Lanczos3)),
        )
        .map_err(|e| e.to_string())?;
    let typed = dst
        .typed_image::<fr::pixels::F32x4>()
        .ok_or("缩放结果类型不符")?;
    let raw: Vec<f32> = typed.pixels().iter().flat_map(|p| p.0).collect();
    Rgba32FImage::from_raw(tw, th, raw)
        .map(Some)
        .ok_or_else(|| "缩放结果尺寸不符".into())
}

/// 线性光工作空间 → 存储空间（编码值，0～1）。
fn to_output(
    linear: &[f32],
    working: &ColorProfile,
    output: &ColorProfile,
) -> Result<Vec<f32>, String> {
    let mut out = vec![0f32; linear.len()];
    working
        .create_transform_f32(Layout::Rgba, output, Layout::Rgba, options())
        .map_err(|e| format!("无法建立色彩转换：{e:?}"))?
        .transform(linear, &mut out)
        .map_err(|e| format!("色彩转换失败：{e:?}"))?;
    Ok(out)
}

/// 量化（四舍五入、不抖动，保证可重复）并编码。
fn encode(
    pixels: &[f32],
    w: u32,
    h: u32,
    alpha: bool,
    container: Container,
    icc: Option<Vec<u8>>,
) -> Result<Vec<u8>, String> {
    let channels = if alpha { 4 } else { 3 };
    let samples = pixels
        .chunks_exact(4)
        .flat_map(|p| p[..channels].iter().map(|v| v.clamp(0.0, 1.0)));
    let mut out = Vec::new();
    match container {
        Container::WebP => {
            let data: Vec<u8> = samples.map(|v| (v * 255.0).round() as u8).collect();
            let mut encoder = WebPEncoder::new_lossless(&mut out);
            if let Some(icc) = icc {
                encoder.set_icc_profile(icc).map_err(|e| e.to_string())?;
            }
            let color = if alpha {
                ExtendedColorType::Rgba8
            } else {
                ExtendedColorType::Rgb8
            };
            encoder
                .write_image(&data, w, h, color)
                .map_err(|e| e.to_string())?;
        }
        Container::Png16 => {
            // `image` 的 PNG 编码器按本机字节序接收 16 位样本。
            let data: Vec<u8> = samples
                .flat_map(|v| ((v * 65535.0).round() as u16).to_ne_bytes())
                .collect();
            let mut encoder = PngEncoder::new(&mut out);
            if let Some(icc) = icc {
                encoder.set_icc_profile(icc).map_err(|e| e.to_string())?;
            }
            let color = if alpha {
                ExtendedColorType::Rgba16
            } else {
                ExtendedColorType::Rgb16
            };
            encoder
                .write_image(&data, w, h, color)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(out)
}
