//! 门槛实验的“钉图离屏渲染 vs 正式派生图”（ADR 0014，#282）与它用到的色差工具。
//!
//! 渲染在应用壳与 `pin-render` 的测试里做（核心不依赖 GPU），这里只定义报告与比较方法。

use image::RgbaImage;
use moxcms::ColorProfile;
use serde::Serialize;
use ts_rs::TS;

use super::gate::{GateSample, lab};
use super::profiles;

fn unit(v: u8) -> f32 {
    f32::from(v) / 255.0
}

/// 合成的“校准过的普通显示器”配置文件：gamma 2.2，原色比 sRGB 略偏（矩阵型 ICC v4）。
/// 钉图颜色（`desktop::pin_colour`）的测试与门槛实验拿它代表装了校准 ICC 的 SDR 显示器。
pub fn calibrated_display_icc() -> Vec<u8> {
    let mut p = ColorProfile::new_srgb();
    p.update_rgb_colorimetry(
        moxcms::XyY {
            x: 0.3127,
            y: 0.3290,
            yb: 1.0,
        },
        moxcms::ColorPrimaries {
            red: moxcms::Chromaticity::new(0.655, 0.335),
            green: moxcms::Chromaticity::new(0.305, 0.615),
            blue: moxcms::Chromaticity::new(0.152, 0.058),
        },
    );
    let curve = moxcms::curve_from_gamma(2.2);
    p.red_trc = Some(curve.clone());
    p.green_trc = Some(curve.clone());
    p.blue_trc = Some(curve);
    p.cicp = None;
    profiles::encode(&p).expect("矩阵型配置文件可编码")
}

/// 把显示器编码的 8 位 RGB 按显示器配置文件（`None` 为 sRGB）换成 CIE Lab（D50）。
pub fn display_lab(display: Option<&[u8]>, rgb: [u8; 3]) -> Result<[f32; 3], String> {
    let profile = match display {
        Some(bytes) => ColorProfile::new_from_slice(bytes).map_err(|e| format!("{e:?}"))?,
        None => ColorProfile::new_srgb(),
    };
    Ok(lab(&profile, &rgb.map(unit)))
}

/// CIEDE2000 色差（Sharma 2005 的公式）。
pub fn delta_e2000(lab1: [f32; 3], lab2: [f32; 3]) -> f64 {
    let [l1, a1, b1] = lab1.map(f64::from);
    let [l2, a2, b2] = lab2.map(f64::from);
    let c1 = (a1 * a1 + b1 * b1).sqrt();
    let c2 = (a2 * a2 + b2 * b2).sqrt();
    let c_bar = (c1 + c2) / 2.0;
    let g = 0.5 * (1.0 - (c_bar.powi(7) / (c_bar.powi(7) + 25f64.powi(7))).sqrt());
    let (a1p, a2p) = ((1.0 + g) * a1, (1.0 + g) * a2);
    let (c1p, c2p) = ((a1p * a1p + b1 * b1).sqrt(), (a2p * a2p + b2 * b2).sqrt());
    let hue = |b: f64, a: f64| {
        if a == 0.0 && b == 0.0 {
            0.0
        } else {
            let h = b.atan2(a).to_degrees();
            if h < 0.0 { h + 360.0 } else { h }
        }
    };
    let (h1p, h2p) = (hue(b1, a1p), hue(b2, a2p));
    let dl = l2 - l1;
    let dc = c2p - c1p;
    let dh = if c1p * c2p == 0.0 {
        0.0
    } else if (h2p - h1p).abs() <= 180.0 {
        h2p - h1p
    } else if h2p - h1p > 180.0 {
        h2p - h1p - 360.0
    } else {
        h2p - h1p + 360.0
    };
    let d_h = 2.0 * (c1p * c2p).sqrt() * (dh.to_radians() / 2.0).sin();
    let l_bar = (l1 + l2) / 2.0;
    let c_bar_p = (c1p + c2p) / 2.0;
    let h_bar = if c1p * c2p == 0.0 {
        h1p + h2p
    } else if (h1p - h2p).abs() <= 180.0 {
        (h1p + h2p) / 2.0
    } else if h1p + h2p < 360.0 {
        (h1p + h2p + 360.0) / 2.0
    } else {
        (h1p + h2p - 360.0) / 2.0
    };
    let t = 1.0 - 0.17 * (h_bar - 30.0).to_radians().cos()
        + 0.24 * (2.0 * h_bar).to_radians().cos()
        + 0.32 * (3.0 * h_bar + 6.0).to_radians().cos()
        - 0.20 * (4.0 * h_bar - 63.0).to_radians().cos();
    let d_theta = 30.0 * (-((h_bar - 275.0) / 25.0).powi(2)).exp();
    let r_c = 2.0 * (c_bar_p.powi(7) / (c_bar_p.powi(7) + 25f64.powi(7))).sqrt();
    let s_l = 1.0 + 0.015 * (l_bar - 50.0).powi(2) / (20.0 + (l_bar - 50.0).powi(2)).sqrt();
    let s_c = 1.0 + 0.045 * c_bar_p;
    let s_h = 1.0 + 0.015 * c_bar_p * t;
    let r_t = -(2.0 * d_theta.to_radians()).sin() * r_c;
    ((dl / s_l).powi(2) + (dc / s_c).powi(2) + (d_h / s_h).powi(2) + r_t * (dc / s_c) * (d_h / s_h))
        .sqrt()
}

/// 门槛实验的“钉图离屏渲染 vs 正式派生图”（ADR 0014，#282）：同一组样本的 1:1 显示文件在 GPU 上
/// 画出、经查找表到显示器，与 moxcms 把同一文件直接转到显示器的结果比较。
#[derive(Debug, Clone, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PinGate {
    /// 钉图用的 GPU 适配器。
    pub adapter: String,
    /// 查找表对着的显示器配置文件。
    pub display: String,
    pub items: Vec<PinGateItem>,
    /// 渲染层起不来时的原因。
    pub error: Option<String>,
}

impl PinGate {
    /// 计入门槛的样本最差色块都 ΔE2000 < 1，且没有出错。
    pub fn passed(&self) -> bool {
        self.error.is_none()
            && self.items.iter().all(|i| {
                !i.gated || (i.error.is_none() && i.worst_delta_e.is_some_and(|d| d < 1.0))
            })
    }
}

/// 一个样本的钉图比较结果。
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PinGateItem {
    pub file_name: String,
    pub gated: bool,
    /// 各色块（均值）的 ΔE2000，在显示器的 Lab 下；完全透明的色块为 `None`。
    pub delta_e: Vec<Option<f64>>,
    pub worst_delta_e: Option<f64>,
    /// 两边都不透明的像素逐通道 8 位差：均值、p99、最大。
    pub mean: f64,
    pub p99: u8,
    pub max: u8,
    pub error: Option<String>,
}

impl PinGateItem {
    /// 这个样本没能比较（读图、上传或绘制出错）。
    pub fn failed(sample: &GateSample, error: String) -> PinGateItem {
        PinGateItem {
            file_name: sample.file_name.clone(),
            gated: sample.gated,
            delta_e: Vec::new(),
            worst_delta_e: None,
            mean: 0.0,
            p99: 0,
            max: 0,
            error: Some(error),
        }
    }

    /// 比较钉图离屏渲染的结果 `rendered`（预乘 alpha，显示器编码）与 moxcms 直接转换的 `reference`
    /// （直通 alpha，`desktop::pin_colour::display_reference`）。`display` 为 `None` 时按 sRGB。
    pub fn compare(
        sample: &GateSample,
        display: Option<&[u8]>,
        rendered: &RgbaImage,
        reference: &RgbaImage,
    ) -> Result<PinGateItem, String> {
        if rendered.dimensions() != reference.dimensions() {
            return Err(format!(
                "尺寸不同：{:?} 与 {:?}",
                rendered.dimensions(),
                reference.dimensions()
            ));
        }
        let (w, h) = rendered.dimensions();
        if let Some(p) = sample
            .patches
            .iter()
            .find(|p| p.x + p.width > w || p.y + p.height > h)
        {
            return Err(format!("色块 {p:?} 超出 {w}×{h} 的图"));
        }
        // 透明度不经查找表：哪里不同（例如什么也没画出来）就是画错了，色块比较会把它跳过。
        if let Some((g, w)) = rendered
            .pixels()
            .zip(reference.pixels())
            .find(|(g, w)| g[3].abs_diff(w[3]) > 1)
        {
            return Err(format!("透明度不同：画出 {g:?}，应为 {w:?}"));
        }
        let profile = match display {
            Some(bytes) => ColorProfile::new_from_slice(bytes).map_err(|e| format!("{e:?}"))?,
            None => ColorProfile::new_srgb(),
        };
        let straight = |p: &image::Rgba<u8>| -> [f32; 4] {
            let a = f32::from(p[3]);
            let c = |v: u8| if a > 0.0 { f32::from(v) / a } else { 0.0 };
            [c(p[0]), c(p[1]), c(p[2]), a / 255.0]
        };
        let mut delta_e = Vec::with_capacity(sample.patches.len());
        for patch in &sample.patches {
            let (mut got, mut want, mut n) = ([0f32; 3], [0f32; 3], 0f32);
            for y in patch.y..patch.y + patch.height {
                for x in patch.x..patch.x + patch.width {
                    let g = straight(rendered.get_pixel(x, y));
                    let w = reference.get_pixel(x, y);
                    if g[3] == 0.0 || w[3] == 0 {
                        continue;
                    }
                    for c in 0..3 {
                        got[c] += g[c];
                        want[c] += f32::from(w[c]) / 255.0;
                    }
                    n += 1.0;
                }
            }
            delta_e.push((n > 0.0).then(|| {
                delta_e2000(
                    lab(&profile, &got.map(|v| v / n)),
                    lab(&profile, &want.map(|v| v / n)),
                )
            }));
        }
        let mut diffs: Vec<u8> = rendered
            .pixels()
            .zip(reference.pixels())
            .filter(|(g, w)| g[3] == 255 && w[3] == 255)
            .flat_map(|(g, w)| (0..3).map(move |c| g[c].abs_diff(w[c])))
            .collect();
        diffs.sort_unstable();
        let mean = if diffs.is_empty() {
            0.0
        } else {
            diffs.iter().map(|&d| f64::from(d)).sum::<f64>() / diffs.len() as f64
        };
        Ok(PinGateItem {
            file_name: sample.file_name.clone(),
            gated: sample.gated,
            worst_delta_e: delta_e.iter().flatten().copied().reduce(f64::max),
            delta_e,
            mean,
            p99: diffs
                .get(diffs.len().saturating_sub(1) * 99 / 100)
                .copied()
                .unwrap_or(0),
            max: diffs.last().copied().unwrap_or(0),
            error: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delta_e2000_matches_the_published_test_data() {
        // Sharma, Wu, Dalal (2005) 表 1 的第 1、7、17 组。
        let cases = [
            ([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425),
            ([50.0, 0.0, 0.0], [50.0, -1.0, 2.0], 2.3669),
            ([50.0, 2.5, 0.0], [73.0, 25.0, -18.0], 27.1492),
        ];
        for (a, b, expected) in cases {
            assert!((delta_e2000(a, b) - expected).abs() < 1e-3, "{a:?} {b:?}");
        }
    }
}
