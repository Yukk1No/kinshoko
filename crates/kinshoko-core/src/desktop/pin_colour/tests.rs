use image::{ImageEncoder, RgbaImage};

use super::*;

fn f32_of(bits: u16) -> f32 {
    half::f16::from_bits(bits).to_f32()
}

fn png(image: &RgbaImage, icc: Option<Vec<u8>>) -> Vec<u8> {
    let mut out = Vec::new();
    let mut encoder = image::codecs::png::PngEncoder::new(&mut out);
    if let Some(icc) = icc {
        encoder.set_icc_profile(icc).unwrap();
    }
    encoder
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();
    out
}

fn srgb_oetf(l: f32) -> f32 {
    if l <= 0.003_130_8 {
        l * 12.92
    } else {
        1.055 * l.powf(1.0 / 2.4) - 0.055
    }
}

/// 按着色器的做法查表：编码、三线性插值、夹到 0～1、编码后查显示器曲线。
fn apply(lut: &PinLut, linear: [f32; 3]) -> [f32; 3] {
    let e = linear.map(|l| l.signum() * srgb_oetf(l.abs()));
    let (clut, curve, linear) = match lut {
        PinLut::Identity => return e.map(|v| v.clamp(0.0, 1.0)),
        PinLut::Table {
            clut,
            curve,
            linear,
        } => (clut, curve, *linear),
    };
    let (lo, hi) = LUT_DOMAIN;
    // 按线性值查的表：输入与结点范围都换成线性值。
    let (e, (lo, hi)) = if linear {
        let l = |v: f32| v.signum() * srgb_eotf(v.abs());
        (e.map(l), (l(lo), l(hi)))
    } else {
        (e, (lo, hi))
    };
    let n = LUT_SIZE;
    let at = e.map(|e| ((e - lo) / (hi - lo) * (n - 1) as f32).clamp(0.0, (n - 1) as f32));
    let i0 = at.map(|t| (t.floor() as usize).min(n - 2));
    let f: Vec<f32> = (0..3).map(|c| at[c] - i0[c] as f32).collect();
    let mut y = [0f32; 3];
    for corner in 0..8 {
        let d = [corner & 1, corner >> 1 & 1, corner >> 2 & 1];
        let w: f32 = (0..3)
            .map(|c| if d[c] == 1 { f[c] } else { 1.0 - f[c] })
            .product();
        let idx = ((i0[2] + d[2]) * n + i0[1] + d[1]) * n + i0[0] + d[0];
        for c in 0..3 {
            y[c] += w * clut[idx * 3 + c];
        }
    }
    let m = CURVE_SIZE - 1;
    [0, 1, 2].map(|c| {
        let t = srgb_oetf(y[c].clamp(0.0, 1.0)) * m as f32;
        let i = (t.floor() as usize).min(m - 1);
        let f = t - i as f32;
        curve[i * 3 + c] * (1.0 - f) + curve[(i + 1) * 3 + c] * f
    })
}

#[test]
fn srgb_pixels_round_trip_through_the_srgb_lut_to_the_same_8_bit_values() {
    let image = RgbaImage::from_fn(256, 3, |x, y| {
        let v = x as u8;
        image::Rgba([v, v.wrapping_mul(7).wrapping_add(y as u8), 255 - v, 255])
    });
    let pixels = derivative(&png(&image, None)).unwrap();
    assert_eq!((pixels.width, pixels.height, pixels.source), (256, 3, None));
    let lut = lut(None, None).unwrap();
    for (p, want) in pixels.rgba.chunks_exact(4).zip(image.pixels()) {
        let rgb = apply(&lut, [p[0], p[1], p[2]].map(f32_of));
        let got = rgb.map(|v| (v * 255.0).round() as u8);
        assert_eq!(got, [want[0], want[1], want[2]]);
    }
}

#[test]
fn an_srgb_display_with_its_own_icc_goes_through_the_table_and_keeps_8_bit_values() {
    // 显示器报出 sRGB 的 ICC 字节时不是恒等（字节不同于“没有 ICC”），走 3D 表与曲线。
    let image = RgbaImage::from_fn(256, 3, |x, y| {
        let v = x as u8;
        image::Rgba([v, v.wrapping_mul(7).wrapping_add(y as u8), 255 - v, 255])
    });
    let pixels = derivative(&png(&image, None)).unwrap();
    let srgb = profiles::encode(&ColorProfile::new_srgb()).unwrap();
    let lut = lut(None, Some(&srgb)).unwrap();
    assert!(matches!(lut, PinLut::Table { .. }));
    for (p, want) in pixels.rgba.chunks_exact(4).zip(image.pixels()) {
        let rgb = apply(&lut, [p[0], p[1], p[2]].map(f32_of));
        let got = rgb.map(|v| (v * 255.0).round() as u8);
        assert_eq!(got, [want[0], want[1], want[2]]);
    }
}

#[test]
fn wide_gamut_colours_stay_outside_srgb_and_reach_a_p3_display_unclipped() {
    let red = RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 0, 255]));
    let p3 = profiles::display_p3_icc();
    let pixels = derivative(&png(&red, Some(p3.clone()))).unwrap();
    let rgb = [0, 1, 2].map(|c| f32_of(pixels.rgba[c]));
    // Display P3 的红在线性 sRGB 里约为 (1.2249, -0.0421, -0.0196)。
    assert!((rgb[0] - 1.2249).abs() < 2e-3, "{rgb:?}");
    assert!((rgb[1] + 0.0421).abs() < 2e-3, "{rgb:?}");
    assert!((rgb[2] + 0.0196).abs() < 2e-3, "{rgb:?}");

    let to_p3 = apply(&lut(None, Some(&p3)).unwrap(), rgb);
    for (got, want) in to_p3.iter().zip([1.0, 0.0, 0.0]) {
        assert!((got - want).abs() < 2.0 / 255.0, "{to_p3:?}");
    }
}

#[test]
fn a_lut_between_one_profile_and_itself_is_the_identity() {
    let p3 = profiles::display_p3_icc();
    assert_eq!(lut(Some(&p3), Some(&p3)).unwrap(), PinLut::Identity);
    assert_eq!(lut(None, None).unwrap(), PinLut::Identity);
}

#[test]
fn a_screenshot_keeps_its_display_values_and_is_tagged_with_that_display() {
    let p3 = profiles::display_p3_icc();
    let shot = RgbaImage::from_fn(16, 1, |x, _| image::Rgba([x as u8 * 16, 3, 250, 255]));
    let pixels = screenshot(&png(&shot, Some(p3.clone()))).unwrap();
    assert_eq!(pixels.source.as_deref(), Some(&p3[..]));
    let same = lut(Some(&p3), Some(&p3)).unwrap();
    for (p, want) in pixels.rgba.chunks_exact(4).zip(shot.pixels()) {
        let rgb = apply(&same, [p[0], p[1], p[2]].map(f32_of));
        assert_eq!(
            rgb.map(|v| (v * 255.0).round() as u8),
            [want[0], want[1], want[2]]
        );
    }
    // 到 sRGB 显示器时按两者的配置文件转换：P3 的纯绿在 sRGB 里裁到 (0, 1, 0) 附近。
    let green = screenshot(&png(
        &RgbaImage::from_pixel(1, 1, image::Rgba([0, 255, 0, 255])),
        Some(p3.clone()),
    ))
    .unwrap();
    let rgb = apply(
        &lut(Some(&p3), None).unwrap(),
        [0, 1, 2].map(|c| f32_of(green.rgba[c])),
    );
    assert!(rgb[0] < 0.01 && rgb[1] > 0.99 && rgb[2] < 0.01, "{rgb:?}");
}

#[test]
fn alpha_is_premultiplied_and_exif_orientation_is_applied() {
    // 2×1 的 JPEG 不带 alpha，换用带方向的 PNG：EXIF 方向 6（顺时针转 90°）后变成 1×2。
    let image = RgbaImage::from_fn(2, 1, |x, _| {
        if x == 0 {
            image::Rgba([255, 255, 255, 128])
        } else {
            image::Rgba([0, 0, 0, 255])
        }
    });
    let mut bytes = Vec::new();
    {
        let mut info = png::Info::with_size(2, 1);
        info.color_type = png::ColorType::Rgba;
        info.bit_depth = png::BitDepth::Eight;
        let encoder = png::Encoder::with_info(&mut bytes, info).unwrap();
        let mut writer = encoder.write_header().unwrap();
        writer
            .write_chunk(
                png::chunk::ChunkType(*b"eXIf"),
                &crate::fidelity::gate::exif_orientation(6),
            )
            .unwrap();
        writer.write_image_data(image.as_raw()).unwrap();
    }
    let pixels = derivative(&bytes).unwrap();
    assert_eq!((pixels.width, pixels.height), (1, 2));
    let first: Vec<f32> = pixels.rgba[..4].iter().map(|&b| f32_of(b)).collect();
    let a = 128.0 / 255.0;
    for v in first {
        assert!(
            (v - a).abs() < 1e-3,
            "白色半透明预乘后四个分量都约为 alpha：{v}"
        );
    }
}

#[test]
fn the_reference_is_moxcms_converting_straight_to_the_display() {
    let red = RgbaImage::from_pixel(1, 1, image::Rgba([255, 0, 0, 255]));
    let p3 = profiles::display_p3_icc();
    let on_p3 = display_reference(&png(&red, None), Some(&p3)).unwrap();
    // sRGB 红在 P3 显示器上的编码约为 (234, 51, 35)。
    let px = on_p3.get_pixel(0, 0).0;
    assert!(px[0].abs_diff(234) <= 1 && px[1].abs_diff(51) <= 1 && px[2].abs_diff(35) <= 1);
    assert_eq!(px[3], 255);
}

/// 门槛样本（计入门槛的）每个色块中心：经查找表的结果与 moxcms 直接转到显示器的结果，
/// 都按显示器配置文件换成 Lab 比 ΔE2000，返回最差的一个。
fn worst_patch(display: Option<&[u8]>) -> (f64, String) {
    use crate::fidelity::gate;
    use crate::fidelity::pin_gate::delta_e2000;
    let profile = display.map_or_else(ColorProfile::new_srgb, |b| parse_rgb(b).unwrap());
    let lut = lut(None, display).unwrap();
    let mut worst = (0.0, String::new());
    for sample in gate::samples().iter().filter(|s| s.gated) {
        let pixels = derivative(&sample.bytes).unwrap();
        let reference = display_reference(&sample.bytes, display).unwrap();
        for (i, patch) in sample.patches.iter().enumerate() {
            let (x, y) = (patch.x + patch.width / 2, patch.y + patch.height / 2);
            let at = ((y * pixels.width + x) * 4) as usize;
            let p: Vec<f32> = pixels.rgba[at..at + 4].iter().map(|&b| f32_of(b)).collect();
            let rgb = [p[0], p[1], p[2]].map(|v| v / p[3].max(1e-6));
            let got = apply(&lut, rgb).map(|v| (v * 255.0).round() / 255.0);
            let want = reference.get_pixel(x, y).0;
            let want = [want[0], want[1], want[2]].map(|v| f32::from(v) / 255.0);
            let de = delta_e2000(gate::lab(&profile, &got), gate::lab(&profile, &want));
            if de > worst.0 {
                worst = (
                    de,
                    format!("{} 色块 {i}：{got:?} vs {want:?}", sample.file_name),
                );
            }
        }
    }
    worst
}

#[test]
fn the_lut_matches_moxcms_within_one_delta_e_on_every_gate_patch() {
    let p3 = profiles::display_p3_icc();
    let calibrated = crate::fidelity::pin_gate::calibrated_display_icc();
    for (name, display) in [
        ("sRGB", None),
        ("Display P3", Some(&p3[..])),
        ("校准 gamma 2.2", Some(&calibrated[..])),
    ] {
        let (de, at) = worst_patch(display);
        println!("{name}：最差 ΔE2000 {de:.3}（{at}）");
        assert!(de < 1.0, "{name}：最差 ΔE2000 {de:.3}（{at}）");
    }
}
