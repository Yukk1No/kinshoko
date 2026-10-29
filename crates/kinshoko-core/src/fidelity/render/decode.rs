//! 解码与转到线性光工作空间：来源色彩声明 → 配置文件，CMYK 与 HDR（PQ／HLG 色调映射）。

use super::*;

/// 解码并转到线性光工作空间，返回存储方向下的 RGBA f32。
pub(super) fn decode_linear(
    bytes: &[u8],
    inspection: &Inspection,
    working: &ColorProfile,
) -> Result<(u32, u32, Vec<f32>), String> {
    decode_linear_crop(bytes, inspection, working, None)
}

/// [`decode_linear`]；给了 `crop` 时只返回那一块（存储方向）。
/// 普通 RGB／灰度在色彩转换之前就裁下（转换逐像素，结果相同）；CMYK 与 HDR 色调映射转换整图后再裁。
pub(super) fn decode_linear_crop(
    bytes: &[u8],
    inspection: &Inspection,
    working: &ColorProfile,
    crop: Option<UprightCrop>,
) -> Result<(u32, u32, Vec<f32>), String> {
    let d = &inspection.description;
    let special = if d.colour_model == ColourModel::Cmyk {
        Some(cmyk_linear(bytes, inspection, working)?)
    } else if let Some(cicp) = d
        .cicp
        .filter(|c| d.declaration == ColourDeclaration::Cicp && matches!(c.transfer, 16 | 18))
    {
        Some(hdr_linear(bytes, inspection, cicp, working)?)
    } else {
        None
    };
    if let Some(decoded) = special {
        return match crop {
            Some(c) => Ok(crop_linear(
                stored_rect(inspection.orientation, (decoded.0, decoded.1), c)?,
                decoded,
            )),
            None => Ok(decoded),
        };
    }

    let mut image = decode_first_frame(bytes, inspection)?;
    if let Some(c) = crop {
        let (x, y, cw, ch) =
            stored_rect(inspection.orientation, (image.width(), image.height()), c)?;
        image = image.crop_imm(x, y, cw, ch);
    }
    let (w, h) = (image.width(), image.height());
    let source = source_profile(inspection)?;
    let gray = source.color_space == DataColorSpace::Gray;
    // 灰度配置文件：灰度＋alpha 进，RGBA 出。
    let layout = if gray {
        Layout::GrayAlpha
    } else {
        Layout::Rgba
    };
    let transform = source
        .create_transform_f32(layout, working, Layout::Rgba, options())
        .map_err(|e| format!("无法建立色彩转换：{e:?}"))?;
    let mut out = vec![0f32; w as usize * h as usize * 4];
    // 按行分段转成 f32 再做色彩转换（逐像素，结果与整图一次转换相同）：
    // 不同时存在一份整图大小的 f32 源副本（#165）。
    let rows = band_rows(w);
    for (band, dst) in out
        .chunks_mut((rows as usize * w as usize * 4).max(1))
        .enumerate()
    {
        let y = band as u32 * rows;
        let band_h = rows.min(h - y);
        let part = image.crop_imm(0, y, w, band_h);
        let src = if gray {
            part.to_luma_alpha32f().into_raw()
        } else {
            part.to_rgba32f().into_raw()
        };
        transform
            .transform(&src, dst)
            .map_err(|e| format!("色彩转换失败：{e:?}"))?;
    }
    Ok((w, h, out))
}

/// 分段色彩转换每段的行数：64 行的整数倍（每段像素数是 64 的倍数，与整图一次转换的分组对齐），
/// 每段约一百万像素。
pub(super) fn band_rows(width: u32) -> u32 {
    const BAND_PIXELS: u32 = 1 << 20;
    (BAND_PIXELS / width.max(1)).max(1).div_ceil(64) * 64
}

/// 动图首帧（APNG 的默认图不在动画里时取第一个动画帧），其余为普通解码。
pub(super) fn decode_first_frame(
    bytes: &[u8],
    inspection: &Inspection,
) -> Result<DynamicImage, String> {
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
pub(super) fn source_profile(inspection: &Inspection) -> Result<ColorProfile, String> {
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

pub(super) fn cicp_profile(primaries: u8, transfer: u8) -> Result<ColorProfile, String> {
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
pub(super) fn cmyk_linear(
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
pub(super) const REFERENCE_WHITE_NITS: f32 = 203.0;
/// 色调映射的拐点：低于它的亮度线性保留。
pub(super) const KNEE: f32 = 0.8;

/// PQ／HLG：按传递函数还原成绝对亮度，色调映射到 SDR，再从来源原色转到工作空间。
pub(super) fn hdr_linear(
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
pub(super) fn pq_eotf(v: f32) -> f32 {
    let (m1, m2, c1, c2, c3) = (0.159_301_76, 78.843_75, 0.835_937_5, 18.851_563, 18.6875);
    let p = v.clamp(0.0, 1.0).powf(1.0 / m2);
    10_000.0 * ((p - c1).max(0.0) / (c2 - c3 * p)).powf(1.0 / m1)
}

/// ARIB STD-B67：编码值 → 场景线性 → 1000 尼特显示（系统 gamma 1.2）。
pub(super) fn hlg_display(v: [f32; 3], luma: [f32; 3]) -> [f32; 3] {
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
pub(super) fn tone_map(rgb: [f32; 3], peak: f32) -> [f32; 3] {
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
