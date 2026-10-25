//! 指针与按键（#285）：菜单（右键、笔侧键、笔或触摸按住）、光标、翻转旋转、锁定、命中。

use kinshoko_core::desktop::frame::HOLD_MS;
use pin_shell::PinCursor;

use super::*;

impl Rig {
    fn press(&mut self, kind: PointerKind, at: (i32, i32), event: PointerEvent) {
        self.input(PinInput::Pointer(Pointer {
            pin: A,
            kind,
            at,
            event,
        }));
    }

    fn menus(&mut self) -> usize {
        self.o
            .take_effects()
            .iter()
            .filter(|e| matches!(e, Effect::Menu(k) if k == "marker"))
            .count()
    }
}

#[test]
fn the_right_button_opens_the_menu_and_the_hook_stops_taking_keys_until_it_closes() {
    let mut r = Rig::shown();
    r.pointer((150, 150), PointerEvent::Down(PointerButton::Secondary));
    assert_eq!(r.menus(), 1);
    assert_eq!(r.shell_calls(), [Call::Keys(PinKeys::none())]);
    r.o.menu_closed();
    assert_eq!(r.shell_calls(), [Call::Keys(PinKeys::new(KEYS))]);
    r.o.menu_closed();
    assert_eq!(r.shell_calls(), [], "已经恢复过");
}

#[test]
fn the_pen_barrel_opens_the_menu_once_per_press() {
    let mut r = Rig::shown();
    let down = PointerEvent::Down(PointerButton::Secondary);
    r.press(PointerKind::Pen, (150, 150), down);
    r.press(PointerKind::Pen, (150, 150), down);
    assert_eq!(r.menus(), 1, "同一次按下引出的两个事件只开一次");
    r.o.menu_closed();
    r.wait(1000);
    r.press(PointerKind::Pen, (150, 150), down);
    assert_eq!(r.menus(), 1);
}

#[test]
fn holding_a_pen_still_for_half_a_second_opens_the_menu_once() {
    let mut r = Rig::shown();
    r.press(
        PointerKind::Pen,
        (150, 150),
        PointerEvent::Down(PointerButton::Primary),
    );
    r.press(PointerKind::Pen, (152, 151), PointerEvent::Move);
    r.wait(u64::from(HOLD_MS) - 1);
    assert_eq!(r.menus(), 0);
    r.wait(1);
    assert_eq!(r.menus(), 1);
    r.wait(u64::from(HOLD_MS));
    assert_eq!(r.menus(), 0, "同一次按下只开一次");
    assert_eq!(r.o.pins[&A].gesture, None, "开菜单后这一笔作废");
}

#[test]
fn touch_holds_too_but_not_the_mouse_or_a_drag() {
    let mut r = Rig::shown();
    r.press(
        PointerKind::Touch,
        (150, 150),
        PointerEvent::Down(PointerButton::Primary),
    );
    r.wait(u64::from(HOLD_MS));
    assert_eq!(r.menus(), 1);
    r.o.menu_closed();
    r.press(
        PointerKind::Touch,
        (150, 150),
        PointerEvent::Up(PointerButton::Primary),
    );

    r.wait(1000);
    r.pointer((150, 150), PointerEvent::Down(PointerButton::Primary));
    r.wait(u64::from(HOLD_MS));
    assert_eq!(r.menus(), 0, "鼠标按住不开菜单");
    r.pointer((150, 150), PointerEvent::Up(PointerButton::Primary));

    r.press(
        PointerKind::Pen,
        (150, 150),
        PointerEvent::Down(PointerButton::Primary),
    );
    r.press(PointerKind::Pen, (170, 150), PointerEvent::Move);
    r.press(PointerKind::Pen, (150, 150), PointerEvent::Move);
    r.wait(u64::from(HOLD_MS));
    assert_eq!(r.menus(), 0, "拖动过的这一笔回到起点也不算按住");
}

#[test]
fn a_locked_pin_still_opens_its_menu_by_holding() {
    let mut r = Rig::shown();
    r.o.pins.get_mut(&A).unwrap().pin.locked = true;
    r.press(
        PointerKind::Pen,
        (150, 150),
        PointerEvent::Down(PointerButton::Primary),
    );
    r.wait(u64::from(HOLD_MS));
    assert_eq!(r.menus(), 1);
}

#[test]
fn h_v_flip_and_r_shift_r_rotate_about_the_centre() {
    let mut r = Rig::shown();
    let centre = |p: &SavedPin| {
        let c = p.rect();
        (c.x * 2 + c.width as i32, c.y * 2 + c.height as i32)
    };
    let before = r.o.pins[&A].pin.clone();
    r.key(Key::Letter('H'), false);
    assert!(r.o.pins[&A].pin.placement.flip_h);
    r.key(Key::Letter('V'), false);
    assert!(r.o.pins[&A].pin.placement.flip_v);
    r.key(Key::Letter('R'), false);
    assert_eq!(r.o.pins[&A].pin.placement.rotation, 1);
    assert_eq!(centre(&r.o.pins[&A].pin), centre(&before));
    r.key(Key::Letter('R'), true);
    assert_eq!(r.o.pins[&A].pin.placement.rotation, 0);
    r.key(Key::Letter('H'), true);
    assert!(r.o.pins[&A].pin.placement.flip_h, "Shift+H 不翻转");
    let saved =
        r.o.take_effects()
            .iter()
            .filter(|e| matches!(e, Effect::Saved(_)))
            .count();
    assert_eq!(saved, 4);
    // 翻转旋转直接到，不带动画。
    assert_eq!(r.o.shown(A, r.now), r.o.pins[&A].pin.rect());
}

#[test]
fn the_cursor_changes_over_the_zoom_corner_unless_locked() {
    let mut r = Rig::shown();
    let c = r.o.pins[&A].pin.rect();
    let corner = (c.x + c.width as i32 - 2, c.y + c.height as i32 - 2);
    r.pointer(corner, PointerEvent::Move);
    assert_eq!(r.o.shell().cursor(A), PinCursor::ResizeNwse);
    r.pointer(corner, PointerEvent::Move);
    r.pointer((150, 150), PointerEvent::Move);
    assert_eq!(
        r.shell_calls(),
        [
            Call::Cursor(A, PinCursor::ResizeNwse),
            Call::Cursor(A, PinCursor::Arrow)
        ]
    );
    r.o.pins.get_mut(&A).unwrap().pin.locked = true;
    r.pointer(corner, PointerEvent::Move);
    assert_eq!(r.o.shell().cursor(A), PinCursor::Arrow);
}

#[test]
fn presses_on_the_shadow_count_but_not_on_the_window_beyond_it() {
    let mut r = Rig::shown();
    let c = r.o.pins[&A].pin.rect();
    // 阴影那一圈。
    r.pointer(
        (c.x - 2, c.y + 20),
        PointerEvent::Down(PointerButton::Primary),
    );
    assert_eq!(r.shell_calls(), [Call::Raise(A)]);
    r.pointer(
        (c.x - 2, c.y + 20),
        PointerEvent::Up(PointerButton::Primary),
    );
    // 包络里阴影以外的透明处。
    r.pointer(
        (c.x - 40, c.y + 20),
        PointerEvent::Down(PointerButton::Primary),
    );
    r.pointer(
        (c.x - 40, c.y + 20),
        PointerEvent::Down(PointerButton::Secondary),
    );
    assert_eq!(r.shell_calls(), []);
    assert_eq!(r.menus(), 0);
}

#[test]
fn the_wheel_does_nothing_while_a_pointer_is_down() {
    let mut r = Rig::shown();
    r.pointer((150, 150), PointerEvent::Down(PointerButton::Primary));
    let before = r.o.pins[&A].pin.clone();
    r.wheel(1.0, false);
    r.wheel(1.0, true);
    assert_eq!(r.o.pins[&A].pin, before);
}

#[test]
fn ctrl_wheel_still_works_on_a_locked_pin() {
    let mut r = Rig::shown();
    r.o.pins.get_mut(&A).unwrap().pin.locked = true;
    r.wheel(-1.0, true);
    assert!((r.o.pins[&A].pin.opacity - 0.9).abs() < 1e-9);
}
