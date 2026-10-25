//! 出错、换显示器与手势收尾的边角情况。

use super::*;

/// 开一张钉图，渲染层还没回报。
fn opening() -> O {
    let shell = FakeShell::new(vec![Display {
        id: "A".into(),
        rect: SCREEN,
        scale: 1.0,
        profile: None,
    }]);
    let mut o = Orchestra::new(shell, FakeRender::default());
    o.open(Frame::at_home(marker(), Look::default()), Instant::now())
        .unwrap();
    o.render().calls.clear();
    o.render().open.clear();
    o
}

#[test]
fn a_pin_whose_image_cannot_be_read_gives_up_and_tears_down() {
    let mut o = opening();
    o.render_event(
        RenderEvent::LoadFailed {
            pin: A,
            reason: "没有这张图".into(),
        },
        Instant::now(),
    );
    assert_eq!(
        o.take_effects(),
        [
            Effect::Warn("原生钉图读不到图", "没有这张图".into()),
            Effect::Failed("marker".into()),
        ]
    );
    assert_eq!(o.render().calls, [RCall::Detach(A)]);
    o.render_event(RenderEvent::Detached { pin: A }, Instant::now());
    assert!(o.is_empty());
}

#[test]
fn a_pin_whose_first_frame_cannot_be_drawn_gives_up() {
    let mut o = opening();
    o.render_event(
        RenderEvent::Loaded {
            pin: A,
            size: SourceSize::Width(500),
        },
        Instant::now(),
    );
    o.render().calls.clear();
    o.render_event(
        RenderEvent::Drawn {
            pin: A,
            result: Err("设备丢了".into()),
        },
        Instant::now(),
    );
    assert_eq!(
        o.take_effects(),
        [
            Effect::Warn("原生钉图画不上", "设备丢了".into()),
            Effect::Failed("marker".into()),
        ]
    );
    assert_eq!(o.render().calls, [RCall::Detach(A)]);
}

#[test]
fn a_reload_that_fails_after_showing_keeps_the_pin() {
    let mut r = Rig::shown();
    r.o.render_event(
        RenderEvent::LoadFailed {
            pin: A,
            reason: "x".into(),
        },
        Instant::now(),
    );
    assert_eq!(
        r.o.take_effects(),
        [Effect::Warn("原生钉图读不到图", "x".into())]
    );
    assert_eq!(r.o.render().calls, []);
}

#[test]
fn dragging_onto_a_display_with_another_profile_redraws_there() {
    let mut r = Rig::shown_on(vec![
        Display {
            id: "A".into(),
            rect: SCREEN,
            scale: 1.0,
            profile: Some(vec![1, 2, 3]),
        },
        Display {
            id: "B".into(),
            rect: ScreenRect { x: 2560, ..SCREEN },
            scale: 1.0,
            profile: Some(vec![4, 5]),
        },
    ]);
    r.pointer((150, 150), PointerEvent::Down(PointerButton::Primary));
    for k in 1..=30 {
        r.pointer((150 + 100 * k, 150), PointerEvent::Move);
    }
    r.pointer((3150, 150), PointerEvent::Up(PointerButton::Primary));
    r.wait(SETTLE_MS);
    let last = r.draws().pop().expect("到了 B 要重画");
    assert_eq!(last.display.as_deref(), Some(&[4u8, 5][..]));
    assert!(last.content.x + 250 >= 2560, "中心到了 B 才换配置文件");
}

#[test]
fn settling_while_a_draw_is_in_flight_still_fits_the_window_back() {
    let mut r = Rig::shown();
    let wheel = PinInput::Wheel {
        pin: A,
        at: (200, 300),
        notches: 1.0,
        ctrl: false,
    };
    r.o.shell().push(wheel.clone());
    r.o.pump(r.now);
    // 画还在路上时又来一格，随后停手。
    r.o.shell().push(wheel);
    r.o.pump(r.now);
    r.animate(u64::from(ZOOM_MS) + SETTLE_MS);
    let fit = window_for(r.o.pins[&A].pin.rect(), &[SCREEN]).unwrap();
    assert_eq!(r.o.shell().window(A), Some(fit));
    assert_eq!(r.o.next_deadline(), None);
}
