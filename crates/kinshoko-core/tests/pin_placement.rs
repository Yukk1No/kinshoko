//! 新钉图的位置（#62，#7 反馈）：略微偏离截取的位置，让画师一眼看出钉上了；
//! 不与已有钉图完全重叠；留在显示器内。

use kinshoko_core::desktop::{ScreenRect, place_new_pin};

const MONITOR: ScreenRect = ScreenRect {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
};
const STEP: i32 = 16;

fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
    ScreenRect {
        x,
        y,
        width,
        height,
    }
}

#[test]
fn a_new_pin_appears_slightly_offset_from_where_it_was_captured() {
    assert_eq!(
        place_new_pin(rect(300, 200, 120, 80), MONITOR, &[], STEP),
        (316, 216)
    );
}

#[test]
fn a_new_pin_does_not_land_exactly_on_an_existing_pin() {
    // 同一块区域截了两次：第二张再错开一步。
    let first = rect(316, 216, 120, 80);
    assert_eq!(
        place_new_pin(rect(300, 200, 120, 80), MONITOR, &[first], STEP),
        (332, 232)
    );
    let second = rect(332, 232, 120, 80);
    assert_eq!(
        place_new_pin(rect(300, 200, 120, 80), MONITOR, &[second, first], STEP),
        (348, 248)
    );
}

#[test]
fn a_new_pin_stays_on_the_monitor() {
    assert_eq!(
        place_new_pin(rect(1850, 1050, 100, 50), MONITOR, &[], STEP),
        (1820, 1030)
    );
    let second_monitor = rect(1920, -200, 1280, 1024);
    assert_eq!(
        place_new_pin(rect(1910, -220, 100, 50), second_monitor, &[], STEP),
        (1926, -200)
    );
}

#[test]
fn a_pin_larger_than_the_monitor_starts_at_its_top_left_corner() {
    assert_eq!(
        place_new_pin(rect(0, 0, 3000, 2000), MONITOR, &[], STEP),
        (0, 0)
    );
}

#[test]
fn when_the_corner_is_crowded_the_pin_steps_back_the_other_way() {
    // 右下角已经有一张钉图，被挤到角上的新钉图向左上错开。
    let corner = rect(1820, 1030, 100, 50);
    let (x, y) = place_new_pin(rect(1850, 1050, 100, 50), MONITOR, &[corner], STEP);
    assert_ne!((x, y), (1820, 1030));
    assert!(x >= 0 && x + 100 <= 1920 && y >= 0 && y + 50 <= 1080);
}
