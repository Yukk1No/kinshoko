//! 缩放动画（#285）：滚轮、拖角、菜单“原始大小”都以 `ZOOM_MS` 的 `easeOutCubic` 从此刻看到的位置
//! 过渡到新目标；动画中再来输入时从当前位置重新计时，不跳回起点。

use std::cell::RefCell;
use std::rc::Rc;

use kinshoko_core::desktop::frame::{ContentMotion, RectF, ease_out_cubic};

use super::*;

/// 记下每一次提交。
fn log(r: &mut Rig) -> Rc<RefCell<Vec<Submit>>> {
    let seen = Rc::new(RefCell::new(Vec::new()));
    let sink = seen.clone();
    r.o.on_submit(move |s| sink.borrow_mut().push(*s));
    seen
}

fn lerp(from: ScreenRect, to: ScreenRect, t: f64) -> ScreenRect {
    let (a, b) = (RectF::from(from), RectF::from(to));
    let k = ease_out_cubic(t);
    RectF {
        x: a.x + (b.x - a.x) * k,
        y: a.y + (b.y - a.y) * k,
        width: a.width + (b.width - a.width) * k,
        height: a.height + (b.height - a.height) * k,
    }
    .snap()
}

/// 毫秒换成小数时有舍入：各边差不过一像素。
fn near(got: ScreenRect, want: ScreenRect) {
    let ok = (got.x - want.x).abs() <= 1
        && (got.y - want.y).abs() <= 1
        && got.width.abs_diff(want.width) <= 1
        && got.height.abs_diff(want.height) <= 1;
    assert!(ok, "{got:?} 与 {want:?} 差太多");
}

#[test]
fn a_wheel_notch_eases_out_cubic_over_zoom_ms_frame_by_frame() {
    let mut r = Rig::shown();
    let seen = log(&mut r);
    let from = r.o.pins[&A].pin.rect();
    r.wheel(1.0, false);
    let to = r.o.pins[&A].pin.rect();
    assert_eq!(r.o.shown(A, r.now), from, "输入的那一刻还在原处");
    let step = ANIM_FRAME.as_millis() as u64;
    let mut t = 0;
    while t < u64::from(ZOOM_MS) {
        r.wait(step);
        t += step;
        let want = lerp(from, to, t as f64 / f64::from(ZOOM_MS));
        let last = *seen.borrow().last().expect("每帧都提交");
        near(last.content, want);
    }
    assert_eq!(seen.borrow().last().unwrap().content, to);
    let frames = seen.borrow().len();
    r.animate(50);
    assert_eq!(seen.borrow().len(), frames, "动画结束后不再提交");
}

#[test]
fn another_notch_mid_zoom_continues_from_where_the_pin_is_seen() {
    let mut r = Rig::shown();
    r.wheel(1.0, false);
    r.animate(60);
    let seen = r.o.shown(A, r.now);
    r.wheel(1.0, false);
    let to = r.o.pins[&A].pin.rect();
    assert_eq!(r.o.shown(A, r.now), seen, "不跳回起点，也不跳到终点");
    // 重新计时：从看到的位置走满 ZOOM_MS 到新目标。
    let mut m = ContentMotion::new(seen.into(), 0.0);
    m.retarget(to.into(), 0.0, f64::from(ZOOM_MS));
    r.animate(40);
    // 动画从没取整的位置接着走：与取整后的起点算出的差不过一像素。
    let (got, want) = (r.o.shown(A, r.now), m.at(40.0).snap());
    assert!(
        (got.x - want.x).abs() <= 1 && got.width.abs_diff(want.width) <= 1,
        "{got:?} {want:?}"
    );
    r.animate(u64::from(ZOOM_MS) - 40);
    assert_eq!(r.o.shown(A, r.now), to);
}

#[test]
fn fast_scrolling_retargets_without_waiting_for_the_last_zoom() {
    let mut r = Rig::shown();
    let mut last = r.o.shown(A, r.now);
    for _ in 0..6 {
        r.wheel(1.0, false);
        r.animate(8);
        let now = r.o.shown(A, r.now);
        assert!(now.width > last.width, "每一格都接着放大");
        last = now;
    }
    r.animate(u64::from(ZOOM_MS));
    assert_eq!(r.o.shown(A, r.now), r.o.pins[&A].pin.rect());
}

#[test]
fn dragging_the_corner_zooms_with_the_same_animation_about_the_top_left() {
    let mut r = Rig::shown();
    let from = r.o.pins[&A].pin.rect();
    let corner = (
        from.x + from.width as i32 - 3,
        from.y + from.height as i32 - 3,
    );
    r.pointer(corner, PointerEvent::Down(PointerButton::Primary));
    r.pointer((corner.0 + 100, corner.1 + 100), PointerEvent::Move);
    let to = r.o.pins[&A].pin.rect();
    assert_eq!((to.x, to.y), (from.x, from.y), "左上角不动");
    assert!(to.width > from.width);
    assert_eq!(r.o.shown(A, r.now), from);
    r.animate(70);
    let mid = r.o.shown(A, r.now);
    near(mid, lerp(from, to, 0.5));
    // 继续拖：从此刻看到的位置接着走。
    r.pointer((corner.0 + 200, corner.1 + 200), PointerEvent::Move);
    assert_eq!(r.o.shown(A, r.now), mid);
    r.animate(u64::from(ZOOM_MS));
    assert_eq!(r.o.shown(A, r.now), r.o.pins[&A].pin.rect());
}

#[test]
fn actual_size_from_the_menu_animates_too() {
    let mut r = Rig::shown();
    let from = r.o.pins[&A].pin.rect();
    let mut f = r.home_frame(PinMotion::Zoom);
    let (x, y) = (from.x + 250, from.y + 375);
    f.pin.zoom(1.0, (f64::from(x), f64::from(y)));
    f.content = f.pin.rect();
    let to = f.content;
    r.frame(f);
    assert_eq!(r.o.shown(A, r.now), from);
    r.animate(u64::from(ZOOM_MS) / 2);
    near(r.o.shown(A, r.now), lerp(from, to, 0.5));
    r.animate(u64::from(ZOOM_MS) / 2);
    assert_eq!(r.o.shown(A, r.now), to);
}

#[test]
fn the_gesture_settles_settle_ms_after_the_animation_ends() {
    let mut r = Rig::shown();
    r.wheel(1.0, false);
    r.animate(u64::from(ZOOM_MS) + SETTLE_MS - 4);
    assert!(r.o.pins[&A].gesture_until.is_some());
    r.animate(4);
    assert_eq!(r.o.pins[&A].gesture_until, None);
    assert_eq!(r.o.next_deadline(), None);
}

#[test]
fn a_notch_up_zooms_in_and_down_zooms_out() {
    let mut r = Rig::shown();
    let from = r.o.pins[&A].pin.rect();
    r.wheel(1.0, false);
    assert!(r.o.pins[&A].pin.rect().width > from.width, "向上一格放大");
    r.animate(200);
    r.wheel(-2.0, false);
    assert!(r.o.pins[&A].pin.rect().width < from.width, "向下缩小");
}
