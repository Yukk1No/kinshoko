//! 管线与门槛样本用到的 ICC 配置文件。字节固定（创建时间写死），便于缓存与样本哈希可复现。

use moxcms::{
    CmsError, ColorProfile, DataColorSpace, LutDataType, LutStore, LutType, LutWarehouse, Matrix3d,
    ProfileClass, ProfileVersion, curve_from_gamma,
};

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

/// 只由 lut16 A2B 构成、PCS 为 Lab 的 RGB 配置文件，按 ICC v2.1 编码（与 FOGRA39 等
/// 常见查找表配置文件同样的结构）。`a2b` 把设备 RGB（0～1）映射到 D50 Lab，A2B0 与 A2B1 相同。
pub(crate) fn lut_rgb_lab_icc(grid: u8, a2b: impl Fn([f64; 3]) -> [f64; 3]) -> Vec<u8> {
    let mut p = ColorProfile::new_srgb();
    p.red_trc = None;
    p.green_trc = None;
    p.blue_trc = None;
    p.red_colorant = Default::default();
    p.green_colorant = Default::default();
    p.blue_colorant = Default::default();
    p.cicp = None;
    p.pcs = DataColorSpace::Lab;
    let table = lut16_lab(3, grid, |d| a2b([d[0], d[1], d[2]]));
    p.lut_a_to_b_perceptual = Some(LutWarehouse::Lut(table.clone()));
    p.lut_a_to_b_colorimetric = Some(LutWarehouse::Lut(table));
    with_version(
        encode(&p).expect("Lab PCS 配置文件可编码"),
        ProfileVersion::V2_1,
    )
}

/// CMYK 输出配置文件：lut16 A2B0、PCS 为 Lab，ICC v2.1（FOGRA39 式结构，数据为合成）。
/// `a2b0` 输入为油墨量 0～1，输出 D50 Lab。
pub(crate) fn cmyk_lab_icc(grid: u8, a2b0: impl Fn([f64; 4]) -> [f64; 3]) -> Vec<u8> {
    let mut p = cmyk(2, |_| [0.0; 3]);
    p.pcs = DataColorSpace::Lab;
    p.lut_a_to_b_perceptual = Some(LutWarehouse::Lut(lut16_lab(4, grid, |d| {
        a2b0([d[0], d[1], d[2], d[3]])
    })));
    with_version(
        encode(&p).expect("Lab PCS 配置文件可编码"),
        ProfileVersion::V2_1,
    )
}

/// lut16 的 Lab：旧式 16 位编码，L* 100 为 0xFF00，a*／b* 0 为 0x8000。
fn lut16_lab(inputs: u8, grid: u8, f: impl Fn(&[f64]) -> [f64; 3]) -> LutDataType {
    lut16_with(inputs, grid, |d| {
        let [l, a, b] = f(d);
        [
            l / 100.0 * 65280.0,
            (a + 128.0) * 256.0,
            (b + 128.0) * 256.0,
        ]
    })
}

/// lut16：恒等输入、输出曲线，`inputs` 维网格，输出三通道 XYZ（u1Fixed15）。
fn lut16(inputs: u8, grid: u8, f: impl Fn(&[f64]) -> [f64; 3]) -> LutDataType {
    lut16_with(inputs, grid, |d| f(d).map(|v| v * 32768.0))
}

/// lut16：恒等输入、输出曲线，`inputs` 维网格；`encode` 给出三通道的 16 位编码值。
fn lut16_with(inputs: u8, grid: u8, encode: impl Fn(&[f64]) -> [f64; 3]) -> LutDataType {
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
        for v in encode(&device) {
            clut.push(v.round().clamp(0.0, 65535.0) as u16);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn lab_of(profile: &ColorProfile, device: &[f32]) -> [f32; 3] {
        crate::fidelity::gate::lab(profile, device)
    }

    fn distance(a: [f32; 3], b: [f64; 3]) -> f64 {
        (0..3)
            .map(|i| (a[i] as f64 - b[i]).powi(2))
            .sum::<f64>()
            .sqrt()
    }

    /// 与 FOGRA39 同样的结构：ICC v2.1、lut16（mft2）A2B0、PCS 为 Lab（旧式 16 位编码）。
    fn header_and_a2b0(bytes: &[u8]) -> (u32, &[u8], &[u8]) {
        let version = u32::from_be_bytes(bytes[8..12].try_into().unwrap());
        let pcs = &bytes[20..24];
        let count = u32::from_be_bytes(bytes[128..132].try_into().unwrap()) as usize;
        let a2b0 = (0..count)
            .map(|i| &bytes[132 + i * 12..144 + i * 12])
            .find(|t| &t[0..4] == b"A2B0")
            .map(|t| {
                let offset = u32::from_be_bytes(t[4..8].try_into().unwrap()) as usize;
                &bytes[offset..offset + 4]
            })
            .expect("有 A2B0");
        (version, pcs, a2b0)
    }

    #[test]
    fn lab_pcs_lut_profiles_are_v2_lut16_and_decode_to_their_defining_colours() {
        // 网格结点上的设备值，解码结果应等于定义函数的 Lab（不受插值影响）。
        // 色度适中，都落在 BT.2020 中间空间里。
        let rgb = |d: [f64; 3]| [30.0 + 60.0 * d[1], 30.0 * (d[0] - 0.5), 30.0 * (d[2] - 0.5)];
        let bytes = lut_rgb_lab_icc(18, rgb);
        let (version, pcs, a2b0) = header_and_a2b0(&bytes);
        assert_eq!(version, 0x0210_0000);
        assert_eq!(pcs, b"Lab ");
        assert_eq!(a2b0, b"mft2");
        let parsed = ColorProfile::new_from_slice(&bytes).unwrap();
        for node in [[0u8, 0, 0], [255, 255, 255], [15, 120, 240], [255, 0, 90]] {
            let d = node.map(|v| v as f64 / 255.0);
            let got = lab_of(&parsed, &node.map(|v| v as f32 / 255.0));
            assert!(
                distance(got, rgb(d)) < 0.6,
                "{node:?}: {got:?} vs {:?}",
                rgb(d)
            );
        }

        let cmyk = |i: [f64; 4]| {
            let k = 1.0 - i[3];
            [
                20.0 + 60.0 * k * (1.0 - 0.4 * i[1]),
                20.0 * (i[1] - i[0]),
                20.0 * (i[2] - i[0]),
            ]
        };
        let bytes = cmyk_lab_icc(16, cmyk);
        let (version, pcs, a2b0) = header_and_a2b0(&bytes);
        assert_eq!(
            (version, pcs, a2b0),
            (0x0210_0000, &b"Lab "[..], &b"mft2"[..])
        );
        let parsed = ColorProfile::new_from_slice(&bytes).unwrap();
        for node in [
            [0u8, 0, 0, 0],
            [255, 0, 0, 0],
            [17, 170, 255, 34],
            [0, 0, 0, 255],
        ] {
            let d = node.map(|v| v as f64 / 255.0);
            let got = lab_of(&parsed, &node.map(|v| v as f32 / 255.0));
            assert!(
                distance(got, cmyk(d)) < 0.6,
                "{node:?}: {got:?} vs {:?}",
                cmyk(d)
            );
        }
    }
}
