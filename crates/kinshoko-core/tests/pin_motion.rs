//! 覆盖窗口让出的一行、钉图阴影的范围（ADR 0011、#239）与收起钉图的点击穿过（#63）。

use kinshoko_core::desktop::{DeskPin, EdgeHide, PIN_EDGE, ScreenRect, overlay_window, pin_area};

const MONITOR: ScreenRect = rect(0, 0, 1920, 1080);
/// 左边一台，原点在负坐标。
const LEFT: ScreenRect = rect(-1920, 0, 1920, 1080);

const fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
    ScreenRect {
        x,
        y,
        width,
        height,
    }
}

#[test]
fn an_overlay_covers_its_monitor_short_of_the_bottom_row() {
    // 置顶窗口整个盖住显示器时，Windows 当作有全屏程序在跑，把通知压下（本机实测 QUNS_BUSY），
    // 窗口区域再小也一样。
    assert_eq!(overlay_window(MONITOR), rect(0, 0, 1920, 1079));
    assert_eq!(overlay_window(LEFT), rect(-1920, 0, 1920, 1079));
}

#[test]
fn a_pin_takes_its_edge_around_it() {
    // #239：阴影画在钉图外面一圈，这一圈也算钉图（接点击、拖动）。
    let e = PIN_EDGE as i32;
    assert_eq!(
        pin_area(rect(100, 50, 300, 200)),
        rect(100 - e, 50 - e, 300 + 2 * PIN_EDGE, 200 + 2 * PIN_EDGE)
    );
}

#[test]
fn a_pin_edge_never_overflows_the_coordinate_range() {
    let far = pin_area(rect(i32::MIN, i32::MIN, 10, 10));
    assert_eq!((far.x, far.y), (i32::MIN, i32::MIN));
    assert_eq!(far.width, 10 + PIN_EDGE);
}

fn tucked_left() -> EdgeHide {
    let mut edge = EdgeHide::default();
    edge.toggle(&[DeskPin {
        id: "a".into(),
        home: rect(100, 400, 200, 100),
        monitor: MONITOR,
    }]);
    edge
}

#[test]
fn a_hidden_pin_lets_clicks_through_until_it_slides_out() {
    let mut edge = tucked_left();
    assert_eq!(
        edge.peeking("a"),
        Some(false),
        "收起时让点击穿过，只有细边露在屏幕上"
    );
    assert_eq!(edge.peeking("b"), None);
    edge.hover((3, 450));
    assert_eq!(edge.peeking("a"), Some(true));
    edge.hover((900, 450));
    assert_eq!(edge.peeking("a"), Some(false));
}
