//! 1:1、转向、裁切与缩小：与正式派生图比。

use super::*;

#[test]
fn an_srgb_image_at_100_percent_is_its_derivative_pixel_for_pixel() {
    let r = renderer();
    let source = photo(301, 207);
    let pixels = pin_colour::derivative(&png(&source, None)).unwrap();
    let image = upload(&r, &pixels);
    let identity = lut(&r, &pin_colour::lut(None, None).unwrap());
    let out = r
        .render_offscreen(
            &image,
            &plain((-40, 1000, 301, 207), full(&source)),
            &identity,
        )
        .unwrap();
    assert_same(&straight(&out), &source, "1:1");
}

#[test]
fn quarter_turns_and_flips_at_100_percent_are_pixel_permutations() {
    let r = renderer();
    let source = photo(64, 41);
    let image = upload(&r, &pin_colour::derivative(&png(&source, None)).unwrap());
    let identity = lut(&r, &PinLut::Identity);
    for quarter in 0..4u8 {
        for (flip_h, flip_v) in [(false, false), (true, false), (false, true), (true, true)] {
            // 与画布相同：先在源图上翻转，再顺时针转。
            let mut want = source.clone();
            if flip_h {
                want = image::imageops::flip_horizontal(&want);
            }
            if flip_v {
                want = image::imageops::flip_vertical(&want);
            }
            for _ in 0..quarter {
                want = image::imageops::rotate90(&want);
            }
            let mut draw = plain((7, 9, want.width(), want.height()), full(&source));
            draw.turn = Turn {
                quarter,
                flip_h,
                flip_v,
            };
            let out = r.render_offscreen(&image, &draw, &identity).unwrap();
            assert_same(
                &straight(&out),
                &want,
                &format!("转 {quarter}、左右翻 {flip_h}、上下翻 {flip_v}"),
            );
        }
    }
}

#[test]
fn a_crop_never_shows_pixels_from_outside_it() {
    let r = renderer();
    // 局部里红色恒为 0，局部以外是纯红：画出来的任何一点带红就是漏了。
    let (cx, cy, cw, ch) = (13u32, 7u32, 101u32, 77u32);
    let source = RgbaImage::from_fn(160, 120, |x, y| {
        if x >= cx && x < cx + cw && y >= cy && y < cy + ch {
            image::Rgba([0, (x * 2) as u8, (255 - y * 2) as u8, 255])
        } else {
            image::Rgba([255, 0, 0, 255])
        }
    });
    let image = upload(&r, &pin_colour::derivative(&png(&source, None)).unwrap());
    let identity = lut(&r, &PinLut::Identity);
    let crop = Rect::new(cx as f32, cy as f32, cw as f32, ch as f32);
    for scale in [1.0f32, 0.37, 0.13, 0.031, 2.7] {
        for quarter in [0u8, 1] {
            let (w, h) = (
                (cw as f32 * scale).round().max(1.0) as u32,
                (ch as f32 * scale).round().max(1.0) as u32,
            );
            let (w, h) = if quarter == 1 { (h, w) } else { (w, h) };
            let mut draw = plain((0, 0, w, h), crop);
            draw.turn = Turn {
                quarter,
                flip_h: true,
                flip_v: false,
            };
            let out = r.render_offscreen(&image, &draw, &identity).unwrap();
            let red = out.data.chunks_exact(4).map(|p| p[0]).max().unwrap();
            assert_eq!(red, 0, "缩放 {scale}、转 {quarter}：漏出了局部以外的像素");
        }
    }
}

/// 缩到 `fit-<宽>` 同一宽度时与正式派生图（`render_sdr`）逐像素比较：均值、p99、最大差（8 位）。
fn compare(a: &RgbaImage, b: &RgbaImage) -> (f64, u8, u8) {
    assert_eq!(a.dimensions(), b.dimensions());
    let mut diffs: Vec<u8> = a
        .pixels()
        .zip(b.pixels())
        .flat_map(|(p, q)| (0..3).map(move |c| p[c].abs_diff(q[c])))
        .collect();
    let mean = diffs.iter().map(|&d| f64::from(d)).sum::<f64>() / diffs.len() as f64;
    diffs.sort_unstable();
    let p99 = diffs[(diffs.len() - 1) * 99 / 100];
    (mean, p99, *diffs.last().unwrap())
}

/// 一张图缩到各个宽度：GPU 画出的手势帧（全尺寸 mip 三线性）与停手帧（精确尺寸派生图 1:1）
/// 各自与正式派生图比，返回表格的行与手势帧的（最大均值，最大 p99，最大差）。
fn downscale_table(r: &Renderer, source: &RgbaImage, label: &str) -> (String, (f64, u8, u8)) {
    let bytes = png(source, None);
    let image = upload(r, &pin_colour::derivative(&bytes).unwrap());
    let identity = lut(r, &PinLut::Identity);
    let mut rows = String::new();
    let mut worst = (0f64, 0u8, 0u8);
    for width in [300u32, 500, 1000, 1300, 1900] {
        let derivative = render_sdr(&bytes, width, Downscale::LinearLight).unwrap();
        let reference = image::load_from_memory(&derivative.bytes)
            .unwrap()
            .into_rgba8();
        let (w, h) = reference.dimensions();
        let gesture = straight(
            &r.render_offscreen(&image, &plain((0, 0, w, h), full(source)), &identity)
                .unwrap(),
        );
        let exact_pixels = pin_colour::derivative(&derivative.bytes).unwrap();
        let exact = straight(
            &r.render_offscreen(
                &upload(r, &exact_pixels),
                &plain((0, 0, w, h), full(&reference)),
                &identity,
            )
            .unwrap(),
        );
        assert_same(&exact, &reference, &format!("{label} 停手帧 {w}"));
        let (mean, p99, max) = compare(&gesture, &reference);
        rows += &format!(
            "| {label} | {w} | 均值 {mean:.2}，p99 {p99}，最大 {max} | 0 |
"
        );
        worst = (worst.0.max(mean), worst.1.max(p99), worst.2.max(max));
    }
    (rows, worst)
}

#[test]
fn downscaling_on_the_gpu_is_close_to_the_formal_derivative() {
    let r = renderer();
    let (smooth, (mean, p99, max)) = downscale_table(&r, &test_image(2400, 1600, false), "平滑");
    let (harsh, (harsh_mean, _, _)) = downscale_table(&r, &photo(2400, 1600), "硬边＋细线＋噪声");
    println!(
        "| 测试图 | 输出宽度 | 手势帧（全尺寸 mip 三线性） | 停手帧（精确尺寸派生图 1:1）最大差 |
|---|---|---|---|
{smooth}{harsh}"
    );
    // 平滑过渡上两者几乎相同（几何对齐、线性光插值都对）；差别集中在硬边：线性光 Lanczos3
    // 在暗侧的振铃对比 mip 的柔化，这是 ADR 0010 意义上的替身，停手后换成派生图。
    assert!(mean < 0.5 && p99 <= 2 && max <= 3, "{smooth}");
    assert!(harsh_mean < 6.0, "{harsh}");
}
