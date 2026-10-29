//! 说明层：形状有金样；字随系统字体不同，只核对摆放与有没有字。

use std::path::PathBuf;

use super::*;

fn pixel(p: &Painted, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * p.width + x) * 4) as usize;
    [p.rgba[i], p.rgba[i + 1], p.rgba[i + 2], p.rgba[i + 3]]
}

fn lock() -> Caption {
    Caption {
        lock: true,
        ..Caption::default()
    }
}

#[test]
fn nothing_to_say_paints_nothing() {
    assert_eq!(
        Painter::default().paint(&Caption::default(), (400, 300), 1.0, false),
        None
    );
}

#[test]
fn the_lock_is_a_28px_seal_circle_centred_on_the_pin() {
    let p = Painter::default()
        .paint(&lock(), (400, 300), 1.5, false)
        .unwrap();
    assert_eq!((p.width, p.height), (42, 42));
    assert_eq!(p.at, ((400 - 42) / 2, (300 - 42) / 2));
    assert_eq!(pixel(&p, 0, 0)[3], 0, "圆外透明");
    assert_eq!(pixel(&p, 4, 21), [0xc8, 0x56, 0x72, 255], "圆是 --seal-acc");
    assert_eq!(
        pixel(&p, 21, 28),
        [0x2b, 0x27, 0x47, 255],
        "锁身是 --on-accent"
    );
    let dark = Painter::default()
        .paint(&lock(), (400, 300), 1.5, true)
        .unwrap();
    assert_eq!(pixel(&dark, 4, 21), [0xe3, 0xb3, 0x4f, 255]);
}

#[test]
fn golden_lock() {
    let p = Painter::default()
        .paint(&lock(), (100, 100), 2.0, false)
        .unwrap();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/desktop/pins/native/caption/golden-lock.png");
    let got = image::RgbaImage::from_raw(p.width, p.height, p.rgba).unwrap();
    if std::env::var_os("PIN_RENDER_BLESS").is_some() {
        got.save(&path).unwrap();
        return;
    }
    let want = image::open(&path).unwrap().into_rgba8();
    assert_eq!(got, want, "与金样不同（PIN_RENDER_BLESS=1 重新生成）");
}

#[test]
fn a_notice_sits_6px_above_the_bottom_on_a_scrim() {
    let caption = Caption {
        notice: Some("已锁定".into()),
        ..Caption::default()
    };
    let p = Painter::default()
        .paint(&caption, (400, 300), 1.0, false)
        .unwrap();
    assert_eq!(p.at.1 + p.height as i32, 300 - 6);
    assert_eq!((400 - p.width as i32) / 2, p.at.0, "水平居中");
    assert!(p.height >= 16 + 4 && p.height < 30, "{}", p.height);
    // 底是黑色 60%，字是白的。
    assert_eq!(pixel(&p, 2, p.height / 2), [0, 0, 0, 153]);
    let white = (0..p.width)
        .flat_map(|x| (0..p.height).map(move |y| (x, y)))
        .any(|(x, y)| pixel(&p, x, y)[0] > 200);
    assert!(white, "写了字");
}

#[test]
fn a_long_notice_is_cut_to_the_pin_width() {
    let caption = Caption {
        notice: Some("截图要先收藏进图库，才能加入参考组".repeat(4)),
        ..Caption::default()
    };
    let p = Painter::default()
        .paint(&caption, (200, 300), 1.0, false)
        .unwrap();
    assert!(p.width <= 200 - 12, "{}", p.width);
    assert!(p.height < 30, "一行");
}

#[test]
fn the_reason_wraps_inside_the_pin_and_is_centred() {
    let caption = Caption {
        reason: Some("参考图无法读取：图库没有打开，或原图已缺失".into()),
        ..Caption::default()
    };
    let p = Painter::default()
        .paint(&caption, (120, 300), 1.0, false)
        .unwrap();
    assert!(p.width <= 120 - 16, "{}", p.width);
    assert!(p.height >= 32, "换了行：{}", p.height);
    assert_eq!(p.at.1, (300 - p.height as i32) / 2);
}

#[test]
fn lock_and_notice_share_one_overlay() {
    let caption = Caption {
        lock: true,
        notice: Some("已复制".into()),
        ..Caption::default()
    };
    let p = Painter::default()
        .paint(&caption, (400, 300), 1.0, false)
        .unwrap();
    assert_eq!(p.at.1, (300 - 28) / 2, "从小圆锁的顶开始");
    assert_eq!(p.at.1 + p.height as i32, 300 - 6, "到提示的底");
}
