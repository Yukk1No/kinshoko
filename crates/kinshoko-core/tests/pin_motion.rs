//! 钉图的缩放与贴边动画（#64）：动画在窗口里变换内容，不逐帧调整原生窗口（#7 的结论）。
//! 一次动画里窗口最多改两次：开始时放大到装得下整个过渡（需要时），结束时改成静止时的矩形。

use kinshoko_core::desktop::{DeskPin, EdgeHide, ScreenRect, Stage, stage};

const MONITOR: ScreenRect = rect(0, 0, 1920, 1080);

const fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
    ScreenRect {
        x,
        y,
        width,
        height,
    }
}

#[test]
fn zooming_out_animates_inside_the_window_and_shrinks_it_once_at_the_end() {
    let window = rect(100, 100, 400, 200);
    let to = rect(200, 150, 200, 100);
    assert_eq!(
        stage(window, to, to, &[MONITOR]),
        Stage {
            during: window,
            after: to,
        }
    );
}

#[test]
fn zooming_in_grows_the_window_once_to_hold_the_whole_animation() {
    let window = rect(200, 150, 200, 100);
    let to = rect(100, 100, 400, 200);
    assert_eq!(
        stage(window, to, to, &[MONITOR]),
        Stage {
            during: rect(100, 100, 400, 200),
            after: to,
        }
    );
}

#[test]
fn zooming_from_the_corner_only_grows_right_and_down() {
    // 拖右下角缩放时左上角不动，窗口原点也不动：内容不会因为窗口移动跳一下。
    let window = rect(200, 150, 200, 100);
    let to = rect(200, 150, 260, 130);
    let s = stage(window, to, to, &[MONITOR]);
    assert_eq!((s.during.x, s.during.y), (200, 150));
    assert_eq!(s.during, to);
}

#[test]
fn the_window_never_grows_past_the_screen_during_an_animation() {
    // 收到左边：屏幕外的部分本来就看不见，过渡时窗口只铺到屏幕边。
    let home = rect(100, 400, 200, 100);
    let hidden = rect(-194, 400, 200, 100);
    let tucked = rect(-194, 400, 394, 100);
    assert_eq!(
        stage(home, hidden, tucked, &[MONITOR]),
        Stage {
            during: rect(0, 400, 300, 100),
            after: tucked,
        }
    );
}

#[test]
fn spanning_two_monitors_the_window_may_cover_both() {
    let right = rect(1920, 0, 1920, 1080);
    let window = rect(1800, 100, 100, 100);
    let to = rect(1850, 100, 200, 100);
    let s = stage(window, to, to, &[MONITOR, right]);
    assert_eq!(s.during, rect(1800, 100, 250, 100));
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
fn a_hidden_pin_rests_in_a_window_whose_on_screen_part_is_where_it_slides_out() {
    let edge = tucked_left();
    let tuck = edge.tuck("a").unwrap();
    assert_eq!(tuck.stage, rect(-194, 400, 394, 100));
    assert!(!tuck.peeking, "收起时窗口让点击穿过，只有细边露在屏幕上");
    assert_eq!(edge.tuck("b"), None);
}

#[test]
fn sliding_out_and_back_never_touches_the_native_window() {
    let mut edge = tucked_left();
    let tucked = edge.tuck("a").unwrap().stage;
    let out = edge.hover((3, 450));
    let peek = rect(out[0].x, out[0].y, 200, 100);
    assert_eq!(stage(tucked, peek, tucked, &[MONITOR]).during, tucked);
    assert!(edge.tuck("a").unwrap().peeking);
    let back = edge.hover((900, 450));
    let hidden = rect(back[0].x, back[0].y, 200, 100);
    assert_eq!(
        stage(tucked, hidden, tucked, &[MONITOR]),
        Stage {
            during: tucked,
            after: tucked,
        }
    );
}

#[test]
fn a_hidden_pin_on_the_right_edge_rests_past_the_right_of_the_screen() {
    let mut edge = EdgeHide::default();
    edge.toggle(&[DeskPin {
        id: "r".into(),
        home: rect(1700, 500, 200, 100),
        monitor: MONITOR,
    }]);
    assert_eq!(edge.tuck("r").unwrap().stage, rect(1720, 500, 394, 100));
}
