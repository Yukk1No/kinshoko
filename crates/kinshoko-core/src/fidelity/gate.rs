//! 还原度门槛样本（核查“尚未验证”一节、#45 验收）。
//!
//! 每个样本带若干纯色色块：`x/y/width/height` 是转正后原图上的像素区域（已留出边距，避开缩放振铃），
//! `lab` 是按样本自身色彩声明算出的 CIE Lab（D50）。同一组样本用于：
//! - `cargo test`：缩略图色块与 `lab` 的 ΔE2000；
//! - 门槛实验：在 WebView2 里分别解码原图与缩略图，读回 `display-p3` canvas 比较。
//!
//! 样本完全由代码生成、字节固定，可在任何机器上重新生成；`sha256` 记录在验收约定里。

use std::io::Cursor;

use image::metadata::Orientation;
use image::{DynamicImage, ImageEncoder, RgbImage, RgbaImage};
use moxcms::{ColorProfile, Layout, ProfileVersion, TransformOptions};
use serde::Serialize;
use ts_rs::TS;

use super::profiles;

/// 一个门槛样本。
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GateSample {
    /// 文件名，同时说明样本内容，例如 `p3-v4.jpg`。
    pub file_name: String,
    /// 门槛分组，对应核查“尚未验证”一节的实验编号。
    pub group: String,
    /// 中文说明。
    pub note: String,
    /// 是否计入 ΔE2000 门槛。HDR 色调映射、细线等只记录结果、由画师目视。
    pub gated: bool,
    #[serde(skip)]
    #[ts(skip)]
    pub bytes: Vec<u8>,
    pub patches: Vec<Patch>,
}

/// 样本上的一个纯色色块。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Patch {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// 按样本色彩声明算出的 CIE Lab（D50）。
    pub lab: [f32; 3],
    /// 不透明度 0～1。
    pub alpha: f32,
}

const W: u32 = 384;
const H: u32 = 256;
const COLS: u32 = 4;
const ROWS: u32 = 2;

/// RGB 样本的八个色块（设备值）：P3 等广色域下前三个超出 sRGB。
const RGB_PATCHES: [[u8; 3]; 8] = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [128, 128, 128],
    [230, 180, 150],
    [40, 90, 160],
    [250, 250, 250],
    [20, 20, 20],
];

/// CMYK 样本的八个色块（油墨量 0～255）。
const CMYK_PATCHES: [[u8; 4]; 8] = [
    [0, 255, 255, 0],
    [255, 0, 255, 0],
    [255, 255, 0, 0],
    [0, 0, 0, 128],
    [20, 60, 80, 0],
    [200, 120, 30, 40],
    [0, 0, 0, 0],
    [40, 40, 40, 220],
];

fn block(i: usize) -> (u32, u32, u32, u32) {
    let (bw, bh) = (W / COLS, H / ROWS);
    let (cx, cy) = (i as u32 % COLS, i as u32 / COLS);
    (cx * bw, cy * bh, bw, bh)
}

fn patch(i: usize, lab: [f32; 3], alpha: f32) -> Patch {
    let (x, y, w, h) = block(i);
    Patch {
        x: x + w / 4,
        y: y + h / 4,
        width: w / 2,
        height: h / 2,
        lab,
        alpha,
    }
}

/// 设备值经配置文件到 CIE Lab（D50）：先到线性 BT.2020（覆盖 P3 与 Adobe RGB），再按矩阵到 XYZ。
pub(crate) fn lab(profile: &ColorProfile, device: &[f32]) -> [f32; 3] {
    let wide = profiles::linear_of(&ColorProfile::new_bt2020());
    let (layout, channels) = match profile.color_space {
        moxcms::DataColorSpace::Cmyk => (Layout::Rgba, 4),
        moxcms::DataColorSpace::Gray => (Layout::Gray, 1),
        _ => (Layout::Rgb, 3),
    };
    let transform = profile
        .create_transform_f32(layout, &wide, Layout::Rgb, TransformOptions::default())
        .expect("样本配置文件可转换");
    let mut out = [0f32; 3];
    transform
        .transform(&device[..channels], &mut out)
        .expect("转换成功");
    let m = wide.rgb_to_xyz_matrix();
    let xyz = [0, 1, 2].map(|r| (0..3).map(|c| m.v[r][c] * out[c] as f64).sum::<f64>());
    xyz_d50_to_lab(xyz)
}

pub(crate) fn xyz_d50_to_lab(xyz: [f64; 3]) -> [f32; 3] {
    const WHITE: [f64; 3] = [0.9642, 1.0, 0.8249];
    let f = |t: f64| {
        if t > 216.0 / 24389.0 {
            t.cbrt()
        } else {
            (24389.0 / 27.0 * t + 16.0) / 116.0
        }
    };
    let [fx, fy, fz] = [0, 1, 2].map(|i| f(xyz[i] / WHITE[i]));
    [
        (116.0 * fy - 16.0) as f32,
        (500.0 * (fx - fy)) as f32,
        (200.0 * (fy - fz)) as f32,
    ]
}

fn unit(v: u8) -> f32 {
    v as f32 / 255.0
}

fn rgb_patches(profile: &ColorProfile) -> Vec<Patch> {
    RGB_PATCHES
        .iter()
        .enumerate()
        .map(|(i, c)| patch(i, lab(profile, &c.map(unit)), 1.0))
        .collect()
}

fn rgb_blocks() -> RgbImage {
    RgbImage::from_fn(W, H, |x, y| {
        let i = (y / (H / ROWS) * COLS + x / (W / COLS)) as usize;
        image::Rgb(RGB_PATCHES[i])
    })
}

/// 4:4:4、质量 100 的 JPEG；色块对齐 8×8，纯色块无损。
fn jpeg(
    data: &[u8],
    w: u32,
    h: u32,
    color: jpeg_encoder::ColorType,
    icc: Option<&[u8]>,
    app: &[(u8, Vec<u8>)],
) -> Vec<u8> {
    let mut out = Vec::new();
    let mut encoder = jpeg_encoder::Encoder::new(&mut out, 100);
    encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_4_4);
    for (nr, segment) in app {
        encoder
            .add_app_segment(*nr, segment.clone())
            .expect("APP 段合法");
    }
    if let Some(icc) = icc {
        encoder.add_icc_profile(icc).expect("ICC 可嵌入");
    }
    encoder
        .encode(data, w as u16, h as u16, color)
        .expect("JPEG 编码成功");
    out
}

/// PNG 编码。`extra` 是写在图像数据之前的附加块。
fn png(
    w: u32,
    h: u32,
    color: png::ColorType,
    depth: png::BitDepth,
    data: &[u8],
    configure: impl FnOnce(&mut png::Info),
    extra: &[(&[u8; 4], Vec<u8>)],
) -> Vec<u8> {
    let mut info = png::Info::with_size(w, h);
    info.color_type = color;
    info.bit_depth = depth;
    configure(&mut info);
    let mut out = Vec::new();
    {
        let encoder = png::Encoder::with_info(&mut out, info).expect("PNG 信息合法");
        let mut writer = encoder.write_header().expect("PNG 头可写");
        for (name, body) in extra {
            writer
                .write_chunk(png::chunk::ChunkType(**name), body)
                .expect("PNG 块可写");
        }
        writer.write_image_data(data).expect("PNG 数据可写");
    }
    out
}

fn to_u16_be(v: &[u16]) -> Vec<u8> {
    v.iter().flat_map(|s| s.to_be_bytes()).collect()
}

fn sample(
    file_name: &str,
    group: &str,
    note: &str,
    gated: bool,
    bytes: Vec<u8>,
    patches: Vec<Patch>,
) -> GateSample {
    GateSample {
        file_name: file_name.into(),
        group: group.into(),
        note: note.into(),
        gated,
        bytes,
        patches,
    }
}

/// 最小的 TIFF 结构 EXIF：只含方向一项（小端）。
pub(crate) fn exif_orientation(o: u16) -> Vec<u8> {
    let mut e = b"II*\0".to_vec();
    e.extend(8u32.to_le_bytes());
    e.extend(1u16.to_le_bytes());
    e.extend(0x0112u16.to_le_bytes());
    e.extend(3u16.to_le_bytes());
    e.extend(1u32.to_le_bytes());
    e.extend(o.to_le_bytes());
    e.extend([0, 0]);
    e.extend(0u32.to_le_bytes());
    e
}

/// 全部门槛样本，顺序固定。
pub fn samples() -> Vec<GateSample> {
    let mut all = Vec::new();
    let srgb = ColorProfile::new_srgb();
    let p3 = profiles::display_p3();
    let p3_icc = profiles::display_p3_icc();
    let blocks = rgb_blocks();

    // 实验 1：Display P3（ICC v4／v2）与 Adobe RGB 的 JPEG。
    all.push(sample(
        "p3-v4.jpg",
        "1",
        "Display P3 ICC v4 的 JPEG，前三块为 sRGB 以外的饱和红绿蓝",
        true,
        jpeg(
            blocks.as_raw(),
            W,
            H,
            jpeg_encoder::ColorType::Rgb,
            Some(&p3_icc),
            &[],
        ),
        rgb_patches(&p3),
    ));
    let mut p3_v2 = p3.clone();
    let lut: Vec<u16> = (0..1024)
        .map(|i| (profiles::srgb_eotf(i as f32 / 1023.0) * 65535.0).round() as u16)
        .collect();
    p3_v2.red_trc = Some(moxcms::ToneReprCurve::Lut(lut.clone()));
    p3_v2.green_trc = Some(moxcms::ToneReprCurve::Lut(lut.clone()));
    p3_v2.blue_trc = Some(moxcms::ToneReprCurve::Lut(lut));
    p3_v2.description = None;
    p3_v2.copyright = None;
    let p3_v2_icc = profiles::with_version(
        profiles::encode(&p3_v2).expect("可编码"),
        ProfileVersion::V2_1,
    );
    all.push(sample(
        "p3-v2.jpg",
        "1",
        "同一 Display P3，ICC v2（curv 曲线表）",
        true,
        jpeg(
            blocks.as_raw(),
            W,
            H,
            jpeg_encoder::ColorType::Rgb,
            Some(&p3_v2_icc),
            &[],
        ),
        rgb_patches(&p3_v2),
    ));
    let mut adobe = ColorProfile::new_adobe_rgb();
    adobe.cicp = None;
    let adobe_icc = profiles::encode(&adobe).expect("可编码");
    all.push(sample(
        "adobe-rgb.jpg",
        "1",
        "Adobe RGB (1998) 的 JPEG",
        true,
        jpeg(
            blocks.as_raw(),
            W,
            H,
            jpeg_encoder::ColorType::Rgb,
            Some(&adobe_icc),
            &[],
        ),
        rgb_patches(&adobe),
    ));

    // 实验 2：LUT 型 ICC，A2B0 与 A2B1 不同。Chromium 按 A2B0 优先。
    let p3_xyz = p3.rgb_to_xyz_matrix();
    let srgb_xyz = srgb.rgb_to_xyz_matrix();
    let through = |m: moxcms::Matrix3d| {
        move |d: [f64; 3]| {
            let lin = d.map(|v| profiles::srgb_eotf(v as f32) as f64);
            [0, 1, 2].map(|r| (0..3).map(|c| m.v[r][c] * lin[c]).sum::<f64>())
        }
    };
    let lut_profile = profiles::lut_rgb(33, through(p3_xyz), through(srgb_xyz));
    let lut_icc = profiles::encode(&lut_profile).expect("可编码");
    all.push(sample(
        "lut-a2b0.png",
        "2",
        "只有查找表的 ICC v4：A2B0 为 Display P3，A2B1 为 sRGB",
        true,
        png(
            W,
            H,
            png::ColorType::Rgb,
            png::BitDepth::Eight,
            blocks.as_raw(),
            |info| {
                info.icc_profile = Some(lut_icc.clone().into());
            },
            &[],
        ),
        rgb_patches(&lut_profile),
    ));
    // RGB 图配 CMYK 配置文件：颜色模型不符，Chromium 丢弃配置文件按 sRGB。
    // 合成 CMYK：油墨按减色混合后落在 Display P3 中，与朴素公式（sRGB）明显不同。
    let cmyk_profile = profiles::cmyk(9, |ink| {
        let rgb = [ink[0], ink[1], ink[2]].map(|c| (1.0 - c) * (1.0 - ink[3]));
        through(p3_xyz)(rgb)
    });
    let cmyk_icc = profiles::encode(&cmyk_profile).expect("可编码");
    all.push(sample(
        "icc-mismatch.jpg",
        "2",
        "RGB JPEG 嵌入 CMYK 配置文件：应忽略配置文件，按 sRGB",
        true,
        jpeg(
            blocks.as_raw(),
            W,
            H,
            jpeg_encoder::ColorType::Rgb,
            Some(&cmyk_icc),
            &[],
        ),
        rgb_patches(&srgb),
    ));

    // 实验 3：CMYK JPEG（合成的 CMYK 配置文件；FOGRA39 等不可再分发）。
    let cmyk_data: Vec<u8> = {
        let mut d = Vec::with_capacity((W * H * 4) as usize);
        for y in 0..H {
            for x in 0..W {
                let i = (y / (H / ROWS) * COLS + x / (W / COLS)) as usize;
                d.extend(CMYK_PATCHES[i]);
            }
        }
        d
    };
    let cmyk_lab: Vec<Patch> = CMYK_PATCHES
        .iter()
        .enumerate()
        .map(|(i, c)| patch(i, lab(&cmyk_profile, &c.map(unit)), 1.0))
        .collect();
    all.push(sample(
        "cmyk-profile.jpg",
        "3",
        "CMYK JPEG（Adobe 反相存储）带合成 CMYK 配置文件",
        true,
        jpeg(
            &cmyk_data,
            W,
            H,
            jpeg_encoder::ColorType::Cmyk,
            Some(&cmyk_icc),
            &[],
        ),
        cmyk_lab.clone(),
    ));
    all.push(sample(
        "ycck-profile.jpg",
        "3",
        "YCCK JPEG 带同一 CMYK 配置文件",
        true,
        jpeg(
            &cmyk_data,
            W,
            H,
            jpeg_encoder::ColorType::CmykAsYcck,
            Some(&cmyk_icc),
            &[],
        ),
        cmyk_lab,
    ));
    // 无配置文件：Chromium 用朴素公式 R = (255-C)(255-K)/255。
    let naive: Vec<Patch> = CMYK_PATCHES
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let rgb = [c[0], c[1], c[2]].map(|v| unit(255 - v) * unit(255 - c[3]));
            patch(i, lab(&srgb, &rgb), 1.0)
        })
        .collect();
    all.push(sample(
        "cmyk-naive.jpg",
        "3",
        "CMYK JPEG 无配置文件：按朴素公式转 sRGB",
        true,
        jpeg(&cmyk_data, W, H, jpeg_encoder::ColorType::Cmyk, None, &[]),
        naive,
    ));

    // 实验 4：PNG 色彩块组合。
    let gamma_profile = |gamma: f32, primaries: Option<&ColorProfile>| {
        let mut p = primaries.cloned().unwrap_or_else(ColorProfile::new_srgb);
        let curve = moxcms::curve_from_gamma(1.0 / gamma);
        p.red_trc = Some(curve.clone());
        p.green_trc = Some(curve.clone());
        p.blue_trc = Some(curve);
        p.cicp = None;
        p
    };
    for (name, gamma, note) in [
        (
            "gama-045455.png",
            0.45455f32,
            "只有 gAMA 0.45455：sRGB 原色加 2.2 次幂",
        ),
        ("gama-18.png", 1.0 / 1.8, "只有 gAMA 1/1.8"),
    ] {
        all.push(sample(
            name,
            "4",
            note,
            true,
            png(
                W,
                H,
                png::ColorType::Rgb,
                png::BitDepth::Eight,
                blocks.as_raw(),
                |info| {
                    info.source_gamma = Some(png::ScaledFloat::new(gamma));
                },
                &[],
            ),
            rgb_patches(&gamma_profile(gamma, None)),
        ));
    }
    let p3_chrm = png::SourceChromaticities::new(
        (0.3127, 0.3290),
        (0.680, 0.320),
        (0.265, 0.690),
        (0.150, 0.060),
    );
    all.push(sample(
        "gama-chrm-p3.png",
        "4",
        "gAMA 0.45455＋cHRM（P3 原色）",
        true,
        png(
            W,
            H,
            png::ColorType::Rgb,
            png::BitDepth::Eight,
            blocks.as_raw(),
            |info| {
                info.source_gamma = Some(png::ScaledFloat::new(0.45455));
                info.source_chromaticities = Some(p3_chrm);
            },
            &[],
        ),
        rgb_patches(&gamma_profile(0.45455, Some(&p3))),
    ));
    all.push(sample(
        "srgb-vs-gama.png",
        "4",
        "sRGB 块＋矛盾的 gAMA 1.0：按 sRGB 块",
        true,
        png(
            W,
            H,
            png::ColorType::Rgb,
            png::BitDepth::Eight,
            blocks.as_raw(),
            |info| {
                info.srgb = Some(png::SrgbRenderingIntent::Perceptual);
            },
            &[(b"gAMA", 100_000u32.to_be_bytes().to_vec())],
        ),
        rgb_patches(&srgb),
    ));
    all.push(sample(
        "cicp-p3.png",
        "4",
        "只有 cICP（Display P3：12/13/0/1）",
        true,
        png(
            W,
            H,
            png::ColorType::Rgb,
            png::BitDepth::Eight,
            blocks.as_raw(),
            |_| {},
            &[(b"cICP", vec![12, 13, 0, 1])],
        ),
        rgb_patches(&p3),
    ));
    all.push(sample(
        "cicp-over-iccp.png",
        "4",
        "cICP（Display P3）与 iCCP（Adobe RGB）并存：cICP 优先",
        true,
        png(
            W,
            H,
            png::ColorType::Rgb,
            png::BitDepth::Eight,
            blocks.as_raw(),
            |info| {
                info.icc_profile = Some(adobe_icc.clone().into());
            },
            &[(b"cICP", vec![12, 13, 0, 1])],
        ),
        rgb_patches(&p3),
    ));

    // 实验 5：16 位 PNG（Display P3 iCCP），色块之外是平滑渐变。
    let png16: Vec<u16> = {
        let mut d = Vec::with_capacity((W * H * 3) as usize);
        for y in 0..H {
            for x in 0..W {
                let i = (y / (H / ROWS) * COLS + x / (W / COLS)) as usize;
                let (bx, by, bw, bh) = block(i);
                let inside = x >= bx + bw / 8
                    && x < bx + bw * 7 / 8
                    && y >= by + bh / 8
                    && y < by + bh * 7 / 8;
                if inside {
                    d.extend(RGB_PATCHES[i].map(|v| v as u16 * 257));
                } else {
                    let g = (x * 65535 / (W - 1)) as u16;
                    d.extend([g, g, 65535 - g]);
                }
            }
        }
        d
    };
    all.push(sample(
        "png16-p3.png",
        "5",
        "16 位 PNG，Display P3 iCCP；色块间为平滑渐变",
        true,
        png(
            W,
            H,
            png::ColorType::Rgb,
            png::BitDepth::Sixteen,
            &to_u16_be(&png16),
            |info| {
                info.icc_profile = Some(p3_icc.clone().into());
            },
            &[],
        ),
        rgb_patches(&p3),
    ));
    let gray16: Vec<u16> = (0..W * H)
        .map(|i| ((i % W) * 65535 / (W - 1)) as u16)
        .collect();
    all.push(sample(
        "png16-gray-ramp.png",
        "5",
        "16 位灰度渐变：检查缩略图色带（只记录）",
        false,
        png(
            W,
            H,
            png::ColorType::Grayscale,
            png::BitDepth::Sixteen,
            &to_u16_be(&gray16),
            |_| {},
            &[],
        ),
        Vec::new(),
    ));
    let gray_icc = profiles::encode(&{
        let mut g = ColorProfile::new_gray_with_gamma(2.2);
        g.cicp = None;
        g
    })
    .expect("可编码");
    let gray_levels: [u8; 8] = [0, 32, 64, 96, 128, 160, 200, 255];
    let gray_profile = ColorProfile::new_from_slice(&gray_icc).expect("可解析");
    let gray_img: Vec<u8> = (0..W * H)
        .map(|p| {
            let (x, y) = (p % W, p / W);
            gray_levels[(y / (H / ROWS) * COLS + x / (W / COLS)) as usize]
        })
        .collect();
    all.push(sample(
        "gray-gamma22.jpg",
        "5",
        "灰度 JPEG，灰度 gamma 2.2 ICC",
        true,
        jpeg(
            &gray_img,
            W,
            H,
            jpeg_encoder::ColorType::Luma,
            Some(&gray_icc),
            &[],
        ),
        gray_levels
            .iter()
            .enumerate()
            .map(|(i, &v)| patch(i, lab(&gray_profile, &[unit(v)]), 1.0))
            .collect(),
    ));

    // 实验 6：细线与网点（只记录，由画师对照目视）。
    let lines = RgbImage::from_fn(W, H, |x, y| {
        let i = (y / (H / ROWS) * COLS + x / (W / COLS)) as usize;
        let v = match i {
            0 => {
                if x % 2 == 0 {
                    [0, 0, 0]
                } else {
                    [255, 255, 255]
                }
            }
            1 => {
                if y % 3 == 0 {
                    [0, 0, 0]
                } else {
                    [255, 255, 255]
                }
            }
            2 => {
                if (x + y) % 2 == 0 {
                    [0, 0, 0]
                } else {
                    [255, 255, 255]
                }
            }
            3 => {
                if x % 4 == 0 {
                    [220, 30, 30]
                } else {
                    [255, 255, 255]
                }
            }
            4 => {
                if (x + y) % 8 == 0 {
                    [20, 60, 200]
                } else {
                    [250, 245, 235]
                }
            }
            5 => {
                if (x / 2 + y / 2) % 2 == 0 {
                    [255, 0, 0]
                } else {
                    [0, 255, 0]
                }
            }
            6 => {
                if x % 3 == 0 {
                    [255, 255, 255]
                } else {
                    [0, 0, 0]
                }
            }
            _ => {
                if ((x * 7 + y * 3) % 11) < 2 {
                    [0, 0, 0]
                } else {
                    [255, 255, 255]
                }
            }
        };
        image::Rgb(v)
    });
    all.push(sample(
        "fine-lines.png",
        "6",
        "1 px 黑线、彩线、棋盘格与网点：对比线性光与编码值缩小（只记录）",
        false,
        encode_png8(&DynamicImage::ImageRgb8(lines)),
        Vec::new(),
    ));

    // 实验 7：透明边。色块为不同不透明度的纯色，四周是半透明发丝。
    let alphas: [u8; 8] = [255, 128, 64, 255, 192, 128, 32, 255];
    let edge = RgbaImage::from_fn(W, H, |x, y| {
        let i = (y / (H / ROWS) * COLS + x / (W / COLS)) as usize;
        let (bx, by, bw, bh) = block(i);
        let (lx, ly) = (x - bx, y - by);
        let border = lx < bw / 8 || lx >= bw * 7 / 8 || ly < bh / 8 || ly >= bh * 7 / 8;
        if border {
            // 透明底上的半透明细发丝，检查暗边或彩边。
            if (lx + ly) % 6 == 0 {
                image::Rgba([250, 220, 120, 140])
            } else {
                image::Rgba([0, 0, 0, 0])
            }
        } else {
            let [r, g, b] = RGB_PATCHES[i];
            image::Rgba([r, g, b, alphas[i]])
        }
    });
    let edge_patches: Vec<Patch> = RGB_PATCHES
        .iter()
        .enumerate()
        .map(|(i, c)| patch(i, lab(&srgb, &c.map(unit)), unit(alphas[i])))
        .collect();
    all.push(sample(
        "alpha-edge.png",
        "7",
        "透明边：半透明色块与发丝（PNG）",
        true,
        encode_png8(&DynamicImage::ImageRgba8(edge.clone())),
        edge_patches.clone(),
    ));
    all.push(sample(
        "alpha-edge.webp",
        "7",
        "透明边：半透明色块与发丝（无损 WebP）",
        true,
        {
            let mut out = Vec::new();
            image::codecs::webp::WebPEncoder::new_lossless(&mut out)
                .write_image(edge.as_raw(), W, H, image::ExtendedColorType::Rgba8)
                .expect("WebP 编码成功");
            out
        },
        edge_patches,
    ));

    // 实验 8：EXIF 方向 1～8。转正后为 256×192 的四象限图。
    let (uw, uh) = (256u32, 192u32);
    let quadrant: [[u8; 3]; 4] = [[220, 40, 40], [40, 180, 60], [40, 70, 210], [240, 200, 40]];
    let upright = RgbImage::from_fn(uw, uh, |x, y| {
        image::Rgb(quadrant[((y / (uh / 2)) * 2 + x / (uw / 2)) as usize])
    });
    let quad_patches: Vec<Patch> = (0..4u32)
        .map(|q| Patch {
            x: (q % 2) * uw / 2 + uw / 8,
            y: (q / 2) * uh / 2 + uh / 8,
            width: uw / 4,
            height: uh / 4,
            lab: lab(&srgb, &quadrant[q as usize].map(unit)),
            alpha: 1.0,
        })
        .collect();
    for o in 1..=8u8 {
        // 存储的像素经方向 o 转正后得到 upright，所以先做逆变换。
        let inverse = match o {
            6 => 8,
            8 => 6,
            other => other,
        };
        let mut stored = DynamicImage::ImageRgb8(upright.clone());
        stored.apply_orientation(Orientation::from_exif(inverse).expect("1～8"));
        let stored = stored.to_rgb8();
        all.push(sample(
            &format!("orientation-{o}.jpg"),
            "8",
            &format!("EXIF 方向 {o}：转正后左上红、右上绿、左下蓝、右下黄"),
            true,
            jpeg(
                stored.as_raw(),
                stored.width(),
                stored.height(),
                jpeg_encoder::ColorType::Rgb,
                None,
                &[(
                    1,
                    [b"Exif\0\0".as_slice(), &exif_orientation(o as u16)].concat(),
                )],
            ),
            quad_patches.clone(),
        ));
    }
    all.push(sample(
        "orientation-6.png",
        "8",
        "带 eXIf 方向 6 的 PNG",
        true,
        {
            let mut stored = DynamicImage::ImageRgb8(upright.clone());
            stored.apply_orientation(Orientation::Rotate270);
            let stored = stored.to_rgb8();
            png(
                stored.width(),
                stored.height(),
                png::ColorType::Rgb,
                png::BitDepth::Eight,
                stored.as_raw(),
                |info| {
                    info.exif_metadata = Some(exif_orientation(6).into());
                },
                &[],
            )
        },
        quad_patches.clone(),
    ));

    // 动图：缩略图是静止的首帧（首帧为八色块，第二帧整张变灰）。
    all.extend(animated_samples(&srgb));

    // HDR：增益图 JPEG 的基础图是 SDR；PQ／HLG 色调映射只记录。
    let xmp = [
        b"http://ns.adobe.com/xap/1.0/\0".as_slice(),
        br#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0"/></rdf:RDF></x:xmpmeta>"#,
    ]
    .concat();
    all.push(sample(
        "gain-map.jpg",
        "13",
        "带 hdrgm XMP 标记的 JPEG（基础图为 sRGB）：按基础图显示",
        true,
        jpeg(
            blocks.as_raw(),
            W,
            H,
            jpeg_encoder::ColorType::Rgb,
            None,
            &[(1, xmp)],
        ),
        rgb_patches(&srgb),
    ));
    all.extend(hdr_samples());
    all
}

fn encode_png8(image: &DynamicImage) -> Vec<u8> {
    let mut out = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .expect("PNG 编码成功");
    out
}

fn animated_samples(srgb: &ColorProfile) -> Vec<GateSample> {
    let first = rgb_blocks();
    let second = RgbImage::from_pixel(W, H, image::Rgb([90, 90, 90]));
    let patches = rgb_patches(srgb);
    let mut out = Vec::new();

    // GIF：显式调色板，颜色无损。
    let mut palette: Vec<u8> = RGB_PATCHES.iter().flatten().copied().collect();
    palette.extend([90, 90, 90]);
    let index = |img: &RgbImage| -> Vec<u8> {
        img.pixels()
            .map(|p| {
                if p.0 == [90, 90, 90] {
                    8
                } else {
                    RGB_PATCHES
                        .iter()
                        .position(|c| *c == p.0)
                        .expect("调色板内") as u8
                }
            })
            .collect()
    };
    let mut gif_bytes = Vec::new();
    {
        let mut encoder =
            gif::Encoder::new(&mut gif_bytes, W as u16, H as u16, &palette).expect("GIF 头可写");
        encoder.set_repeat(gif::Repeat::Infinite).expect("可写");
        for img in [&first, &second] {
            let mut frame = gif::Frame::from_indexed_pixels(W as u16, H as u16, index(img), None);
            frame.delay = 50;
            encoder.write_frame(&frame).expect("GIF 帧可写");
        }
    }
    out.push(sample(
        "animated.gif",
        "anim",
        "两帧 GIF：缩略图应为静止首帧",
        true,
        gif_bytes,
        patches.clone(),
    ));

    // APNG：默认图即首帧。
    let mut apng = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut apng, W, H);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_animated(2, 0).expect("可设动画");
        encoder.set_frame_delay(1, 2).expect("可设延时");
        let mut writer = encoder.write_header().expect("PNG 头可写");
        writer.write_image_data(first.as_raw()).expect("首帧可写");
        writer
            .write_image_data(second.as_raw())
            .expect("第二帧可写");
    }
    out.push(sample(
        "animated.png",
        "anim",
        "两帧 APNG：缩略图应为静止首帧",
        true,
        apng,
        patches.clone(),
    ));

    // 动态 WebP：VP8X＋ANIM＋两个 ANMF（各含无损 VP8L）。
    out.push(sample(
        "animated.webp",
        "anim",
        "两帧动态 WebP：缩略图应为静止首帧",
        true,
        animated_webp(&[&first, &second]),
        patches,
    ));
    out
}

fn riff_chunk(name: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut c = name.to_vec();
    c.extend((body.len() as u32).to_le_bytes());
    c.extend(body);
    if body.len() % 2 == 1 {
        c.push(0);
    }
    c
}

fn u24(v: u32) -> [u8; 3] {
    let b = v.to_le_bytes();
    [b[0], b[1], b[2]]
}

fn animated_webp(frames: &[&RgbImage]) -> Vec<u8> {
    let (w, h) = frames[0].dimensions();
    let mut vp8x = vec![0x02, 0, 0, 0];
    vp8x.extend(u24(w - 1));
    vp8x.extend(u24(h - 1));
    let mut anim = vec![0, 0, 0, 0];
    anim.extend(0u16.to_le_bytes());
    let mut body = b"WEBP".to_vec();
    body.extend(riff_chunk(b"VP8X", &vp8x));
    body.extend(riff_chunk(b"ANIM", &anim));
    for frame in frames {
        let mut still = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut still)
            .write_image(frame.as_raw(), w, h, image::ExtendedColorType::Rgb8)
            .expect("WebP 编码成功");
        // 静态无损 WebP 为 RIFF 头（12 字节）后接 VP8L 块。
        let vp8l = &still[12..];
        let mut anmf = Vec::new();
        anmf.extend(u24(0));
        anmf.extend(u24(0));
        anmf.extend(u24(w - 1));
        anmf.extend(u24(h - 1));
        anmf.extend(u24(500));
        anmf.push(0b10); // 不混合、不清除
        anmf.extend(vp8l);
        body.extend(riff_chunk(b"ANMF", &anmf));
    }
    riff_chunk(b"RIFF", &body)
}

/// PQ 与 HLG 的 16 位 BT.2020 PNG（cICP＋cLLI）。只记录，不计门槛。
fn hdr_samples() -> Vec<GateSample> {
    // 色块亮度（尼特）与颜色（BT.2020 线性比例）。
    let blocks: [(f32, [f32; 3]); 8] = [
        (203.0, [1.0, 1.0, 1.0]),
        (100.0, [1.0, 1.0, 1.0]),
        (1000.0, [1.0, 1.0, 1.0]),
        (20.0, [1.0, 1.0, 1.0]),
        (203.0, [1.0, 0.2, 0.2]),
        (203.0, [0.2, 1.0, 0.2]),
        (600.0, [0.2, 0.3, 1.0]),
        (5.0, [1.0, 1.0, 1.0]),
    ];
    let pq = |nits: f32| {
        let (m1, m2, c1, c2, c3) = (0.159_301_76, 78.843_75, 0.835_937_5, 18.851_563, 18.6875);
        let y = (nits / 10_000.0).max(0.0).powf(m1);
        ((c1 + c2 * y) / (1.0 + c3 * y)).powf(m2)
    };
    let hlg = |nits: f32| {
        // 1000 尼特峰值、系统 gamma 1.2 的反向 OOTF 与 OETF（灰色）。
        let scene = (nits / 1000.0).powf(1.0 / 1.2);
        let (a, b, c) = (0.178_832_77, 0.284_668_92, 0.559_910_7);
        if scene <= 1.0 / 12.0 {
            (3.0 * scene).sqrt()
        } else {
            a * (12.0 * scene - b).ln() + c
        }
    };
    let make = |encode: &dyn Fn(f32) -> f32, transfer: u8| -> Vec<u8> {
        let mut d = Vec::with_capacity((W * H * 3) as usize);
        for y in 0..H {
            for x in 0..W {
                let (nits, rgb) = blocks[(y / (H / ROWS) * COLS + x / (W / COLS)) as usize];
                d.extend(rgb.map(|c| (encode(nits * c) * 65535.0).round() as u16));
            }
        }
        let mut cll = Vec::new();
        cll.extend(10_000_000u32.to_be_bytes());
        cll.extend(4_000_000u32.to_be_bytes());
        png(
            W,
            H,
            png::ColorType::Rgb,
            png::BitDepth::Sixteen,
            &to_u16_be(&d),
            |_| {},
            &[(b"cICP", vec![9, transfer, 0, 1]), (b"cLLI", cll)],
        )
    };
    vec![
        sample(
            "pq.png",
            "13",
            "BT.2020 PQ 16 位 PNG（cICP 9/16/0/1、cLLI 1000 尼特）：缩略图按 SDR 色调映射（只记录）",
            false,
            make(&pq, 16),
            Vec::new(),
        ),
        sample(
            "hlg.png",
            "13",
            "BT.2020 HLG 16 位 PNG（cICP 9/18/0/1）：缩略图按 SDR 色调映射（只记录）",
            false,
            make(&hlg, 18),
            Vec::new(),
        ),
    ]
}
