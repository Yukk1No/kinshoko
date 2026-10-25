//! 说明层与视觉（#285）：出现提示框、小圆锁与确认显示、读不到图的占位与原因、提示、主题。

use kinshoko_core::desktop::frame::APPEAR_MS;

use super::*;

/// 开一张钉图（`look`），渲染层把能做的都做完。
fn open_with(look: Look) -> Rig {
    let shell = FakeShell::new(vec![Display {
        id: "A".into(),
        rect: SCREEN,
        scale: 1.0,
        profile: None,
    }]);
    let mut r = Rig {
        o: Orchestra::new(shell, FakeRender::default()),
        now: Instant::now(),
    };
    r.o.open(Frame::at_home(marker(), look), r.now).unwrap();
    r.run();
    r
}

#[test]
fn a_new_pin_shows_an_accent_ring_that_fades_over_appear_ms() {
    let mut r = open_with(Look::default());
    let first = r.draws();
    assert_eq!(first.last().unwrap().appear, 1.0);
    r.animate(u64::from(APPEAR_MS) / 2);
    let mid = r.draws().last().unwrap().appear;
    assert!(mid > 0.0 && mid < 1.0, "{mid}");
    r.animate(u64::from(APPEAR_MS) / 2);
    assert_eq!(r.draws().last().unwrap().appear, 0.0);
    r.animate(40);
    assert_eq!(r.draws(), [], "渐隐完了不再重画");
}

#[test]
fn the_theme_reaches_the_draw() {
    let mut r = open_with(Look {
        dark: true,
        ..Look::default()
    });
    assert!(r.draws().last().unwrap().dark);
}

#[test]
fn a_veiled_pin_carries_the_lock() {
    let mut r = open_with(Look {
        veiled: true,
        ..Look::default()
    });
    let job = r.draws().pop().unwrap();
    assert!(job.caption.lock);
    assert_eq!(job.caption.reason, None);
}

#[test]
fn pressing_the_lock_asks_to_reveal_instead_of_dragging() {
    let mut r = open_with(Look {
        veiled: true,
        ..Look::default()
    });
    r.o.take_effects();
    r.shell_calls();
    let c = r.o.pins[&A].pin.rect();
    let centre = (c.x + c.width as i32 / 2, c.y + c.height as i32 / 2);
    r.pointer(centre, PointerEvent::Down(PointerButton::Primary));
    assert_eq!(r.o.take_effects(), [Effect::RevealAsked("marker".into())]);
    assert_eq!(r.o.pins[&A].gesture, None);
    // 确认是一个菜单：钩子不再拦键，Esc 交给菜单而不是关掉钉图。
    assert_eq!(r.shell_calls(), [Call::Keys(PinKeys::none())]);
    r.o.menu_closed();
    // 小圆锁以外照常拖动。
    r.pointer(
        (c.x + 20, c.y + 20),
        PointerEvent::Down(PointerButton::Primary),
    );
    assert!(r.o.pins[&A].gesture.is_some());
}

#[test]
fn an_unavailable_pin_shows_a_grey_stand_in_with_the_reason() {
    let reason = "本设备没有登记这个资料库".to_owned();
    let mut r = open_with(Look {
        unavailable: Some(reason.clone()),
        ..Look::default()
    });
    assert!(
        !r.o.render()
            .calls
            .iter()
            .any(|c| matches!(c, RCall::Load(..))),
        "不读图"
    );
    let job = r.draws().pop().expect("照样显示");
    assert!(job.placeholder);
    assert_eq!(job.caption.reason, Some(reason));
    assert!(r.o.take_effects().contains(&Effect::Shown("marker".into())));
}

#[test]
fn a_failed_read_shows_the_stand_in_instead_of_giving_up() {
    let shell = FakeShell::new(vec![Display {
        id: "A".into(),
        rect: SCREEN,
        scale: 1.0,
        profile: None,
    }]);
    let mut o: O = Orchestra::new(shell, FakeRender::default());
    let now = Instant::now();
    o.open(Frame::at_home(marker(), Look::default()), now)
        .unwrap();
    o.render_event(
        RenderEvent::LoadFailed {
            pin: A,
            reason: "读不了".into(),
        },
        now,
    );
    let RCall::Draw(job) = o.render().calls.last().cloned().unwrap() else {
        panic!("应当画占位")
    };
    assert!(job.placeholder);
    assert_eq!(job.caption.reason.as_deref(), Some(MISSING));
    assert!(
        !o.take_effects()
            .iter()
            .any(|e| matches!(e, Effect::Failed(_)))
    );
}

#[test]
fn the_stand_in_stays_until_the_image_arrives_once_the_library_is_back() {
    let mut r = open_with(Look {
        unavailable: Some("资料库不可用".into()),
        ..Look::default()
    });
    r.draws();
    let f = r.home_frame(PinMotion::Jump);
    r.o.frame(f, r.now);
    let open = std::mem::take(&mut r.o.render().open);
    assert!(open.contains(&RCall::Load(A, SourceSize::Width(500))));
    for c in &open {
        if let RCall::Draw(j) = c {
            assert!(j.placeholder, "图到之前仍是占位");
        }
    }
    r.o.render().open = open;
    r.run();
    assert!(!r.draws().last().unwrap().placeholder);
}

#[test]
fn a_notice_shows_for_1_6_seconds() {
    let mut r = Rig::shown();
    r.o.notice("marker", "已锁定".into(), r.now);
    r.run();
    assert_eq!(
        r.draws().last().unwrap().caption.notice.as_deref(),
        Some("已锁定")
    );
    r.wait(NOTICE_MS - 1);
    assert_eq!(r.draws(), []);
    r.wait(1);
    assert_eq!(r.draws().last().unwrap().caption.notice, None);
    assert_eq!(r.o.next_deadline(), None);
}
