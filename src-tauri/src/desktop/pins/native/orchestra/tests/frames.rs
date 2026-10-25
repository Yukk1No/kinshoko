//! 应用壳推来的帧（#285）：贴边隐藏、菜单动作、遮蔽与设置、改引用。

use std::time::Duration;

use kinshoko_core::desktop::frame::{REVEAL_MS, SLIDE_MS, VEILED_SOURCE_PX};

use super::*;

impl Rig {
    /// 收到屏幕左边、只露 6 像素（贴边隐藏）。
    fn tuck(&mut self) -> ScreenRect {
        let home = self.o.pins[&A].pin.rect();
        let tucked = ScreenRect {
            x: 6 - home.width as i32,
            ..home
        };
        let f = Frame {
            content: tucked,
            click_through: true,
            ..self.home_frame(PinMotion::Slide)
        };
        self.frame(f);
        tucked
    }
}

#[test]
fn edge_hide_slides_over_slide_ms_and_lets_clicks_through() {
    let mut r = Rig::shown();
    let home = r.o.pins[&A].pin.rect();
    let tucked = r.tuck();
    assert!(r.o.shell().click_through(A));
    assert_eq!(r.o.shown(A, r.now), home, "从原位滑走");
    r.animate(u64::from(SLIDE_MS) / 2);
    let mid = r.o.shown(A, r.now);
    assert!(mid.x < home.x && mid.x > tucked.x);
    r.animate(u64::from(SLIDE_MS) / 2);
    assert_eq!(r.o.shown(A, r.now), tucked);
    assert_eq!(r.o.pins[&A].pin.rect(), home, "原位不变");

    // 再按一次回到原位。
    let back = r.home_frame(PinMotion::Slide);
    r.frame(back);
    assert!(!r.o.shell().click_through(A));
    r.animate(u64::from(SLIDE_MS));
    assert_eq!(r.o.shown(A, r.now), home);
}

#[test]
fn dragging_a_peeking_pin_releases_it_from_where_it_is() {
    let mut r = Rig::shown();
    let tucked = r.tuck();
    r.animate(u64::from(SLIDE_MS) + SETTLE_MS);
    // 滑出（应用壳轮询光标）：不再穿透。
    let peek = ScreenRect { x: 0, ..tucked };
    let f = Frame {
        content: peek,
        ..r.home_frame(PinMotion::Slide)
    };
    r.frame(f);
    r.animate(u64::from(SLIDE_MS) + SETTLE_MS);
    r.o.take_effects();
    r.pointer(
        (20, peek.y + 20),
        PointerEvent::Down(PointerButton::Primary),
    );
    r.pointer((50, peek.y + 30), PointerEvent::Move);
    let effects = r.o.take_effects();
    assert_eq!(effects[0], Effect::Released("marker".into()));
    let pin = &r.o.pins[&A].pin;
    assert_eq!((pin.placement.x, pin.placement.y), (30, peek.y + 10));
    assert!(matches!(&effects[1], Effect::Saved(p) if p == pin));
    assert!(!r.o.pins[&A].tucked);
}

#[test]
fn ctrl_wheel_on_a_tucked_pin_keeps_it_tucked() {
    let mut r = Rig::shown();
    let tucked = r.tuck();
    r.animate(u64::from(SLIDE_MS) + SETTLE_MS);
    r.wheel(-1.0, true);
    assert!(r.o.pins[&A].tucked);
    assert_eq!(r.o.shown(A, r.now), tucked);
    assert!(
        !r.o.take_effects()
            .contains(&Effect::Released("marker".into()))
    );
}

#[test]
fn a_refresh_during_a_gesture_keeps_the_local_geometry() {
    let mut r = Rig::shown();
    let stale = r.home_frame(PinMotion::Jump);
    r.pointer((150, 150), PointerEvent::Down(PointerButton::Primary));
    r.pointer((190, 170), PointerEvent::Move);
    let moved = r.o.pins[&A].pin.placement;
    let mut f = stale;
    f.geometry = false;
    f.pin.opacity = 0.5;
    f.look.edge_contrast = true;
    r.frame(f);
    let live = &r.o.pins[&A];
    assert_eq!(live.pin.placement, moved, "应用壳那边的保存还没落地");
    assert_eq!(live.pin.opacity, 0.5);
    let last = r.draws().pop().expect("外观变了要重画");
    assert!(last.ring);
}

#[test]
fn a_menu_turn_swaps_the_window_at_once() {
    let mut r = Rig::shown();
    let mut f = r.home_frame(PinMotion::Jump);
    f.pin.turn(kinshoko_core::desktop::Turn::RotateClockwise);
    f.content = f.pin.rect();
    r.frame(f.clone());
    assert_eq!(r.o.shown(A, r.now), f.content);
    let calls = r.shell_calls();
    assert!(
        matches!(calls.as_slice(), [Call::Stage(A, _), Call::Swap(A)]),
        "{calls:?}"
    );
    assert_eq!(r.draws().last().unwrap().state.placement.rotation, 1);
}

#[test]
fn a_veiled_pin_loads_the_64px_derivative_and_draws_veiled() {
    let shell = FakeShell::new(vec![Display {
        id: "A".into(),
        rect: SCREEN,
        scale: 1.5,
        profile: None,
    }]);
    let mut o: O = Orchestra::new(shell, FakeRender::default());
    let look = Look {
        veiled: true,
        ..Look::default()
    };
    o.open(Frame::at_home(marker(), look), Instant::now())
        .unwrap();
    let size = SourceSize::Width(VEILED_SOURCE_PX);
    assert_eq!(o.render().calls[1], RCall::Load(A, size));
    o.render_event(RenderEvent::Loaded { pin: A, size }, Instant::now());
    let RCall::Draw(job) = o.render().calls.last().cloned().unwrap() else {
        panic!("应当画第一帧")
    };
    assert_eq!((job.veil, job.display_scale), (1.0, 1.5));
}

#[test]
fn turning_safe_mode_on_veils_at_once_and_swaps_to_the_small_source() {
    let mut r = Rig::shown();
    let mut f = r.home_frame(PinMotion::Jump);
    f.look.veiled = true;
    r.frame(f);
    let calls = std::mem::take(&mut r.o.render().calls);
    assert!(calls.contains(&RCall::Load(A, SourceSize::Width(VEILED_SOURCE_PX))));
    let RCall::Draw(job) = calls.last().unwrap() else {
        panic!("{calls:?}")
    };
    assert_eq!(job.veil, 1.0);
}

#[test]
fn revealing_waits_for_the_clear_source_then_fades_over_reveal_ms() {
    let mut r = Rig::shown();
    let mut f = r.home_frame(PinMotion::Jump);
    f.look.veiled = true;
    r.frame(f.clone());
    r.draws();
    f.look.veiled = false;
    // 渲染层先不回报：清晰的源图还在路上。
    r.o.frame(f, r.now);
    let open = std::mem::take(&mut r.o.render().open);
    let draws: Vec<f32> = open
        .iter()
        .filter_map(|c| match c {
            RCall::Draw(j) => Some(j.veil),
            _ => None,
        })
        .collect();
    assert!(draws.iter().all(|v| *v == 1.0), "{draws:?}");
    assert!(open.contains(&RCall::Load(A, SourceSize::Width(500))));
    r.o.render().open = open;
    r.run();
    r.draws();
    r.animate(u64::from(REVEAL_MS) / 2);
    let mid = r.draws().last().unwrap().veil;
    assert!(mid > 0.0 && mid < 1.0, "{mid}");
    r.animate(u64::from(REVEAL_MS) / 2);
    assert_eq!(r.draws().last().unwrap().veil, 0.0);
    r.animate(40);
    assert_eq!(r.draws(), [], "淡出完了不再重画");
}

#[test]
fn collecting_a_capture_switches_the_source() {
    let mut r = Rig::shown();
    let mut f = r.home_frame(PinMotion::Jump);
    f.pin.content = PinContent::Reference {
        library_id: "lib".into(),
        image_id: "other".into(),
        source_width: 2000,
        source_height: 3000,
    };
    r.frame(f);
    let calls = std::mem::take(&mut r.o.render().calls);
    assert_eq!(calls[0], RCall::Load(A, SourceSize::Width(500)));
}

#[test]
fn frames_for_unknown_pins_are_ignored() {
    let mut r = Rig::shown();
    let mut f = r.home_frame(PinMotion::Jump);
    f.pin.id = "gone".into();
    r.frame(f);
    assert_eq!(r.draws(), []);
    assert_eq!(r.shell_calls(), []);
}

#[test]
fn a_menu_turn_right_after_a_gesture_is_shown() {
    let mut r = Rig::shown();
    r.wheel(1.0, false);
    // 收尾之前从菜单旋转：应用壳改了几何的帧不能被当成刷新丢掉。
    let mut f = r.home_frame(PinMotion::Jump);
    f.pin.turn(kinshoko_core::desktop::Turn::RotateClockwise);
    f.content = f.pin.rect();
    r.frame(f);
    assert_eq!(r.o.pins[&A].pin.placement.rotation, 1);
}

#[test]
fn an_appearance_refresh_never_moves_the_pin() {
    let mut r = Rig::shown();
    let mut stale = r.home_frame(PinMotion::Jump);
    stale.geometry = false;
    r.key(Key::Letter('R'), false);
    r.animate(SETTLE_MS * 2);
    r.frame(stale);
    assert_eq!(
        r.o.pins[&A].pin.placement.rotation, 1,
        "应用壳的保存还没落地"
    );
}

#[test]
fn a_refresh_while_the_clear_source_loads_keeps_the_veil() {
    let mut r = Rig::shown();
    let mut f = r.home_frame(PinMotion::Jump);
    f.look.veiled = true;
    r.frame(f.clone());
    f.look.veiled = false;
    r.o.frame(f.clone(), r.now);
    // 清晰的源图还在路上时又来一次刷新（设置变了）。
    f.geometry = false;
    f.look.edge_contrast = true;
    r.o.frame(f, r.now);
    let open = std::mem::take(&mut r.o.render().open);
    let load = open
        .iter()
        .position(|c| matches!(c, RCall::Load(..)))
        .unwrap();
    // 先只画路上的那几帧（都还遮蔽着），再交图。
    r.now += Duration::from_millis(u64::from(REVEAL_MS));
    for c in &open[..load] {
        if let RCall::Draw(j) = c {
            r.o.render_event(
                RenderEvent::Drawn {
                    pin: j.pin,
                    result: Ok(()),
                },
                r.now,
            );
        }
    }
    r.o.tick(r.now);
    let veils: Vec<f32> =
        r.o.render()
            .open
            .iter()
            .filter_map(|c| match c {
                RCall::Draw(j) => Some(j.veil),
                _ => None,
            })
            .collect();
    assert!(veils.iter().all(|v| *v == 1.0), "{veils:?}");
}

#[test]
fn grabbing_a_pin_mid_slide_drags_it_from_where_it_is_seen() {
    let mut r = Rig::shown();
    let tucked = r.tuck();
    r.animate(u64::from(SLIDE_MS) + SETTLE_MS);
    let f = Frame {
        content: ScreenRect { x: 0, ..tucked },
        ..r.home_frame(PinMotion::Slide)
    };
    r.frame(f);
    r.animate(48);
    let seen = r.o.shown(A, r.now);
    let at = (seen.x + seen.width as i32 - 10, seen.y + 20);
    r.pointer(at, PointerEvent::Down(PointerButton::Primary));
    r.pointer((at.0 + 1, at.1), PointerEvent::Move);
    assert_eq!(r.o.shown(A, r.now).x, seen.x + 1, "抓住的点留在指针下");
}
