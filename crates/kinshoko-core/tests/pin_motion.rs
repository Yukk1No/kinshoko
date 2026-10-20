//! 钉图层与窗口区域（#64、#193）：每台显示器一个铺满屏幕、从不移动的钉图层，钉图只在层里动，
//! 显示与点击由窗口区域限定在钉图本身。窗口原点永远不动，WebView2 晚画的一两帧就不会让画面抽搐
//! 或被裁掉。

use kinshoko_core::desktop::{
    DeskPin, EdgeHide, ScreenRect, layer_region, layer_window, layers_for, widen,
};

const MONITOR: ScreenRect = rect(0, 0, 1920, 1080);
const RIGHT: ScreenRect = rect(1920, 0, 1920, 1080);
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
fn a_layer_covers_its_monitor_short_of_the_bottom_row() {
    // 置顶窗口整个盖住显示器时，Windows 当作有全屏程序在跑，把通知压下（本机实测 QUNS_BUSY），
    // 窗口区域再小也一样。
    assert_eq!(layer_window(MONITOR), rect(0, 0, 1920, 1079));
    assert_eq!(layer_window(LEFT), rect(-1920, 0, 1920, 1079));
}

#[test]
fn a_pin_is_drawn_by_the_layer_of_every_monitor_it_touches() {
    let monitors = [LEFT, MONITOR, RIGHT];
    assert_eq!(
        layers_for(rect(100, 100, 400, 300), &monitors),
        vec![MONITOR]
    );
    // 跨在两台上：两个层各画自己那一半。
    assert_eq!(
        layers_for(rect(1800, 100, 400, 300), &monitors),
        vec![MONITOR, RIGHT]
    );
    assert_eq!(layers_for(rect(-100, 100, 50, 50), &monitors), vec![LEFT]);
}

#[test]
fn a_pin_off_every_monitor_has_no_layer() {
    assert!(layers_for(rect(5000, 5000, 400, 300), &[MONITOR]).is_empty());
}

#[test]
fn dragging_onto_another_monitor_hands_over_while_dragging() {
    // 拖到右边那台的过程中：先两个层都画，离开左边那台时只剩右边的层。层的窗口都不动。
    let monitors = [MONITOR, RIGHT];
    let a = rect(1600, 100, 200, 100);
    let b = rect(1800, 100, 200, 100);
    let c = rect(2000, 100, 200, 100);
    assert_eq!(layers_for(widen(a, b), &monitors), vec![MONITOR, RIGHT]);
    assert_eq!(layers_for(widen(b, c), &monitors), vec![MONITOR, RIGHT]);
    assert_eq!(
        layers_for(c, &monitors),
        vec![RIGHT],
        "停下以后区域缩回内容"
    );
}

#[test]
fn zooming_in_widens_the_region_before_the_page_draws() {
    // #193：放大时内容往左上长，区域先扩，页面晚画的那一两帧也不会被裁掉。
    let from = rect(200, 150, 200, 100);
    let to = rect(100, 100, 400, 200);
    assert_eq!(widen(from, to), to);
}

#[test]
fn zooming_out_keeps_the_old_region_until_the_page_has_drawn() {
    let from = rect(100, 100, 400, 200);
    let to = rect(200, 150, 200, 100);
    assert_eq!(widen(from, to), from, "先不缩：页面还没画到新位置");
}

#[test]
fn wheel_steps_keep_widening_the_region_until_it_settles() {
    // 滚轮连续几格：页面可能还停在前一格，区域要盖住此前所有位置。
    let a = rect(200, 150, 200, 100);
    let b = rect(150, 120, 300, 150);
    let c = rect(400, 300, 100, 50);
    assert_eq!(widen(widen(a, b), c), rect(150, 120, 350, 230));
}

#[test]
fn a_layer_region_is_every_pin_in_it_relative_to_the_window() {
    let window = layer_window(LEFT);
    assert_eq!(
        layer_region(window, &[rect(-100, 50, 300, 200), rect(-1900, 10, 20, 20)]),
        vec![(1820, 50, 1920, 250), (20, 10, 40, 30)],
        "跨到别的显示器的部分不在这个层里"
    );
    assert!(layer_region(window, &[rect(100, 50, 30, 20)]).is_empty());
}

#[test]
fn a_hidden_pin_shows_only_its_sliver_in_the_layer() {
    // 收到左边：屏幕外的部分本来就看不见。
    let hidden = rect(-194, 400, 200, 100);
    let window = layer_window(MONITOR);
    assert_eq!(layer_region(window, &[hidden]), vec![(0, 400, 6, 500)]);
}

#[test]
fn a_sliver_on_the_bottom_edge_loses_the_row_the_layer_gives_up() {
    let hidden = rect(500, 1074, 200, 100);
    assert_eq!(
        layer_region(layer_window(MONITOR), &[hidden]),
        vec![(500, 1074, 700, 1079)]
    );
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
