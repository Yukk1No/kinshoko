//! 管线与门槛样本用到的 ICC 配置文件。字节固定（创建时间写死），便于缓存与样本哈希可复现。

use moxcms::{
    CmsError, ColorProfile, DataColorSpace, LutDataType, LutStore, LutType, LutWarehouse, Matrix3d,
    ProfileClass, ProfileVersion, ToneReprCurve, curve_from_gamma,
};

/// sRGB 传递函数（IEC 61966-2-1）的 ICC 参数曲线。
pub(crate) fn srgb_curve() -> ToneReprCurve {
    ToneReprCurve::Parametric(vec![2.4, 1. / 1.055, 0.055 / 1.055, 1. / 12.92, 0.04045])
}

pub(crate) fn srgb_eotf(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// 同一组原色、线性传递函数的工作空间。
pub(crate) fn linear_of(profile: &ColorProfile) -> ColorProfile {
    let mut linear = profile.clone();
    let one = curve_from_gamma(1.0);
    linear.red_trc = Some(one.clone());
    linear.green_trc = Some(one.clone());
    linear.blue_trc = Some(one);
    linear.cicp = None;
    linear
}

/// 不带 cicp 标签的 Display P3（ICC v4，sRGB 曲线）。派生图转换的目标空间。
pub(crate) fn display_p3() -> ColorProfile {
    let mut p = ColorProfile::new_display_p3();
    p.cicp = None;
    p
}

/// 把配置文件编码为固定字节：创建时间写死为 2026-10-06 00:00:00。
pub(crate) fn encode(profile: &ColorProfile) -> Result<Vec<u8>, CmsError> {
    let mut bytes = profile.encode()?;
    let date: [u16; 6] = [2026, 10, 6, 0, 0, 0];
    for (i, v) in date.iter().enumerate() {
        bytes[24 + i * 2..26 + i * 2].copy_from_slice(&v.to_be_bytes());
    }
    Ok(bytes)
}

/// 改写头部版本号（例如做 ICC v2 样本）。
pub(crate) fn with_version(mut bytes: Vec<u8>, version: ProfileVersion) -> Vec<u8> {
    bytes[8..12].copy_from_slice(&(version as u32).to_be_bytes());
    bytes
}

pub(crate) fn display_p3_icc() -> Vec<u8> {
    encode(&display_p3()).expect("Display P3 配置文件可编码")
}

/// 只由查找表（lut16 A2B）构成的 RGB 配置文件，PCS 为 XYZ。
/// `a2b0` 与 `a2b1` 把设备 RGB（0～1）映射到 D50 XYZ。
pub(crate) fn lut_rgb(
    grid: u8,
    a2b0: impl Fn([f64; 3]) -> [f64; 3],
    a2b1: impl Fn([f64; 3]) -> [f64; 3],
) -> ColorProfile {
    let mut p = ColorProfile::new_srgb();
    p.red_trc = None;
    p.green_trc = None;
    p.blue_trc = None;
    p.red_colorant = Default::default();
    p.green_colorant = Default::default();
    p.blue_colorant = Default::default();
    p.cicp = None;
    p.lut_a_to_b_perceptual = Some(LutWarehouse::Lut(lut16(3, grid, |d| {
        a2b0([d[0], d[1], d[2]])
    })));
    p.lut_a_to_b_colorimetric = Some(LutWarehouse::Lut(lut16(3, grid, |d| {
        a2b1([d[0], d[1], d[2]])
    })));
    p
}

/// CMYK 输出配置文件（lut16 A2B0，PCS 为 XYZ）。`a2b0` 输入为油墨量 0～1。
pub(crate) fn cmyk(grid: u8, a2b0: impl Fn([f64; 4]) -> [f64; 3]) -> ColorProfile {
    let mut p = ColorProfile::new_srgb();
    p.red_trc = None;
    p.green_trc = None;
    p.blue_trc = None;
    p.red_colorant = Default::default();
    p.green_colorant = Default::default();
    p.blue_colorant = Default::default();
    p.cicp = None;
    p.chromatic_adaptation = None;
    p.color_space = DataColorSpace::Cmyk;
    p.profile_class = ProfileClass::OutputDevice;
    p.lut_a_to_b_perceptual = Some(LutWarehouse::Lut(lut16(4, grid, |d| {
        a2b0([d[0], d[1], d[2], d[3]])
    })));
    p
}

/// lut16：恒等输入、输出曲线，`inputs` 维网格，输出三通道 XYZ（u1Fixed15）。
fn lut16(inputs: u8, grid: u8, f: impl Fn(&[f64]) -> [f64; 3]) -> LutDataType {
    let identity: Vec<u16> = vec![0, 65535];
    let points = grid as usize;
    let total = points.pow(inputs as u32);
    let mut clut = Vec::with_capacity(total * 3);
    let mut device = vec![0f64; inputs as usize];
    for index in 0..total {
        // 第一个输入通道变化最慢。
        let mut rest = index;
        for d in (0..inputs as usize).rev() {
            device[d] = (rest % points) as f64 / (points - 1) as f64;
            rest /= points;
        }
        for v in f(&device) {
            clut.push((v * 32768.0).round().clamp(0.0, 65535.0) as u16);
        }
    }
    LutDataType {
        num_input_channels: inputs,
        num_output_channels: 3,
        num_clut_grid_points: grid,
        matrix: Matrix3d::IDENTITY,
        num_input_table_entries: 2,
        num_output_table_entries: 2,
        input_table: LutStore::Store16(identity.repeat(inputs as usize)),
        clut_table: LutStore::Store16(clut),
        output_table: LutStore::Store16(identity.repeat(3)),
        lut_type: LutType::Lut16,
    }
}
