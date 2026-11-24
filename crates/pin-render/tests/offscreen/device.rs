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

#[test]
fn reuses_bind_group_across_uniform_only_updates_and_rebuilds_on_resource_change() {
    let r = renderer();
    let ref_r = renderer();
    let source = photo(90, 60);
    let pixels = pin_colour::derivative(&png(&source, None)).unwrap();
    let table = pin_colour::lut(None, Some(&pin_gate::calibrated_display_icc())).unwrap();

    let image1 = upload(&r, &pixels);
    let image2 = upload(&r, &pixels);
    let lut1 = lut(&r, &table);
    let lut2 = r.lut(LutData::Identity).unwrap();
    let overlay = r.overlay(4, 4, &[200u8; 4 * 4 * 4]).unwrap();

    let mut draw = with_edge((10, 10, 45, 30), 8, full(&source));
    draw.window = window_at(2, 2, 61, 46);

    assert_eq!(r.offscreen_bind_rebuilds(), 0);
    let _ = r.render_offscreen(&image1, &draw, &lut1).unwrap();
    assert_eq!(r.offscreen_bind_rebuilds(), 1);

    // 仅变化几何、旋转与透明度：应完全复用既有 BindGroup 与 Uniform Buffer，且输出像素与新建渲染器一致。
    draw.opacity = 0.7;
    draw.turn.quarter = 1;
    draw.content = Rect::new(10.0, 10.0, 30.0, 45.0);
    draw.window = window_at(2, 2, 46, 61);
    let updated = r.render_offscreen(&image1, &draw, &lut1).unwrap();
    assert_eq!(r.offscreen_bind_rebuilds(), 1);

    let ref_image = upload(&ref_r, &pixels);
    let ref_lut = lut(&ref_r, &table);
    let expected = ref_r.render_offscreen(&ref_image, &draw, &ref_lut).unwrap();
    assert_eq!(updated, expected);

    // 更换 Image、Lut 与 Overlay 时必须重建 BindGroup。
    let _ = r.render_offscreen(&image2, &draw, &lut1).unwrap();
    assert_eq!(r.offscreen_bind_rebuilds(), 2);

    let _ = r.render_offscreen(&image2, &draw, &lut2).unwrap();
    assert_eq!(r.offscreen_bind_rebuilds(), 3);

    draw.overlay = Some((&overlay, [12.0, 12.0]));
    let _ = r.render_offscreen(&image2, &draw, &lut2).unwrap();
    assert_eq!(r.offscreen_bind_rebuilds(), 4);

    draw.overlay = None;
    let _ = r.render_offscreen(&image2, &draw, &lut2).unwrap();
    assert_eq!(r.offscreen_bind_rebuilds(), 5);
}
