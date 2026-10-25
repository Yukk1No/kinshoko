//! 颜色：查找表到显示器与 moxcms 直接转换比。

use super::*;

fn gate_samples() -> &'static [GateSample] {
    static SAMPLES: OnceLock<Vec<GateSample>> = OnceLock::new();
    SAMPLES.get_or_init(gate::samples)
}

/// 计入门槛的样本在 GPU 上 1:1 画出、经查找表到 `display`，与 moxcms 直接转换比（门槛实验同一套
/// 比较，`PinGateItem::compare`）：最差色块 ΔE2000 与所在样本。
fn worst_patch(r: &Renderer, display: Option<&[u8]>, samples: &[&GateSample]) -> (f64, String) {
    let table = lut(r, &pin_colour::lut(None, display).unwrap());
    let mut worst = (0.0, String::new());
    for sample in samples {
        let pixels = pin_colour::derivative(&sample.bytes).unwrap();
        let reference = pin_colour::display_reference(&sample.bytes, display).unwrap();
        let (w, h) = (pixels.width, pixels.height);
        let out = r
            .render_offscreen(
                &upload(r, &pixels),
                &plain((0, 0, w, h), Rect::new(0.0, 0.0, w as f32, h as f32)),
                &table,
            )
            .unwrap();
        let rendered = RgbaImage::from_raw(w, h, out.data).unwrap();
        let item = PinGateItem::compare(sample, display, &rendered, &reference).unwrap();
        for (i, de) in item.delta_e.iter().enumerate() {
            if let Some(de) = *de
                && de > worst.0
            {
                worst = (de, format!("{} 色块 {i}", sample.file_name));
            }
        }
    }
    worst
}

#[test]
fn display_p3_through_the_lut_to_an_srgb_display_is_within_one_delta_e_of_moxcms() {
    let r = renderer();
    let p3 = gate_samples()
        .iter()
        .find(|s| s.file_name == "p3-v4.jpg")
        .unwrap();
    let (de, at) = worst_patch(&r, None, &[p3]);
    println!("Display P3 样本 → sRGB 显示器：最差 ΔE2000 {de:.3}（{at}）");
    assert!(de < 1.0, "最差 ΔE2000 {de:.3}（{at}）");
}

#[test]
fn every_gated_sample_is_within_one_delta_e_of_moxcms_on_common_displays() {
    let r = renderer();
    let gated: Vec<&GateSample> = gate_samples().iter().filter(|s| s.gated).collect();
    let p3 = pin_colour_p3();
    let calibrated = pin_gate::calibrated_display_icc();
    for (name, display) in [
        ("sRGB", None),
        ("Display P3", Some(&p3[..])),
        ("校准 gamma 2.2", Some(&calibrated[..])),
    ] {
        let (de, at) = worst_patch(&r, display, &gated);
        println!("{name}：最差 ΔE2000 {de:.3}（{at}）");
        assert!(de < 1.0, "{name}：最差 ΔE2000 {de:.3}（{at}）");
    }
}

/// Display P3 显示器的配置文件：取 P3 门槛样本里嵌的那一份。
fn pin_colour_p3() -> Vec<u8> {
    let p3 = gate_samples()
        .iter()
        .find(|s| s.file_name == "png16-p3.png")
        .unwrap();
    image::ImageReader::new(std::io::Cursor::new(&p3.bytes))
        .with_guessed_format()
        .unwrap()
        .into_decoder()
        .and_then(|mut d| {
            use image::ImageDecoder;
            d.icc_profile()
        })
        .unwrap()
        .expect("样本带 ICC")
}

#[test]
fn a_screenshot_back_on_its_own_display_is_the_captured_pixels() {
    let r = renderer();
    let p3 = pin_colour_p3();
    let shot = photo(120, 80);
    let pixels = pin_colour::screenshot(&png(&shot, Some(p3.clone()))).unwrap();
    let table = lut(
        &r,
        &pin_colour::lut(pixels.source.as_deref(), Some(&p3)).unwrap(),
    );
    let out = r
        .render_offscreen(
            &upload(&r, &pixels),
            &plain((0, 0, 120, 80), full(&shot)),
            &table,
        )
        .unwrap();
    assert_same(&straight(&out), &shot, "截图回到原显示器");
}

// ---- 金样 -----------------------------------------------------------------------------------
