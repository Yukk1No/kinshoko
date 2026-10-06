//! 读取原图的容器信息：格式、尺寸、方向，以及按 Chromium 规则排定的色彩声明。
//! 只读文件头与元数据块，像素在 [`super::render`] 里才解码。

use std::io::Cursor;

use image::{ImageDecoder, ImageFormat, ImageReader, metadata::Orientation};
use moxcms::{ColorProfile, DataColorSpace};
use sha2::{Digest, Sha256};

use super::description::{
    Cicp, ColourDeclaration, ColourDescription, ColourModel, HdrKind, IccKind, IccSummary,
};

/// 原图的检查结果。`description` 写入资料库，其余字段供派生图管线使用。
pub(crate) struct Inspection {
    pub format: ImageFormat,
    /// 按 EXIF 方向转正后的尺寸。
    pub width: u32,
    pub height: u32,
    pub orientation: Orientation,
    pub description: ColourDescription,
    /// 生效的 ICC 配置文件及其原字节（被 Chromium 规则忽略的不在这里）。
    pub profile: Option<ColorProfile>,
    pub icc: Option<Vec<u8>>,
    /// PNG gAMA（编码 gamma，例如 0.45455）。
    pub gamma: Option<f32>,
    /// PNG cHRM：白点与红绿蓝的 xy。
    pub chromaticities: Option<[(f32, f32); 4]>,
    /// HDR 内容的峰值亮度（尼特），取自 cLLI 或 mDCV。
    pub peak_nits: Option<f32>,
    /// JPEG 带 Adobe APP14 标记（CMYK 采样按反相存储）。
    pub adobe: bool,
    /// APNG 的默认图不是动画首帧（IDAT 前没有 fcTL）。
    pub apng_hidden_default: bool,
}

/// 不支持的格式返回 `Ok(None)`；能识别格式但读不了时返回错误说明。
pub(crate) fn inspect(bytes: &[u8]) -> Result<Option<Inspection>, String> {
    let format = match image::guess_format(bytes) {
        Ok(f @ (ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP | ImageFormat::Gif)) => f,
        _ => return Ok(None),
    };
    let mut reader = ImageReader::new(Cursor::new(bytes));
    reader.set_format(format);
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let (w, h) = decoder.dimensions();
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let alpha = decoder.color_type().has_alpha();
    let (width, height) = match orientation {
        Orientation::Rotate90
        | Orientation::Rotate270
        | Orientation::Rotate90FlipH
        | Orientation::Rotate270FlipH => (h, w),
        _ => (w, h),
    };
    drop(decoder);

    let mut found = Found::default();
    match format {
        ImageFormat::Jpeg => jpeg(bytes, &mut found)?,
        ImageFormat::Png => png(bytes, &mut found)?,
        ImageFormat::WebP => webp(bytes, &mut found)?,
        _ => gif(bytes, &mut found)?,
    }

    let icc_summary = found.icc.as_deref().map(summarise);
    let parsed = found
        .icc
        .as_deref()
        .and_then(|icc| ColorProfile::new_from_slice(icc).ok());
    // Chromium 只接受与图像颜色模型匹配的配置文件，不匹配则丢弃按 sRGB 处理。
    let profile = parsed.filter(|p| {
        !found.ignore_icc
            && matches!(
                (found.model, p.color_space),
                (ColourModel::Rgb, DataColorSpace::Rgb)
                    | (
                        ColourModel::Gray,
                        DataColorSpace::Gray | DataColorSpace::Rgb
                    )
                    | (ColourModel::Cmyk, DataColorSpace::Cmyk)
            )
    });
    // ICC 里的 cicp 标签只用于识别 HDR；颜色仍按配置文件本身解释。
    let icc_cicp = profile.as_ref().and_then(|p| p.cicp).map(|c| Cicp {
        primaries: c.color_primaries as u8,
        transfer: c.transfer_characteristics as u8,
        matrix: c.matrix_coefficients as u8,
        full_range: c.full_range,
    });

    let declaration = if found.cicp_usable {
        ColourDeclaration::Cicp
    } else if profile.is_some() {
        ColourDeclaration::Icc
    } else if found.srgb_chunk {
        ColourDeclaration::Srgb
    } else if found.gamma.is_some() && found.chromaticities.is_some() {
        ColourDeclaration::GammaChromaticities
    } else if found.gamma.is_some() {
        ColourDeclaration::Gamma
    } else {
        ColourDeclaration::None
    };
    let cicp = found.cicp.or(icc_cicp);
    let transfer_hdr = match cicp.map(|c| c.transfer) {
        Some(16) => Some(HdrKind::Pq),
        Some(18) => Some(HdrKind::Hlg),
        _ => None,
    };
    let hdr = transfer_hdr.or(found.gain_map.then_some(HdrKind::GainMap));

    Ok(Some(Inspection {
        format,
        width,
        height,
        orientation,
        description: ColourDescription {
            format: format_name(format).into(),
            bit_depth: found.bit_depth,
            colour_model: found.model,
            declaration,
            icc: icc_summary,
            cicp,
            alpha: found.alpha.unwrap_or(alpha),
            orientation: orientation.to_exif(),
            hdr,
            hdr_metadata: found.peak_nits.is_some(),
            animated: found.animated,
        },
        icc: if declaration == ColourDeclaration::Icc {
            found.icc
        } else {
            None
        },
        profile: if declaration == ColourDeclaration::Icc {
            profile
        } else {
            None
        },
        gamma: found.gamma,
        chromaticities: found.chromaticities,
        peak_nits: found.peak_nits,
        adobe: found.adobe,
        apng_hidden_default: found.apng_hidden_default,
    }))
}

pub(crate) fn format_name(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Jpeg => "jpeg",
        ImageFormat::Png => "png",
        ImageFormat::Gif => "gif",
        _ => "webp",
    }
}

struct Found {
    bit_depth: u8,
    model: ColourModel,
    icc: Option<Vec<u8>>,
    ignore_icc: bool,
    /// 解码器报告的 alpha 不准时（GIF 一律报 RGBA）由容器给出。
    alpha: Option<bool>,
    cicp: Option<Cicp>,
    cicp_usable: bool,
    srgb_chunk: bool,
    gamma: Option<f32>,
    chromaticities: Option<[(f32, f32); 4]>,
    peak_nits: Option<f32>,
    gain_map: bool,
    adobe: bool,
    animated: bool,
    apng_hidden_default: bool,
}

impl Default for Found {
    fn default() -> Self {
        Found {
            bit_depth: 8,
            model: ColourModel::Rgb,
            icc: None,
            ignore_icc: false,
            alpha: None,
            cicp: None,
            cicp_usable: false,
            srgb_chunk: false,
            gamma: None,
            chromaticities: None,
            peak_nits: None,
            gain_map: false,
            adobe: false,
            animated: false,
            apng_hidden_default: false,
        }
    }
}

fn summarise(icc: &[u8]) -> IccSummary {
    let version = match icc.get(8..10) {
        Some(&[major, minor]) => format!("{major}.{}", minor >> 4),
        _ => "?".into(),
    };
    let kind = match ColorProfile::new_from_slice(icc) {
        Err(_) => IccKind::Invalid,
        Ok(p) if p.color_space == DataColorSpace::Gray => IccKind::Gray,
        Ok(p)
            if p.lut_a_to_b_perceptual.is_some()
                || p.lut_a_to_b_colorimetric.is_some()
                || p.lut_a_to_b_saturation.is_some()
                || p.color_space != DataColorSpace::Rgb =>
        {
            IccKind::Lut
        }
        Ok(_) => IccKind::Matrix,
    };
    IccSummary {
        sha256: Sha256::digest(icc)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        version,
        kind,
    }
}

/// 逐段读 JPEG 头（到 SOS 为止）：SOF、APP2 ICC、APP14 Adobe、增益图 XMP／ISO 21496-1。
fn jpeg(bytes: &[u8], found: &mut Found) -> Result<(), String> {
    const ICC: &[u8] = b"ICC_PROFILE\0";
    const XMP: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
    const ISO_GAIN_MAP: &[u8] = b"urn:iso:std:iso:ts:21496:-1\0";
    let mut icc_chunks: Vec<(u8, Vec<u8>)> = Vec::new();
    let mut i = 2;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = bytes[i + 1];
        if marker == 0xFF {
            i += 1;
            continue;
        }
        if marker == 0x01 || (0xD0..=0xD8).contains(&marker) {
            i += 2;
            continue;
        }
        if marker == 0xDA || marker == 0xD9 {
            break;
        }
        let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        let end = (i + 2 + len).min(bytes.len());
        let payload = bytes.get(i + 4..end).unwrap_or_default();
        match marker {
            0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => {
                if payload.len() >= 6 {
                    found.bit_depth = payload[0];
                    found.model = match payload[5] {
                        1 => ColourModel::Gray,
                        4 => ColourModel::Cmyk,
                        _ => ColourModel::Rgb,
                    };
                }
            }
            0xE2 if payload.starts_with(ICC) && payload.len() > ICC.len() + 2 => {
                icc_chunks.push((payload[ICC.len()], payload[ICC.len() + 2..].to_vec()));
            }
            0xE2 if payload.starts_with(ISO_GAIN_MAP) => found.gain_map = true,
            0xE1 if payload.starts_with(XMP) => {
                if contains(payload, b"hdrgm:") || contains(payload, b"hdrgm=") {
                    found.gain_map = true;
                }
            }
            0xEE if payload.starts_with(b"Adobe") => found.adobe = true,
            _ => {}
        }
        i = end;
    }
    if !icc_chunks.is_empty() {
        icc_chunks.sort_by_key(|(seq, _)| *seq);
        found.icc = Some(icc_chunks.into_iter().flat_map(|(_, c)| c).collect());
    }
    Ok(())
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// PNG：Chromium（Skia 的 Rust PNG 解码器）的优先级为 cICP（矩阵系数 0 且全范围）→ iCCP →
/// sRGB 块 → gAMA＋cHRM；只有 gAMA 时用 sRGB 原色；没有 gAMA 时忽略 cHRM。
fn png(bytes: &[u8], found: &mut Found) -> Result<(), String> {
    let decoder = png::Decoder::new(Cursor::new(bytes));
    let reader = decoder.read_info().map_err(|e| e.to_string())?;
    let info = reader.info();
    found.bit_depth = info.bit_depth as u8;
    found.model = match info.color_type {
        png::ColorType::Grayscale | png::ColorType::GrayscaleAlpha => ColourModel::Gray,
        _ => ColourModel::Rgb,
    };
    if info.color_type == png::ColorType::Indexed {
        found.bit_depth = 8;
    }
    found.icc = info.icc_profile.as_ref().map(|c| c.to_vec());
    if let Some(c) = info.coding_independent_code_points {
        let cicp = Cicp {
            primaries: c.color_primaries,
            transfer: c.transfer_function,
            matrix: c.matrix_coefficients,
            full_range: c.is_video_full_range_image,
        };
        found.cicp_usable =
            cicp.matrix == 0 && cicp.full_range && super::render::cicp_supported(cicp);
        found.cicp = Some(cicp);
    }
    found.srgb_chunk = info.srgb.is_some();
    if let Some(g) = info.gama_chunk {
        let g = g.into_value();
        if g > 0.0 {
            found.gamma = Some(g);
            found.chromaticities = info.chrm_chunk.map(|c| {
                [c.white, c.red, c.green, c.blue].map(|(x, y)| (x.into_value(), y.into_value()))
            });
        }
    }
    let cll = info
        .content_light_level
        .map(|c| c.max_content_light_level as f32 / 10_000.0)
        .filter(|&n| n > 0.0);
    let mdcv = info
        .mastering_display_color_volume
        .map(|m| m.max_luminance as f32 / 10_000.0)
        .filter(|&n| n > 0.0);
    found.peak_nits = cll.or(mdcv);
    if let Some(actl) = info.animation_control {
        found.animated = actl.num_frames > 1;
        found.apng_hidden_default = info.frame_control.is_none();
    }
    Ok(())
}

/// WebP：静态图读 ICCP 且只接受 RGB 配置文件；Chromium 丢弃动图的 ICC。
fn webp(bytes: &[u8], found: &mut Found) -> Result<(), String> {
    let mut decoder =
        image::codecs::webp::WebPDecoder::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    found.animated = decoder.has_animation();
    found.icc = decoder.icc_profile().map_err(|e| e.to_string())?;
    // 动图的 ICC 仍记录在描述里，但不生效。
    found.ignore_icc = found.animated;
    Ok(())
}

/// GIF：Chromium 不读 GIF 的色彩声明，一律按 sRGB。alpha 看首帧有没有透明色。
fn gif(bytes: &[u8], found: &mut Found) -> Result<(), String> {
    let mut options = gif::DecodeOptions::new();
    options.set_color_output(gif::ColorOutput::Indexed);
    let mut decoder = options
        .read_info(Cursor::new(bytes))
        .map_err(|e| e.to_string())?;
    let first = decoder
        .next_frame_info()
        .map_err(|e| e.to_string())?
        .ok_or("GIF 没有帧")?;
    found.alpha = Some(first.transparent.is_some());
    found.animated = decoder
        .next_frame_info()
        .map_err(|e| e.to_string())?
        .is_some();
    Ok(())
}
