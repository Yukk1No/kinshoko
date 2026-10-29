//! 钉图的缩放、旋转与翻转（#63）：窗口尺寸按物理像素取整，与前端 canvas 的算法一致；
//! 缩放时锚点（光标或按住的角）不动，旋转时中心不动。

use kinshoko_core::desktop::{MAX_SCALE, MIN_SIDE, PinContent, Placement, SavedPin, ScreenRect};

fn pin(width: u32, height: u32, x: i32, y: i32) -> SavedPin {
    SavedPin {
        id: "p".into(),
        content: PinContent::Capture {
            capture_id: "c".into(),
        },
        crop: None,
        width,
        height,
        placement: Placement {
            x,
            y,
            ..Placement::default()
        },
        opacity: 1.0,
        locked: false,
        member: None,
    }
}

fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
    ScreenRect {
        x,
        y,
        width,
        height,
    }
}

#[test]
fn an_unscaled_pin_is_exactly_the_size_of_its_image() {
    assert_eq!(pin(151, 97, 10, 20).rect(), rect(10, 20, 151, 97));
}

#[test]
fn zooming_keeps_the_point_under_the_cursor_still() {
    let mut p = pin(100, 50, 200, 100);
    // 光标在窗口正中。
    p.zoom(2.0, (250.0, 125.0));
    assert_eq!(p.rect(), rect(150, 75, 200, 100));
}

#[test]
fn dragging_the_bottom_right_corner_keeps_the_top_left_corner_still() {
    let mut p = pin(101, 37, 200, 100);
    p.zoom(1.5, (200.0, 100.0));
    assert_eq!(p.rect(), rect(200, 100, 152, 56));
}

#[test]
fn a_pin_cannot_shrink_to_a_dot_or_grow_without_bound() {
    let mut p = pin(200, 100, 0, 0);
    p.zoom(0.0001, (0.0, 0.0));
    assert_eq!(p.window_size().0, MIN_SIDE);
    p.zoom(1e9, (0.0, 0.0));
    assert_eq!(p.placement.scale, MAX_SCALE);
}

#[test]
fn rotating_swaps_width_and_height_around_the_centre() {
    let mut p = pin(40, 10, 100, 100);
    p.rotate(1);
    assert_eq!(p.placement.rotation, 1);
    assert_eq!(p.rect(), rect(115, 85, 10, 40));
    p.rotate(-2);
    assert_eq!(p.placement.rotation, 3);
    p.rotate(1);
    assert_eq!(p.rect(), rect(100, 100, 40, 10));
}

#[test]
fn flipping_mirrors_what_the_artist_sees_even_when_rotated() {
    let mut p = pin(40, 10, 0, 0);
    p.flip(true);
    assert!(p.placement.flip_h && !p.placement.flip_v);
    p.flip(true);
    p.rotate(1);
    // 转了 90° 后，屏幕上的左右是图片的上下。
    p.flip(true);
    assert!(!p.placement.flip_h && p.placement.flip_v);
    assert_eq!(p.window_size(), (10, 40));
}
