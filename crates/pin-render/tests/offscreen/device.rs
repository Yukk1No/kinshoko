//! 设备丢失后重建，以及查找表布局与核心一致。

use super::*;
use crate::golden::with_edge;

#[test]
fn after_device_loss_a_rebuild_draws_the_same_frame() {
    let mut r = renderer();
    let source = photo(90, 60);
    let pixels = pin_colour::derivative(&png(&source, None)).unwrap();
    let table = pin_colour::lut(None, Some(&pin_gate::calibrated_display_icc())).unwrap();
    let mut draw = with_edge((10, 10, 45, 30), 8, full(&source));
    draw.ring = 1.0;
    draw.turn.quarter = 3;
    draw.content = Rect::new(10.0, 10.0, 30.0, 45.0);
    draw.window = window_at(2, 2, 46, 61);

    let image = upload(&r, &pixels);
    let before_lut = lut(&r, &table);
    let before = r.render_offscreen(&image, &draw, &before_lut).unwrap();

    r.simulate_device_loss();
    assert!(r.is_lost());
    assert_eq!(
        r.render_offscreen(&image, &draw, &before_lut),
        Err(Error::DeviceLost)
    );

    r.rebuild().unwrap();
    assert!(!r.is_lost());
    assert_eq!(
        r.render_offscreen(&image, &draw, &before_lut).err(),
        Some(Error::Stale),
        "旧设备上的句柄不能再用"
    );
    let after = r
        .render_offscreen(&upload(&r, &pixels), &draw, &lut(&r, &table))
        .unwrap();
    assert_eq!(after, before);
}

#[test]
fn the_lut_layout_is_the_one_pin_colour_writes() {
    assert_eq!(pin_render::LUT_SIZE, pin_colour::LUT_SIZE);
    assert_eq!(pin_render::LUT_DOMAIN, pin_colour::LUT_DOMAIN);
    assert_eq!(pin_render::CURVE_SIZE, pin_colour::CURVE_SIZE);
}
