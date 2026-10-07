//! 贴边隐藏（#63）：按一次把全部钉图收到所在显示器最近的边、只露细边；指针碰到细边时
//! 该钉图滑出，离开后收回；再按一次全部回到原位。原位不因隐藏而改变。

use kinshoko_core::desktop::{DeskPin, EdgeHide, PEEK_SLACK, PinMove, SLIVER, ScreenRect};

const MONITOR: ScreenRect = ScreenRect {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
};

fn desk(id: &str, x: i32, y: i32, width: u32, height: u32) -> DeskPin {
    DeskPin {
        id: id.into(),
        home: ScreenRect {
            x,
            y,
            width,
            height,
        },
        monitor: MONITOR,
    }
}

fn mv(pin: &str, x: i32, y: i32) -> PinMove {
    PinMove {
        pin: pin.into(),
        x,
        y,
    }
}

#[test]
fn hiding_tucks_each_pin_into_its_nearest_edge_leaving_a_sliver() {
    let s = SLIVER as i32;
    let pins = [
        desk("left", 100, 400, 200, 100),
        desk("right", 1700, 500, 200, 100),
        desk("top", 900, 30, 100, 200),
        desk("bottom", 900, 1000, 100, 60),
    ];
    let mut edge = EdgeHide::default();
    let toggle = edge.toggle(&pins);
    assert!(toggle.hidden);
    assert_eq!(
        toggle.moves,
        vec![
            mv("left", -200 + s, 400),
            mv("right", 1920 - s, 500),
            mv("top", 900, -200 + s),
            mv("bottom", 900, 1080 - s),
        ]
    );
}

#[test]
fn pressing_again_brings_every_pin_back_to_where_it_was() {
    let pins = [desk("a", 100, 400, 200, 100), desk("b", 1500, 600, 50, 50)];
    let mut edge = EdgeHide::default();
    edge.toggle(&pins);
    let toggle = edge.toggle(&pins);
    assert!(!toggle.hidden);
    assert_eq!(toggle.moves, vec![mv("a", 100, 400), mv("b", 1500, 600)]);
    assert!(!edge.is_hidden("a"));
}

#[test]
fn touching_the_sliver_slides_that_pin_out_and_leaving_slides_it_back() {
    let pins = [desk("a", 100, 400, 200, 100), desk("b", 100, 700, 200, 100)];
    let mut edge = EdgeHide::default();
    edge.toggle(&pins);
    // 细边是屏幕最左边 6 像素。
    assert_eq!(edge.hover((3, 450)), vec![mv("a", 0, 400)]);
    // 停在滑出的钉图上：不动。
    assert_eq!(edge.hover((150, 450)), vec![]);
    // 离开但还在余量内：不动。
    let slack = PEEK_SLACK as i32;
    assert_eq!(edge.hover((200 + slack - 1, 450)), vec![]);
    assert_eq!(
        edge.hover((200 + slack + 1, 450)),
        vec![mv("a", -200 + SLIVER as i32, 400)]
    );
    assert!(edge.is_hidden("a") && edge.is_hidden("b"));
}

#[test]
fn the_pointer_away_from_the_slivers_moves_nothing() {
    let mut edge = EdgeHide::default();
    edge.toggle(&[desk("a", 100, 400, 200, 100)]);
    assert_eq!(edge.hover((3, 100)), vec![]);
    assert_eq!(edge.hover((960, 540)), vec![]);
}

#[test]
fn hover_does_nothing_while_pins_are_shown() {
    let mut edge = EdgeHide::default();
    assert_eq!(edge.hover((0, 0)), vec![]);
}

#[test]
fn a_new_pin_while_others_are_hidden_makes_the_next_press_hide_it_too() {
    let mut edge = EdgeHide::default();
    edge.toggle(&[desk("a", 100, 400, 200, 100)]);
    let toggle = edge.toggle(&[desk("a", 100, 400, 200, 100), desk("b", 1500, 600, 50, 50)]);
    assert!(toggle.hidden);
    assert_eq!(toggle.moves, vec![mv("b", 1920 - SLIVER as i32, 600)]);
}

#[test]
fn a_pin_the_artist_drags_out_is_no_longer_hidden() {
    let mut edge = EdgeHide::default();
    edge.toggle(&[desk("a", 100, 400, 200, 100)]);
    edge.hover((3, 450));
    edge.release("a");
    assert!(!edge.is_hidden("a"));
    assert_eq!(edge.hover((300, 450)), vec![]);
}

#[test]
fn a_pin_partly_off_screen_keeps_its_sliver_on_the_screen() {
    let mut edge = EdgeHide::default();
    // 左上都伸出屏幕的钉图贴左边时，细边要整条落在屏幕里。
    let toggle = edge.toggle(&[desk("a", -30, -20, 300, 100)]);
    assert_eq!(toggle.moves, vec![mv("a", -300 + SLIVER as i32, 0)]);
}
