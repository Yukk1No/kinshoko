//! 金样：阴影、增强边缘、遮罩与叠加层。

use super::*;

fn golden(name: &str, out: &pin_render::RgbaImage) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(format!("{name}.png"));
    let got = straight(out);
    if std::env::var_os("PIN_RENDER_BLESS").is_some() {
        std::fs::write(&path, png(&got, None)).unwrap();
        return;
    }
    let want = image::open(&path)
        .unwrap_or_else(|e| panic!("读不了金样 {}：{e}", path.display()))
        .into_rgba8();
    assert_eq!(got.dimensions(), want.dimensions(), "{name} 尺寸不同");
    // 不同显卡（含 WARP）的 exp、pow 实现略有差别，允许每个分量差 2 级。
    let worst = got
        .pixels()
        .zip(want.pixels())
        .flat_map(|(a, b)| (0..4).map(move |c| a[c].abs_diff(b[c])))
        .max()
        .unwrap();
    assert!(worst <= 2, "{name} 与金样最多差 {worst} 级");
}

/// 金样用的小图：40×30，上半暖色、下半冷色，中间一条亮线。
fn small() -> RgbaImage {
    RgbaImage::from_fn(40, 30, |x, y| {
        if y == 15 {
            image::Rgba([250, 250, 240, 255])
        } else if y < 15 {
            image::Rgba([200, (80 + x * 3) as u8, 40, 255])
        } else {
            image::Rgba([30, 90, (120 + x * 3) as u8, 255])
        }
    })
}

/// 窗口比内容四周各大 `edge`。
pub(super) fn with_edge(content: (i32, i32, u32, u32), edge: u32, crop: Rect) -> Draw<'static> {
    let (x, y, w, h) = content;
    let e = edge as i32;
    let mut draw = Draw::new(
        window_at(x - e, y - e, w + 2 * edge, h + 2 * edge),
        Rect::new(x as f32, y as f32, w as f32, h as f32),
        crop,
    );
    draw.edge = edge as f32;
    draw
}

#[test]
fn golden_shadow() {
    let r = renderer();
    let source = small();
    let image = upload(&r, &pin_colour::derivative(&png(&source, None)).unwrap());
    let identity = lut(&r, &PinLut::Identity);
    let mut draw = with_edge((100, 50, 40, 30), 8, full(&source));
    draw.opacity = 0.75;
    let out = r.render_offscreen(&image, &draw, &identity).unwrap();
    golden("shadow", &out);

    // 阴影那一圈最外沿也能命中；圈外完全透明。
    for (x, y) in [(0, 0), (55, 0), (0, 45), (55, 45), (27, 0)] {
        assert!(out.pixel(x, y)[3] >= 1, "({x}, {y}) 的 alpha 是 0");
    }
    let mut wide = with_edge((100, 50, 40, 30), 8, full(&source));
    wide.window = window_at(80, 30, 80, 70);
    let out = r.render_offscreen(&image, &wide, &identity).unwrap();
    assert_eq!(out.pixel(0, 0), [0, 0, 0, 0]);
    assert_eq!(out.pixel(11, 11), [0, 0, 0, 0]);
    assert!(out.pixel(12, 12)[3] >= 1);
}

#[test]
fn golden_enhanced_edge() {
    let r = renderer();
    let source = small();
    let image = upload(&r, &pin_colour::derivative(&png(&source, None)).unwrap());
    let identity = lut(&r, &PinLut::Identity);
    let mut draw = with_edge((100, 50, 40, 30), 8, full(&source));
    draw.ring = 1.0;
    let out = r.render_offscreen(&image, &draw, &identity).unwrap();
    golden("enhanced-edge", &out);
    // 紧贴内容外沿的那一圈是浅色细线（白 60% 盖在阴影上）。
    let ring = out.pixel(7, 20);
    assert!(ring[0] > 140 && ring[3] > 170, "{ring:?}");

    // 没有阴影时细线照画：白 60% 盖在透明上。
    let mut bare = Draw::new(
        window_at(99, 49, 42, 32),
        Rect::new(100.0, 50.0, 40.0, 30.0),
        full(&source),
    );
    bare.ring = 1.0;
    let out = r.render_offscreen(&image, &bare, &identity).unwrap();
    for p in [out.pixel(0, 0), out.pixel(0, 10), out.pixel(41, 31)] {
        assert!(p.iter().all(|&v| v.abs_diff(153) <= 1), "{p:?}");
    }
}

#[test]
fn golden_veil() {
    let r = renderer();
    // 遮蔽只取 64 px 的派生图，放大显示，模糊 14 px，盖 92% 墨色；中间一枚说明层（小圆锁）。
    let source = photo(64, 48);
    let image = upload(&r, &pin_colour::derivative(&png(&source, None)).unwrap());
    let identity = lut(&r, &PinLut::Identity);
    let lock = RgbaImage::from_fn(12, 12, |x, y| {
        let d = ((x as f32 - 5.5).powi(2) + (y as f32 - 5.5).powi(2)).sqrt();
        if d < 6.0 {
            image::Rgba([227, 179, 79, 255])
        } else {
            image::Rgba([0, 0, 0, 0])
        }
    });
    let overlay = r.overlay(12, 12, lock.as_raw()).unwrap();
    let mut draw = with_edge((0, 0, 160, 120), 8, full(&source));
    draw.veil = Some(Veil {
        amount: 1.0,
        blur: 14.0,
        ink: [
            0x2b as f32 / 255.0,
            0x27 as f32 / 255.0,
            0x47 as f32 / 255.0,
            0.92,
        ],
    });
    draw.overlay = Some((&overlay, [74.0, 54.0]));
    let out = r.render_offscreen(&image, &draw, &identity).unwrap();
    golden("veil", &out);
    // 说明层画在最上面、1:1。
    assert_eq!(out.pixel(8 + 79, 8 + 59), [227, 179, 79, 255]);

    // 淡出到 0 时就是原图放大（Catmull-Rom），没有墨色。
    draw.veil = Some(Veil {
        amount: 0.0,
        ..draw.veil.unwrap()
    });
    draw.overlay = None;
    let clear = r.render_offscreen(&image, &draw, &identity).unwrap();
    let mut plain_draw = with_edge((0, 0, 160, 120), 8, full(&source));
    plain_draw.veil = None;
    assert_eq!(
        clear,
        r.render_offscreen(&image, &plain_draw, &identity).unwrap()
    );
}

// ---- 设备丢失 -------------------------------------------------------------------------------
