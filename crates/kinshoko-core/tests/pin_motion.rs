//! 钉图窗口与窗口区域（#64、#193）：窗口静止时就是显示器那么大，内容只在窗口里动，
//! 显示与点击由窗口区域限定在钉图本身。窗口原点在内容静止时不动，WebView2 晚画的一两帧就不会让
//! 画面抽搐或被裁掉。

use kinshoko_core::desktop::{
    Change, DeskPin, EdgeHide, ScreenRect, Stage, pin_surface, region_in_window, settle, stage,
};

const MONITOR: ScreenRect = rect(0, 0, 1920, 1080);
const RIGHT: ScreenRect = rect(1920, 0, 1920, 1080);
/// 左边一台，原点在负坐标。
const LEFT: ScreenRect = rect(-1920, 0, 1920, 1080);
/// 钉图在 [`MONITOR`] 上时的窗口：让出最下面一行，免得被当作全屏程序。
const ON_MONITOR: ScreenRect = rect(0, 0, 1920, 1079);
/// 钉图在 [`MONITOR`] 与 [`RIGHT`] 两台上时的窗口。
const ON_BOTH: ScreenRect = rect(0, 0, 3840, 1079);

const fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
    ScreenRect {
        x,
        y,
        width,
        height,
    }
}

#[test]
fn a_pin_window_is_the_monitor_its_content_is_on_short_of_the_bottom_row() {
    // 置顶窗口整个盖住显示器时，Windows 当作有全屏程序在跑，把通知压下（本机实测 QUNS_BUSY），
    // 窗口区域再小也一样。
    assert_eq!(
        pin_surface(rect(100, 100, 400, 300), &[MONITOR, RIGHT]),
        ON_MONITOR
    );
}

#[test]
fn a_pin_across_two_monitors_gets_a_window_over_both() {
    assert_eq!(
        pin_surface(rect(1800, 100, 400, 300), &[MONITOR, RIGHT]),
        ON_BOTH
    );
}

#[test]
fn a_window_over_monitors_of_different_heights_covers_none_of_them_whole() {
    // 让出最下面一行后，矮的那台仍整个在窗口里：再让出最上面一行。
    let tall = rect(1920, 0, 2560, 1440);
    let w = pin_surface(rect(1800, 100, 400, 300), &[MONITOR, tall]);
    assert_eq!(w, rect(0, 1, 4480, 1438));
    assert!(!w.contains(&MONITOR) && !w.contains(&tall));
}

#[test]
fn a_pin_off_every_monitor_keeps_a_window_of_its_own_size() {
    let lost = rect(5000, 5000, 400, 300);
    assert_eq!(pin_surface(lost, &[MONITOR]), lost);
}

#[test]
fn zooming_in_only_widens_the_region_and_never_moves_the_window() {
    // #193：放大时窗口原点往左上移，原生窗口立刻到位而页面晚 1～2 帧，画面先抽搐再被裁掉。
    let from = rect(200, 150, 200, 100);
    let to = rect(100, 100, 400, 200);
    assert_eq!(
        stage(ON_MONITOR, Some(from), to, Change::Stay, &[MONITOR]),
        Stage {
            window: ON_MONITOR,
            during: Some(rect(100, 100, 400, 200)),
        }
    );
}

#[test]
fn zooming_out_keeps_the_old_region_until_the_page_has_drawn() {
    let from = rect(100, 100, 400, 200);
    let to = rect(200, 150, 200, 100);
    let s = stage(ON_MONITOR, Some(from), to, Change::Stay, &[MONITOR]);
    assert_eq!(s.during, Some(from), "先不缩：页面还没画到新位置");
    assert_eq!(settle(s.window, to, &[MONITOR]), (ON_MONITOR, Some(to)));
}

#[test]
fn wheel_steps_keep_widening_the_region_until_it_settles() {
    // 滚轮连续几格：页面可能还停在前一格，区域要盖住此前所有位置。
    let a = rect(200, 150, 200, 100);
    let b = rect(150, 120, 300, 150);
    let c = rect(400, 300, 100, 50);
    let first = stage(ON_MONITOR, Some(a), b, Change::Stay, &[MONITOR]).during;
    let second = stage(ON_MONITOR, first, c, Change::Stay, &[MONITOR]).during;
    assert_eq!(second, Some(rect(150, 120, 350, 230)));
}

#[test]
fn the_region_never_reaches_past_the_window() {
    // 收到左边：屏幕外的部分本来就看不见。
    let home = rect(100, 400, 200, 100);
    let hidden = rect(-194, 400, 200, 100);
    let s = stage(ON_MONITOR, Some(home), hidden, Change::Stay, &[MONITOR]);
    assert_eq!(s.window, ON_MONITOR);
    assert_eq!(s.during, Some(rect(0, 400, 300, 100)));
    assert_eq!(
        settle(ON_MONITOR, hidden, &[MONITOR]).1,
        Some(rect(0, 400, 6, 100))
    );
}

#[test]
fn dragging_within_a_monitor_never_touches_the_window() {
    let from = rect(100, 100, 200, 100);
    let to = rect(160, 130, 200, 100);
    let s = stage(ON_MONITOR, Some(from), to, Change::Drag, &[MONITOR, RIGHT]);
    assert_eq!(s.window, ON_MONITOR);
    assert_eq!(s.during, Some(rect(100, 100, 260, 130)));
}

#[test]
fn dragging_onto_another_monitor_switches_the_window_while_dragging() {
    let monitors = [MONITOR, RIGHT];
    let crossing = stage(
        ON_MONITOR,
        Some(rect(1600, 100, 200, 100)),
        rect(1800, 100, 200, 100),
        Change::Drag,
        &monitors,
    );
    assert_eq!(crossing.window, ON_BOTH);
    let over = stage(
        crossing.window,
        crossing.during,
        rect(2000, 100, 200, 100),
        Change::Drag,
        &monitors,
    );
    assert_eq!(
        over.window,
        rect(1920, 0, 1920, 1079),
        "离开左边那台时就在拖动中缩回，不留到静止时"
    );
    assert_eq!(over.during, Some(rect(1920, 100, 280, 100)));
}

#[test]
fn zooming_across_a_monitor_edge_widens_the_window_once() {
    let monitors = [MONITOR, RIGHT];
    let s = stage(
        ON_MONITOR,
        Some(rect(1700, 100, 200, 100)),
        rect(1600, 50, 400, 200),
        Change::Stay,
        &monitors,
    );
    assert_eq!(s.window, ON_BOTH);
    assert_eq!(s.during, Some(rect(1600, 50, 400, 200)));
}

#[test]
fn settling_shrinks_the_window_only_when_its_origin_stays() {
    // 缩回左边那台：原点不动，画面不跳。
    assert_eq!(
        settle(ON_BOTH, rect(100, 100, 200, 100), &[MONITOR, RIGHT]),
        (ON_MONITOR, Some(rect(100, 100, 200, 100)))
    );
    // 缩回右边那台要挪原点：留着大窗口，等下次拖动再换。
    assert_eq!(
        settle(ON_BOTH, rect(2000, 100, 200, 100), &[MONITOR, RIGHT]),
        (ON_BOTH, Some(rect(2000, 100, 200, 100)))
    );
    // 左边那台在负坐标上：缩回主显示器要挪原点，同样不缩。
    let wide = rect(-1920, 0, 3840, 1079);
    assert_eq!(
        settle(wide, rect(100, 100, 200, 100), &[LEFT, MONITOR]).0,
        wide
    );
}

#[test]
fn the_region_is_set_relative_to_the_window() {
    let window = rect(-1920, 0, 3840, 1079);
    assert_eq!(
        region_in_window(window, rect(-100, 50, 300, 200)),
        (1820, 50, 2120, 250)
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
        "收起时窗口让点击穿过，只有细边露在屏幕上"
    );
    assert_eq!(edge.peeking("b"), None);
    edge.hover((3, 450));
    assert_eq!(edge.peeking("a"), Some(true));
}

#[test]
fn sliding_out_and_back_never_touches_the_native_window() {
    let mut edge = tucked_left();
    let hidden = rect(-194, 400, 200, 100);
    let out = edge.hover((3, 450));
    let peek = rect(out[0].x, out[0].y, 200, 100);
    let s = stage(
        ON_MONITOR,
        Some(rect(0, 400, 6, 100)),
        peek,
        Change::Stay,
        &[MONITOR],
    );
    assert_eq!(s.window, ON_MONITOR);
    let back = edge.hover((900, 450));
    let again = rect(back[0].x, back[0].y, 200, 100);
    assert_eq!(again, hidden);
    assert_eq!(
        stage(ON_MONITOR, s.during, again, Change::Stay, &[MONITOR]).window,
        ON_MONITOR
    );
}
