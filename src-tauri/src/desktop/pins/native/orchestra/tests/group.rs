//! 整组移动与缩放（#198）：Alt+拖动、Alt+滚轮、菜单“整组移动”、同组的细边框、锁定的钉图不动。

use super::*;

const B: PinId = PinId(2);

fn other() -> SavedPin {
    SavedPin {
        id: "other".into(),
        placement: Placement {
            x: 1000,
            y: 100,
            scale: 0.25,
            ..Placement::default()
        },
        ..marker()
    }
}

impl Rig {
    /// 两张钉图：`marker`（A，100,100 起 500×750）与 `other`（B，1000,100 起 500×750）。
    fn two() -> Rig {
        let mut r = Rig::shown();
        r.o.open(Frame::at_home(other(), Look::default()), r.now)
            .unwrap();
        r.finish_render();
        r.animate(u64::from(kinshoko_core::desktop::frame::APPEAR_MS));
        r.o.take_effects();
        r.o.shell().take_calls();
        r.o.render().calls.clear();
        r
    }

    fn grab(&mut self, at: (i32, i32), event: PointerEvent, alt: bool) {
        self.input(PinInput::Pointer(Pointer {
            pin: A,
            kind: PointerKind::Mouse,
            at,
            event,
            alt,
        }));
    }

    fn drag(&mut self, from: (i32, i32), to: (i32, i32), alt: bool) {
        self.grab(from, PointerEvent::Down(PointerButton::Primary), alt);
        self.grab(to, PointerEvent::Move, alt);
        self.grab(to, PointerEvent::Up(PointerButton::Primary), alt);
    }

    fn at(&self, pin: PinId) -> (i32, i32) {
        let p = &self.o.pins[&pin].pin.placement;
        (p.x, p.y)
    }

    fn saved(&mut self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .o
            .take_effects()
            .into_iter()
            .filter_map(|e| match e {
                Effect::Saved(p) => Some(p.pin),
                _ => None,
            })
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    fn outlined(&self) -> (bool, bool) {
        (self.o.pins[&A].outlined, self.o.pins[&B].outlined)
    }
}

#[test]
fn alt_drag_moves_every_pin_on_the_desk_and_saves_each() {
    let mut r = Rig::two();
    r.drag((150, 150), (250, 200), true);
    assert_eq!(r.at(A), (200, 150));
    assert_eq!(r.at(B), (1100, 150));
    assert_eq!(r.saved(), ["marker", "other"]);
    assert_eq!(r.outlined(), (true, true), "还按着 Alt、停在钉图上");
    r.input(PinInput::Alt { held: false });
    assert_eq!(r.outlined(), (false, false));
}

#[test]
fn a_plain_drag_still_moves_one_pin() {
    let mut r = Rig::two();
    r.drag((150, 150), (250, 200), false);
    assert_eq!(r.at(A), (200, 150));
    assert_eq!(r.at(B), (1000, 100));
}

#[test]
fn locked_pins_stay_put_in_a_group_drag_even_the_one_pressed() {
    let mut r = Rig::two();
    r.o.pins.get_mut(&B).unwrap().pin.locked = true;
    r.drag((150, 150), (250, 200), true);
    assert_eq!(r.at(A), (200, 150));
    assert_eq!(r.at(B), (1000, 100));

    let mut r = Rig::two();
    r.o.pins.get_mut(&A).unwrap().pin.locked = true;
    r.drag((150, 150), (250, 200), true);
    assert_eq!(r.at(A), (100, 100));
    assert_eq!(r.at(B), (1100, 150));
}

#[test]
fn alt_wheel_zooms_the_group_around_the_cursor() {
    let mut r = Rig::two();
    r.input(PinInput::Wheel {
        pin: A,
        at: (600, 475),
        notches: 1.0,
        ctrl: false,
        alt: true,
    });
    // 每格 ×1.12，光标下的点不动：位置离光标的距离与尺寸按同一比例变。
    assert_eq!(r.at(A), (40, 55));
    assert_eq!(r.at(B), (1048, 55));
    for id in [A, B] {
        assert!((r.o.pins[&id].pin.placement.scale - 0.28).abs() < 1e-12);
    }
    // 光标没挪：下一格从同一个起点累计，不累积取整误差。
    r.input(PinInput::Wheel {
        pin: A,
        at: (600, 475),
        notches: -1.0,
        ctrl: false,
        alt: true,
    });
    assert_eq!((r.at(A), r.at(B)), ((100, 100), (1000, 100)));
    assert_eq!(r.saved(), ["marker", "other"]);
}

#[test]
fn holding_alt_over_a_pin_outlines_the_whole_group_until_alt_goes_up() {
    let mut r = Rig::two();
    r.input(PinInput::Alt { held: true });
    assert_eq!(r.outlined(), (false, false), "光标不在钉图上时不画");
    r.grab((150, 150), PointerEvent::Move, true);
    assert_eq!(r.outlined(), (true, true));
    let drawn: Vec<PinId> = r
        .draws()
        .into_iter()
        .filter(|j| j.appear == 1.0)
        .map(|j| j.pin)
        .collect();
    assert!(drawn.contains(&A) && drawn.contains(&B), "{drawn:?}");
    r.input(PinInput::Alt { held: false });
    assert_eq!(r.outlined(), (false, false));
    r.input(PinInput::Alt { held: true });
    r.grab((150, 150), PointerEvent::Leave, true);
    assert_eq!(r.outlined(), (false, false), "离开钉图就去掉");
}

#[test]
fn the_menu_arms_one_group_drag_and_escape_cancels_it_without_closing() {
    let mut r = Rig::two();
    r.o.arm_group_move(r.now);
    assert_eq!(r.outlined(), (true, true), "等着拖动时画细边框");
    r.drag((150, 150), (250, 200), false);
    assert_eq!((r.at(A), r.at(B)), ((200, 150), (1100, 150)));
    assert_eq!(r.outlined(), (false, false));
    r.drag((250, 200), (350, 250), false);
    assert_eq!((r.at(A), r.at(B)), ((300, 200), (1100, 150)), "只管一次");

    r.o.arm_group_move(r.now);
    r.o.take_effects();
    r.key(Key::Escape, false);
    assert_eq!(r.outlined(), (false, false));
    assert!(
        !r.o.take_effects()
            .iter()
            .any(|e| matches!(e, Effect::CloseRequested(_)))
    );
    r.key(Key::Escape, false);
    assert!(
        r.o.take_effects()
            .iter()
            .any(|e| matches!(e, Effect::CloseRequested(_)))
    );
}

#[test]
fn closing_the_pin_that_drags_the_group_ends_the_drag() {
    let mut r = Rig::two();
    r.grab((150, 150), PointerEvent::Down(PointerButton::Primary), true);
    r.grab((250, 200), PointerEvent::Move, true);
    r.input(PinInput::Alt { held: false });
    r.key(Key::Escape, false);
    assert!(!r.o.group.dragging());
    assert!(!r.o.pins[&B].outlined);
    // B 的滚轮照常（单张缩放）。
    let before = r.o.pins[&B].pin.placement.scale;
    r.input(PinInput::Wheel {
        pin: B,
        at: (1200, 300),
        notches: 1.0,
        ctrl: false,
        alt: false,
    });
    assert!(r.o.pins[&B].pin.placement.scale > before);
}

#[test]
fn a_later_alt_wheel_scales_the_layout_as_it_is_now() {
    let mut r = Rig::two();
    let alt_wheel = |alt| PinInput::Wheel {
        pin: A,
        at: (600, 475),
        notches: 1.0,
        ctrl: false,
        alt,
    };
    r.input(alt_wheel(true));
    r.input(alt_wheel(false));
    let a = r.o.pins[&A].pin.placement;
    r.input(alt_wheel(true));
    // 从单张缩放之后的样子再乘 1.12，不回到第一次整组缩放的起点。
    assert!((r.o.pins[&A].pin.placement.scale - a.scale * 1.12).abs() < 1e-9);
}

#[test]
fn a_group_drag_during_a_zoom_animation_starts_from_what_is_shown() {
    let mut r = Rig::two();
    r.input(PinInput::Wheel {
        pin: A,
        at: (600, 475),
        notches: 1.0,
        ctrl: false,
        alt: true,
    });
    // 动画走到一半时按下：抓住的点留在指针下，不先跳到缩放的终点。
    r.animate(u64::from(ZOOM_MS) / 2);
    let shown = r.o.shown(A, r.now);
    r.grab((150, 150), PointerEvent::Down(PointerButton::Primary), true);
    r.grab((151, 150), PointerEvent::Move, true);
    assert_eq!(r.at(A), (shown.x + 1, shown.y));
}
