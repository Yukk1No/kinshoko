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
    Rgba32FImage,
};
use moxcms::{
    CicpColorPrimaries, CicpProfile, ColorPrimaries, ColorProfile, DataColorSpace, Layout,
    MatrixCoefficients, RenderingIntent, TransferCharacteristics, TransformOptions, XyY,
    curve_from_gamma,
};

use super::description::{Cicp, ColourDeclaration, ColourDescription, ColourModel, IccKind};
use super::inspect::{Inspection, inspect};
use super::profiles;

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
pub fn render_sdr(
    bytes: &[u8],
    max_width: u32,
    downscale: Downscale,
) -> Result<SdrDerivative, String> {
    let inspection = inspect(bytes)?.ok_or("不支持的格式")?;
    let d = &inspection.description;
    let space = space(d);
    let container = container(d);

    let output = output_profile(space, &inspection)?;
    let working = profiles::linear_of(&output);

    let (w, h, mut linear) = decode_linear(bytes, &inspection, &working)?;
    // 转正方向。
    let mut upright = DynamicImage::ImageRgba32F(
        Rgba32FImage::from_raw(w, h, std::mem::take(&mut linear)).ok_or("像素缓冲尺寸不符")?,
    );
    upright.apply_orientation(inspection.orientation);
    let upright = upright.into_rgba32f();

    let encoded = match downscale {
        Downscale::LinearLight => {
            let resized = resize(upright, max_width)?;
            let (w, h) = resized.dimensions();
            (w, h, to_output(resized.into_raw(), &working, &output)?)
        }
        Downscale::EncodedValue => {
            let (w, h) = upright.dimensions();
            let values = to_output(upright.into_raw(), &working, &output)?;
            let values = Rgba32FImage::from_raw(w, h, values).ok_or("像素缓冲尺寸不符")?;
            let resized = resize(values, max_width)?;
            let (w, h) = resized.dimensions();
            (w, h, resized.into_raw())
        }
    };
    let (w, h, encoded) = encoded;

    let icc = match space {
        Space::Srgb => None,
        Space::SourceIcc => inspection.icc.clone(),
        Space::DisplayP3 => Some(profiles::display_p3_icc()),
    };
    let alpha = d.alpha;
    let bytes = encode(&encoded, w, h, alpha, container, icc)?;
    Ok(SdrDerivative {
        bytes,
        mime: container.mime(),
        width: w,
        height: h,
    })
}

/// 原尺寸显示源 → 剪贴板用的无配置文件 sRGB RGBA8。共用来源声明、首帧、色调映射和方向解码。
/// 不进行缩放；arboard 的图片接口不能携带 ICC，因此必须转换颜色，不能把 P3／ICC 数值当成 sRGB。
pub(crate) fn clipboard_rgba(bytes: &[u8]) -> Result<image::RgbaImage, String> {
    let inspection = inspect(bytes)?.ok_or("不支持的格式")?;
    let srgb = ColorProfile::new_srgb();
    let working = profiles::linear_of(&srgb);
    let (w, h, linear) = decode_linear(bytes, &inspection, &working)?;
    let encoded = to_output(linear, &working, &srgb)?;
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

/// 派生图的存储色彩空间。
fn output_profile(space: Space, inspection: &Inspection) -> Result<ColorProfile, String> {
    Ok(match space {
        Space::Srgb => ColorProfile::new_srgb(),
        Space::SourceIcc => inspection.profile.clone().ok_or("缺少来源 ICC")?,
        Space::DisplayP3 => profiles::display_p3(),
    })
}

/// 按派生图管线完整解码一遍像素（同样的解码与色彩转换），确认原图真能显示。
/// 文件头有效、压缩像素却损坏的原图在这里失败；导入在暂存与发布之前调用。
pub(crate) fn verify_pixels(bytes: &[u8], inspection: &Inspection) -> Result<(), String> {
    let output = output_profile(space(&inspection.description), inspection)?;
    decode_linear(bytes, inspection, &profiles::linear_of(&output)).map(|_| ())
}

fn options() -> TransformOptions {
    TransformOptions {
        rendering_intent: RenderingIntent::Perceptual,
        ..TransformOptions::default()
    }
}

/// 解码并转到线性光工作空间，返回存储方向下的 RGBA f32。
fn decode_linear(
    bytes: &[u8],
    inspection: &Inspection,
    working: &ColorProfile,
) -> Result<(u32, u32, Vec<f32>), String> {
    let d = &inspection.description;
    if d.colour_model == ColourModel::Cmyk {
        return cmyk_linear(bytes, inspection, working);
    }
    if let Some(cicp) = d
        .cicp
        .filter(|c| d.declaration == ColourDeclaration::Cicp && matches!(c.transfer, 16 | 18))
    {
        return hdr_linear(bytes, inspection, cicp, working);
    }

    let image = decode_first_frame(bytes, inspection)?;
    let (w, h) = (image.width(), image.height());
    let source = source_profile(inspection)?;
    if source.color_space == DataColorSpace::Gray {
        // 灰度配置文件：灰度＋alpha 进，RGBA 出。
        let gray = image.to_luma_alpha32f().into_raw();
        let transform = source
            .create_transform_f32(Layout::GrayAlpha, working, Layout::Rgba, options())
            .map_err(|e| format!("无法建立色彩转换：{e:?}"))?;
        let mut out = vec![0f32; (w * h * 4) as usize];
        transform
            .transform(&gray, &mut out)
            .map_err(|e| format!("色彩转换失败：{e:?}"))?;
        return Ok((w, h, out));
    }
    let rgba = image.to_rgba32f().into_raw();
    let mut out = vec![0f32; rgba.len()];
    let transform = source
        .create_transform_f32(Layout::Rgba, working, Layout::Rgba, options())
        .map_err(|e| format!("无法建立色彩转换：{e:?}"))?;
    transform
        .transform(&rgba, &mut out)
        .map_err(|e| format!("色彩转换失败：{e:?}"))?;
    Ok((w, h, out))
}

/// 动图首帧（APNG 的默认图不在动画里时取第一个动画帧），其余为普通解码。
fn decode_first_frame(bytes: &[u8], inspection: &Inspection) -> Result<DynamicImage, String> {
    if inspection.format == ImageFormat::Png && inspection.apng_hidden_default {
        let decoder =
            image::codecs::png::PngDecoder::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
        let frame = decoder
            .apng()
            .map_err(|e| e.to_string())?
            .into_frames()
            .next()
            .ok_or("APNG 没有帧")?
            .map_err(|e| e.to_string())?;
        return Ok(DynamicImage::ImageRgba8(frame.into_buffer()));
    }
    let mut reader = ImageReader::new(Cursor::new(bytes));
    reader.set_format(inspection.format);
    reader.no_limits();
    reader.decode().map_err(|e| e.to_string())
}

/// 按 Chromium 的优先级取得来源色彩配置文件（HDR 传递函数与 CMYK 另行处理）。
fn source_profile(inspection: &Inspection) -> Result<ColorProfile, String> {
    let d = &inspection.description;
    Ok(match d.declaration {
        ColourDeclaration::None | ColourDeclaration::Srgb => ColorProfile::new_srgb(),
        ColourDeclaration::Icc => inspection.profile.clone().ok_or("缺少 ICC")?,
        ColourDeclaration::Cicp => {
            let c = d.cicp.ok_or("缺少 cICP")?;
            cicp_profile(c.primaries, c.transfer)?
        }
        ColourDeclaration::Gamma | ColourDeclaration::GammaChromaticities => {
            let gamma = inspection.gamma.ok_or("缺少 gAMA")?;
            let mut p = ColorProfile::new_srgb();
            if let (ColourDeclaration::GammaChromaticities, Some([white, r, g, b])) =
                (d.declaration, inspection.chromaticities)
            {
                let c = |(x, y): (f32, f32)| moxcms::Chromaticity::new(x, y);
                p.update_rgb_colorimetry(
                    XyY {
                        x: white.0 as f64,
                        y: white.1 as f64,
                        yb: 1.0,
                    },
                    ColorPrimaries {
                        red: c(r),
                        green: c(g),
                        blue: c(b),
                    },
                );
            }
            // gAMA 记的是编码 gamma；解码指数是它的倒数。
            let curve = curve_from_gamma(1.0 / gamma);
            p.red_trc = Some(curve.clone());
            p.green_trc = Some(curve.clone());
            p.blue_trc = Some(curve);
            p.cicp = None;
            p
        }
    })
}

fn cicp_profile(primaries: u8, transfer: u8) -> Result<ColorProfile, String> {
    let primaries = CicpColorPrimaries::try_from(primaries).map_err(|e| format!("{e:?}"))?;
    let transfer = TransferCharacteristics::try_from(transfer).map_err(|e| format!("{e:?}"))?;
    let mut p = ColorProfile::new_from_cicp(CicpProfile {
        color_primaries: primaries,
        transfer_characteristics: transfer,
        matrix_coefficients: MatrixCoefficients::Bt709,
        full_range: true,
    });
    p.cicp = None;
    Ok(p)
}

/// CMYK／YCCK JPEG：取原始采样。有 CMYK 配置文件时交给 moxcms（Adobe 标记表示反相存储）；
/// 没有时按 Chromium 的朴素公式 `R = C·K/255`（存储值）转为 sRGB。
fn cmyk_linear(
    bytes: &[u8],
    inspection: &Inspection,
    working: &ColorProfile,
) -> Result<(u32, u32, Vec<f32>), String> {
    use zune_core::bytestream::ZCursor;
    use zune_core::colorspace::ColorSpace;
    use zune_core::options::DecoderOptions;

    let mut probe = zune_jpeg::JpegDecoder::new(ZCursor::new(bytes));
    probe.decode_headers().map_err(|e| e.to_string())?;
    let input = probe.input_colorspace().ok_or("JPEG 头缺少颜色空间")?;
    let decoder_options = DecoderOptions::default()
        .set_max_width(usize::MAX)
        .set_max_height(usize::MAX)
        .jpeg_set_out_colorspace(input);
    let mut decoder =
        zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(bytes), decoder_options);
    let raw = decoder.decode().map_err(|e| e.to_string())?;
    let info = decoder.info().ok_or("JPEG 头缺少尺寸")?;
    let (w, h) = (info.width as u32, info.height as u32);

    // 存储值（0～255）：YCCK 先把 YCbCr 还原成（反相的）CMY。
    let stored: Vec<[f32; 4]> = raw
        .chunks_exact(4)
        .map(|p| {
            let [a, b, c, k] = [p[0], p[1], p[2], p[3]].map(f32::from);
            if input == ColorSpace::YCCK {
                let (y, cb, cr) = (a, b - 128.0, c - 128.0);
                let r = (y + 1.402 * cr).round().clamp(0.0, 255.0);
                let g = (y - 0.344_136 * cb - 0.714_136 * cr)
                    .round()
                    .clamp(0.0, 255.0);
                let bl = (y + 1.772 * cb).round().clamp(0.0, 255.0);
                [255.0 - r, 255.0 - g, 255.0 - bl, k]
            } else {
                [a, b, c, k]
            }
        })
        .collect();

    let mut out = vec![0f32; (w * h * 4) as usize];
    match &inspection.profile {
        Some(profile) => {
            let inverted = inspection.adobe;
            let ink: Vec<f32> = stored
                .iter()
                .flat_map(|s| s.map(|v| if inverted { 1.0 - v / 255.0 } else { v / 255.0 }))
                .collect();
            let mut rgb = vec![0f32; (w * h * 3) as usize];
            profile
                .create_transform_f32(Layout::Rgba, working, Layout::Rgb, options())
                .map_err(|e| format!("无法建立 CMYK 转换：{e:?}"))?
                .transform(&ink, &mut rgb)
                .map_err(|e| format!("CMYK 转换失败：{e:?}"))?;
            for (o, p) in out.chunks_exact_mut(4).zip(rgb.chunks_exact(3)) {
                o.copy_from_slice(&[p[0], p[1], p[2], 1.0]);
            }
        }
        None => {
            let srgb: Vec<f32> = stored
                .iter()
                .flat_map(|[c, m, y, k]| {
                    [
                        c * k / 255.0 / 255.0,
                        m * k / 255.0 / 255.0,
                        y * k / 255.0 / 255.0,
                        1.0,
                    ]
                })
                .collect();
            ColorProfile::new_srgb()
                .create_transform_f32(Layout::Rgba, working, Layout::Rgba, options())
                .map_err(|e| format!("无法建立色彩转换：{e:?}"))?
                .transform(&srgb, &mut out)
                .map_err(|e| format!("色彩转换失败：{e:?}"))?;
        }
    }
    Ok((w, h, out))
}

/// SDR 参考白（BT.2408）：HDR 中 203 尼特对应 SDR 的 1.0 附近。
const REFERENCE_WHITE_NITS: f32 = 203.0;
/// 色调映射的拐点：低于它的亮度线性保留。
const KNEE: f32 = 0.8;

/// PQ／HLG：按传递函数还原成绝对亮度，色调映射到 SDR，再从来源原色转到工作空间。
fn hdr_linear(
    bytes: &[u8],
    inspection: &Inspection,
    cicp: Cicp,
    working: &ColorProfile,
) -> Result<(u32, u32, Vec<f32>), String> {
    let image = decode_first_frame(bytes, inspection)?;
    let (w, h) = (image.width(), image.height());
    let mut rgba = image.to_rgba32f().into_raw();
    let peak = inspection
        .peak_nits
        .unwrap_or(1000.0)
        .max(REFERENCE_WHITE_NITS);
    let source = profiles::linear_of(&cicp_profile(cicp.primaries, 13)?);
    let to_xyz = source.rgb_to_xyz_matrix();
    for px in rgba.chunks_exact_mut(4) {
        let nits: [f32; 3] = if cicp.transfer == 16 {
            [px[0], px[1], px[2]].map(pq_eotf)
        } else {
            hlg_display(
                [px[0], px[1], px[2]],
                [to_xyz.v[1][0], to_xyz.v[1][1], to_xyz.v[1][2]].map(|v| v as f32),
            )
        };
        let rel = nits.map(|n| n / REFERENCE_WHITE_NITS);
        let mapped = tone_map(rel, peak / REFERENCE_WHITE_NITS);
        px[..3].copy_from_slice(&mapped);
    }
    let mut out = vec![0f32; rgba.len()];
    source
        .create_transform_f32(Layout::Rgba, working, Layout::Rgba, options())
        .map_err(|e| format!("无法建立色彩转换：{e:?}"))?
        .transform(&rgba, &mut out)
        .map_err(|e| format!("色彩转换失败：{e:?}"))?;
    Ok((w, h, out))
}

/// SMPTE ST 2084：编码值 → 尼特。
fn pq_eotf(v: f32) -> f32 {
    let (m1, m2, c1, c2, c3) = (0.159_301_76, 78.843_75, 0.835_937_5, 18.851_563, 18.6875);
    let p = v.clamp(0.0, 1.0).powf(1.0 / m2);
    10_000.0 * ((p - c1).max(0.0) / (c2 - c3 * p)).powf(1.0 / m1)
}

/// ARIB STD-B67：编码值 → 场景线性 → 1000 尼特显示（系统 gamma 1.2）。
fn hlg_display(v: [f32; 3], luma: [f32; 3]) -> [f32; 3] {
    let (a, b, c) = (0.178_832_77, 0.284_668_92, 0.559_910_7);
    let scene = v.map(|e| {
        let e = e.clamp(0.0, 1.0);
        if e <= 0.5 {
            e * e / 3.0
        } else {
            (((e - c) / a).exp() + b) / 12.0
        }
    });
    let y = (luma[0] * scene[0] + luma[1] * scene[1] + luma[2] * scene[2]).max(0.0);
    let gain = 1000.0 * y.powf(0.2);
    scene.map(|s| s * gain)
}

/// 色调映射：以最大通道计，拐点以下线性，以上用扩展 Reinhard 压到 1.0，保持色相。
/// `peak` 是内容峰值相对参考白的倍数。
fn tone_map(rgb: [f32; 3], peak: f32) -> [f32; 3] {
    let m = rgb[0].max(rgb[1]).max(rgb[2]);
    if m <= KNEE {
        return rgb;
    }
    let max_excess = ((peak - KNEE) / (1.0 - KNEE)).max(1.0);
    let e = (m - KNEE) / (1.0 - KNEE);
    let y = KNEE + (1.0 - KNEE) * e * (1.0 + e / (max_excess * max_excess)) / (1.0 + e);
    let scale = y.min(1.0) / m;
    rgb.map(|v| v * scale)
}

/// 预乘 alpha 的 Lanczos3 缩放（在传入像素所在的空间里）；不放大。
fn resize(image: Rgba32FImage, max_width: u32) -> Result<Rgba32FImage, String> {
    let (w, h) = image.dimensions();
    if w <= max_width {
        return Ok(image);
    }
    let tw = max_width;
    let th = ((h as f64) * (tw as f64) / (w as f64)).round().max(1.0) as u32;
    let pixels: Vec<fr::pixels::F32x4> = image
        .into_raw()
        .chunks_exact(4)
        .map(|p| fr::pixels::F32x4::new([p[0], p[1], p[2], p[3]]))
        .collect();
    let src = fr::images::ImageRef::from_pixels(w, h, &pixels).map_err(|e| e.to_string())?;
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
    Rgba32FImage::from_raw(tw, th, raw).ok_or_else(|| "缩放结果尺寸不符".into())
}

/// 线性光工作空间 → 存储空间（编码值，0～1）。
fn to_output(
    linear: Vec<f32>,
    working: &ColorProfile,
    output: &ColorProfile,
) -> Result<Vec<f32>, String> {
    let mut out = vec![0f32; linear.len()];
    working
        .create_transform_f32(Layout::Rgba, output, Layout::Rgba, options())
        .map_err(|e| format!("无法建立色彩转换：{e:?}"))?
        .transform(&linear, &mut out)
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
