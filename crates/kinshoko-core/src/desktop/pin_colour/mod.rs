//! 钉图的颜色（ADR 0014）：上传给 GPU 的像素与“到显示器”的查找表。不碰 GPU。
//!
//! 钉图的像素在线性工作空间里插值：线性光、sRGB 原色、扩展范围（广色域落在 0～1 之外），
//! 预乘 alpha，按 `Rgba16Float` 上传（[`PinPixels`]）。着色器最后一步把像素按 sRGB 曲线
//! （负值按符号对称）编码，查一张 [`LUT_SIZE`]³ 的 3D 查找表（[`lut`]）得到显示器编码。
//!
//! 查找表的输入是“源空间”的编码值：资料库钉图的源空间就是工作空间（`None`）；截图钉图的源空间
//! 是截图时那台显示器的配置文件，像素不做颜色转换，只按 sRGB 曲线展开成线性，回到同一台显示器时
//! 查找表是恒等，与截取时屏幕逐像素一致。
//!
//! 查找表的约定（`pin-render` 照此采样，那边的测试核对两边一致）：源空间编码值 `e` 落在
//! [`LUT_DOMAIN`] 上均匀分布的 [`LUT_SIZE`]³ 个结点里，结点 `(r, g, b)` 存在第 `(b·N + g)·N + r` 项；
//! 三线性插值的结果夹到 0～1、按 sRGB 曲线编码，再查一条逐通道的显示器曲线（[`PinLut`]）。
//! 资料库钉图到矩阵型显示器时表的输入改为线性值（`linear`）：结点均匀分布在 [`LUT_DOMAIN`] 两端
//! 按扩展 sRGB 曲线展开后的区间上。

use image::{ImageReader, Rgba32FImage};
use moxcms::{ColorProfile, DataColorSpace, Layout, RenderingIntent, TransformOptions};

use crate::fidelity::inspect::inspect;
use crate::fidelity::profiles::{self, srgb_eotf};
use crate::fidelity::render::decode_upright;

/// 查找表每一维的结点数。
pub const LUT_SIZE: usize = 65;
/// 查找表输入（源空间编码值）覆盖的范围：包得住 BT.2020 原色在扩展 sRGB 里的值（绿约 -0.79／1.07）。
/// 结点间隔 1/16，0 与 1 都是结点，裁到显示器色域的折点因此插值无误差。
pub const LUT_DOMAIN: (f32, f32) = (-1.5, 2.5);

/// 上传给钉图的像素：线性工作空间、预乘 alpha 的 RGBA，每个分量是 f16 的位。
#[derive(Debug, Clone, PartialEq)]
pub struct PinPixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u16>,
    /// 查找表的源空间（[`lut`] 的 `source`）：资料库钉图为 `None`，截图钉图为截图时显示器的配置文件。
    pub source: Option<Vec<u8>>,
}

/// 资料库钉图：派生图（或 1:1 显示的原图）按它的色彩声明转到线性工作空间，转正方向。
/// 规则与派生图管线相同（ICC、cICP、gAMA、CMYK、HDR 色调映射、动图首帧）。
pub fn derivative(bytes: &[u8]) -> Result<PinPixels, String> {
    // moxcms 的 f32 转换会把结果裁到 0～1：先转到包得住常见广色域的线性 BT.2020，
    // 再用矩阵转到线性 sRGB 原色，不裁。
    let image = decode_upright(bytes, &linear_bt2020())?;
    let m = inverse(to_bt2020(&ColorProfile::new_srgb())?);
    let (width, height) = image.dimensions();
    let rgba = image
        .into_raw()
        .chunks_exact(4)
        .flat_map(|p| {
            let rgb = mul(&m, [p[0], p[1], p[2]].map(f64::from));
            let a = p[3].clamp(0.0, 1.0);
            [rgb[0] as f32 * a, rgb[1] as f32 * a, rgb[2] as f32 * a, a]
        })
        .map(f16_bits)
        .collect();
    Ok(PinPixels {
        width,
        height,
        rgba,
        source: None,
    })
}

/// 截图钉图：截图文件（PNG，内嵌截图时显示器的配置文件）的像素原样按 sRGB 曲线展开，
/// 配置文件记在 [`PinPixels::source`]。没有配置文件时按 sRGB。
pub fn screenshot(bytes: &[u8]) -> Result<PinPixels, String> {
    let source = inspect(bytes)?.ok_or("不支持的格式")?.icc;
    let image = ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?
        .into_rgba8();
    let curve: Vec<f32> = (0..=255u8)
        .map(|v| srgb_eotf(f32::from(v) / 255.0))
        .collect();
    let (width, height) = image.dimensions();
    let rgba = image
        .pixels()
        .flat_map(|p| {
            let a = f32::from(p[3]) / 255.0;
            [
                curve[p[0] as usize] * a,
                curve[p[1] as usize] * a,
                curve[p[2] as usize] * a,
                a,
            ]
        })
        .map(f16_bits)
        .collect();
    Ok(PinPixels {
        width,
        height,
        rgba,
        source,
    })
}

/// 源空间到显示器的查找表（[`lut`]）。
#[derive(Debug, Clone, PartialEq)]
pub enum PinLut {
    /// 源空间就是显示器：编码值原样输出（夹到 0～1）。
    Identity,
    /// `clut`：[`LUT_SIZE`]³ 个结点，每项三个 f32，是显示器原色下的“近线性”值，不裁到 0～1；
    /// `curve`：[`CURVE_SIZE`] 项，每项三个 f32，把夹到 0～1、再按 sRGB 曲线编码的 `clut` 结果
    /// 映射成显示器编码（第 `i` 项对应编码值 `i / (CURVE_SIZE - 1)`）；
    /// `linear`：表的输入是线性值而不是编码值（见模块说明）。
    Table {
        clut: Vec<f32>,
        curve: Vec<f32>,
        linear: bool,
    },
}

/// 显示器曲线的项数。
pub const CURVE_SIZE: usize = 4096;

/// 源空间（`None` 为工作空间）→ 显示器配置文件（`None` 按 sRGB）的查找表，约定见模块说明。
///
/// 两边都是矩阵型（源为工作空间时只看显示器）时，结点存的是线性的显示器原色值，裁剪与显示器曲线
/// 放到逐通道的 `curve` 里，色域边上的折点不进 3D 表。资料库钉图（源为工作空间）的表按线性值查：
/// 结点值是结点的线性函数，三线性插值精确，同为 sRGB 的显示器 8 位值逐像素不变。别的配置文件（查找表型）由 moxcms 逐结点转换，结点存 sRGB 曲线展开的值。
///
/// 几乎就是 sRGB 的配置文件（[`nearly_srgb`]，例如 Windows 自带的“sRGB Color Space Profile.icm”，
/// 原色差万分之二）当作 sRGB：源与显示器都是 sRGB 时是恒等，不经表与曲线的浮点误差，sRGB 图在
/// sRGB 显示器上 100% 时逐像素不变。
pub fn lut(source: Option<&[u8]>, display: Option<&[u8]>) -> Result<PinLut, String> {
    if source == display {
        return Ok(PinLut::Identity);
    }
    let display = match display {
        Some(bytes) => parse_rgb(bytes)?,
        None => ColorProfile::new_srgb(),
    };
    let source = source.map(parse_rgb).transpose()?;
    if nearly_srgb(&display)? && source.as_ref().map_or(Ok(true), nearly_srgb)? {
        return Ok(PinLut::Identity);
    }
    table(source, display)
}

/// 原色允许的偏差（D50 下的 XYZ）。Windows 自带的 sRGB 配置文件差 2.2e-4。
const SRGB_COLORANT_SLACK: f64 = 1e-3;

/// 矩阵型、原色与 sRGB 相差不到 [`SRGB_COLORANT_SLACK`]、三条曲线把每个 8 位值都展开到 sRGB 曲线
/// 上同一个 8 位值附近（半级以内）：画出来与 sRGB 分不出。
fn nearly_srgb(p: &ColorProfile) -> Result<bool, String> {
    let srgb = ColorProfile::new_srgb();
    let near = |a: &moxcms::Xyzd, b: &moxcms::Xyzd| {
        [a.x - b.x, a.y - b.y, a.z - b.z]
            .iter()
            .all(|d| d.abs() < SRGB_COLORANT_SLACK)
    };
    if !p.is_matrix_shaper()
        || !near(&p.red_colorant, &srgb.red_colorant)
        || !near(&p.green_colorant, &srgb.green_colorant)
        || !near(&p.blue_colorant, &srgb.blue_colorant)
    {
        return Ok(false);
    }
    let ramp: Vec<f32> = (0..=255u8)
        .flat_map(|v| [f32::from(v) / 255.0; 3])
        .collect();
    let linear = convert(p, &profiles::linear_of(p), &ramp)?;
    Ok(linear.iter().zip(&ramp).all(|(&l, &e)| {
        let code = profiles::srgb_oetf(l.clamp(0.0, 1.0)) * 255.0;
        (code - e * 255.0).abs() < 0.5
    }))
}

/// 查找表本身（[`lut`] 已排除恒等的情况）。
fn table(source: Option<ColorProfile>, display: ColorProfile) -> Result<PinLut, String> {
    let n = LUT_SIZE;
    let nodes: Vec<[f32; 3]> = (0..n * n * n)
        .map(|i| [i % n, i / n % n, i / (n * n)].map(node))
        .collect();
    let clamped = |nodes: &[[f32; 3]]| -> Vec<f32> {
        nodes
            .iter()
            .flat_map(|e| e.map(|v| v.clamp(0.0, 1.0)))
            .collect()
    };
    let steps: Vec<f32> = (0..CURVE_SIZE)
        .map(|i| i as f32 / (CURVE_SIZE - 1) as f32)
        .collect();

    if display.is_matrix_shaper() && source.as_ref().is_none_or(|p| p.is_matrix_shaper()) {
        // 源的线性值：工作空间按扩展 sRGB 曲线展开；截图按它自己的曲线（输入在 0～1 内）。
        let (linear, to_wide) = match &source {
            None => (
                nodes
                    .iter()
                    .flat_map(|e| e.map(linear_node))
                    .collect::<Vec<f32>>(),
                to_bt2020(&ColorProfile::new_srgb())?,
            ),
            Some(p) => (
                convert(p, &profiles::linear_of(p), &clamped(&nodes))?,
                to_bt2020(p)?,
            ),
        };
        let m = product(&inverse(to_bt2020(&display)?), &to_wide);
        let clut = linear
            .chunks_exact(3)
            .flat_map(|l| mul(&m, [l[0], l[1], l[2]].map(f64::from)).map(|v| v as f32))
            .collect();
        let ramp: Vec<f32> = steps.iter().flat_map(|&t| [srgb_eotf(t); 3]).collect();
        let curve = convert(&profiles::linear_of(&display), &display, &ramp)?;
        return Ok(PinLut::Table {
            clut,
            curve,
            linear: source.is_none(),
        });
    }

    let encoded = match &source {
        // 工作空间的编码值 → 线性 sRGB 原色 → 线性 BT.2020（moxcms 的输入要在 0～1 内）。
        None => {
            let m = to_bt2020(&ColorProfile::new_srgb())?;
            let input: Vec<f32> = nodes
                .iter()
                .flat_map(|e| mul(&m, e.map(|v| f64::from(signed_eotf(v)))).map(|v| v as f32))
                .collect();
            convert(&linear_bt2020(), &display, &input)?
        }
        Some(p) => convert(p, &display, &clamped(&nodes))?,
    };
    Ok(PinLut::Table {
        clut: encoded.into_iter().map(srgb_eotf).collect(),
        curve: steps.iter().flat_map(|&t| [t; 3]).collect(),
        linear: false,
    })
}

/// moxcms 逐像素（RGB f32）转换。
fn convert(from: &ColorProfile, to: &ColorProfile, input: &[f32]) -> Result<Vec<f32>, String> {
    let mut out = vec![0f32; input.len()];
    from.create_transform_f32(Layout::Rgb, to, Layout::Rgb, options())
        .map_err(|e| format!("无法建立显示器颜色转换：{e:?}"))?
        .transform(input, &mut out)
        .map_err(|e| format!("显示器颜色转换失败：{e:?}"))?;
    Ok(out)
}

/// 对照用：派生图由 moxcms 直接转到显示器编码（直通 alpha，8 位，四舍五入），不经查找表与 GPU。
/// 门槛实验与 `pin-render` 的离屏比对拿它当“正式派生图在这台显示器上应有的样子”。
pub fn display_reference(bytes: &[u8], display: Option<&[u8]>) -> Result<image::RgbaImage, String> {
    let display = match display {
        Some(bytes) => parse_rgb(bytes)?,
        None => ColorProfile::new_srgb(),
    };
    let working = linear_bt2020();
    let image: Rgba32FImage = decode_upright(bytes, &working)?;
    let (w, h) = image.dimensions();
    let mut out = vec![0f32; image.as_raw().len()];
    working
        .create_transform_f32(Layout::Rgba, &display, Layout::Rgba, options())
        .map_err(|e| format!("无法建立显示器颜色转换：{e:?}"))?
        .transform(image.as_raw(), &mut out)
        .map_err(|e| format!("显示器颜色转换失败：{e:?}"))?;
    let bytes = out
        .into_iter()
        .map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect();
    image::RgbaImage::from_raw(w, h, bytes).ok_or_else(|| "像素缓冲尺寸不符".into())
}

/// 第 `i` 个结点的输入值。
fn node(i: usize) -> f32 {
    let (lo, hi) = LUT_DOMAIN;
    lo + (hi - lo) * i as f32 / (LUT_SIZE - 1) as f32
}

/// 按线性值查的表（`linear`）里编码值结点 `e` 对应的线性值：两端展开后的区间上均匀分布。
fn linear_node(e: f32) -> f32 {
    let (lo, hi) = (signed_eotf(LUT_DOMAIN.0), signed_eotf(LUT_DOMAIN.1));
    let (dlo, dhi) = LUT_DOMAIN;
    lo + (hi - lo) * (e - dlo) / (dhi - dlo)
}

/// sRGB 曲线解码，负值按符号对称（扩展 sRGB）。
fn signed_eotf(v: f32) -> f32 {
    v.signum() * srgb_eotf(v.abs())
}

fn options() -> TransformOptions {
    TransformOptions {
        rendering_intent: RenderingIntent::Perceptual,
        ..TransformOptions::default()
    }
}

fn parse_rgb(bytes: &[u8]) -> Result<ColorProfile, String> {
    let profile =
        ColorProfile::new_from_slice(bytes).map_err(|e| format!("读不了配置文件：{e:?}"))?;
    if profile.color_space != DataColorSpace::Rgb {
        return Err(format!("配置文件不是 RGB：{:?}", profile.color_space));
    }
    Ok(profile)
}

fn linear_bt2020() -> ColorProfile {
    profiles::linear_of(&ColorProfile::new_bt2020())
}

type Matrix = [[f64; 3]; 3];

/// 某个矩阵型配置文件的线性原色 → 线性 BT.2020 的矩阵，从 moxcms 自己的转换量出来（逐列转换单位向量）。
/// 与配置文件里的着色剂按 ICC 定点数、适应矩阵再算一遍会差约 1e-4，往返时暗通道会差一级；
/// 用 moxcms 的矩阵，往返就与它一致。原色超出 BT.2020 的配置文件会被裁，这里不支持。
fn to_bt2020(profile: &ColorProfile) -> Result<Matrix, String> {
    let units = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    let columns = convert(&profiles::linear_of(profile), &linear_bt2020(), &units)?;
    Ok([0, 1, 2].map(|r| [0, 1, 2].map(|c| f64::from(columns[c * 3 + r]))))
}

fn inverse(m: Matrix) -> Matrix {
    moxcms::Matrix3d { v: m }.inverse().v
}

fn product(a: &Matrix, b: &Matrix) -> Matrix {
    [0, 1, 2].map(|r| [0, 1, 2].map(|c| (0..3).map(|k| a[r][k] * b[k][c]).sum()))
}

fn mul(m: &Matrix, v: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|r| m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2])
}

fn f16_bits(v: f32) -> u16 {
    half::f16::from_f32(v).to_bits()
}

#[cfg(test)]
mod tests;
