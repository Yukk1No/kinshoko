//! GPU 设备丢失（驱动重启、远程桌面切换）之后：平台层给同一对窗口换新目标，重新读图、画好再显示。

use super::*;

#[test]
fn after_device_loss_the_pin_gets_new_targets_its_image_and_is_shown_again() {
    let mut r = Rig::shown();
    let window = r.o.shell().window(A).expect("显示着");
    let size = r.o.pins[&A].requested;
    r.o.render_event(RenderEvent::DeviceLost, r.now);
    assert_eq!(r.shell_calls(), [Call::Retarget(A)]);
    assert_eq!(r.o.render().calls, [RCall::Attach(A), RCall::Load(A, size)]);
    r.o.render().calls.clear();
    r.now += Duration::from_millis(5);
    r.run();
    let draws = r.draws();
    assert_eq!(draws.len(), 1, "图到了画一帧");
    assert_eq!(draws[0].appear, 0.0, "不再出现提示框");
    assert_eq!(r.shell_calls(), [Call::Show(A, window)]);
    assert_eq!(r.o.shell().window(A), Some(window));
    assert_eq!(
        r.o.take_effects(),
        [
            Effect::Warn("原生钉图 GPU 设备丢失", "重建".into()),
            Effect::Warn("原生钉图设备丢失后重新显示", "5 ms".into()),
            Effect::Shown("marker".into()),
        ]
    );
    assert_eq!(r.o.next_deadline(), None);
}

#[test]
fn a_pin_that_cannot_get_new_targets_after_device_loss_is_closed() {
    let mut r = Rig::shown();
    r.o.shell().fail_retarget(true);
    r.o.render_event(RenderEvent::DeviceLost, r.now);
    assert_eq!(
        r.o.take_effects(),
        [
            Effect::Warn("原生钉图 GPU 设备丢失", "重建".into()),
            Effect::Warn(
                "原生钉图设备丢失后换不了目标",
                "钉图窗口：建不了 visual".into()
            ),
            Effect::Failed("marker".into()),
        ]
    );
    assert_eq!(r.o.render().calls, [RCall::Detach(A)]);
    assert_eq!(r.shell_calls(), [Call::Retarget(A)]);
    r.finish_render();
    assert_eq!(r.shell_calls(), [Call::Close(A)]);
    assert!(r.o.is_empty());
}

#[test]
fn a_draw_that_failed_with_the_lost_device_does_not_give_the_pin_up() {
    let mut r = Rig::shown();
    // 一格滚轮：画还在路上时设备丢了，这一帧随后报失败。
    r.o.shell().push(PinInput::Wheel {
        pin: A,
        at: (200, 300),
        notches: 1.0,
        ctrl: false,
    });
    r.o.pump(r.now);
    r.o.render().open.clear();
    r.o.render_event(RenderEvent::DeviceLost, r.now);
    r.o.render_event(
        RenderEvent::Drawn {
            pin: A,
            result: Err("GPU 设备丢失".into()),
        },
        r.now,
    );
    assert!(
        r.o.take_effects()
            .iter()
            .all(|e| !matches!(e, Effect::Failed(_) | Effect::Warn("原生钉图画不上", _))),
        "没有收掉钉图，也不报画不上"
    );
    r.animate(u64::from(ZOOM_MS) + SETTLE_MS);
    let fit = window_for(r.o.pins[&A].pin.rect(), &[SCREEN]).unwrap();
    assert_eq!(r.o.shell().window(A), Some(fit));
    assert!(!r.o.pins[&A].closing);
}

#[test]
fn a_pin_known_to_be_unreadable_is_not_read_again_after_device_loss() {
    let mut r = Rig::shown();
    r.frame(Frame {
        look: Look {
            unavailable: Some("资料库暂时不可用".into()),
            ..Look::default()
        },
        ..r.home_frame(PinMotion::Jump)
    });
    r.o.render().calls.clear();
    r.shell_calls();
    r.o.render_event(RenderEvent::DeviceLost, r.now);
    r.run();
    let calls = std::mem::take(&mut r.o.render().calls);
    assert_eq!(calls[0], RCall::Attach(A));
    assert!(calls[1..].iter().all(|c| matches!(c, RCall::Draw(_))));
    assert!(matches!(
        r.shell_calls()[..],
        [Call::Retarget(A), Call::Show(A, _)]
    ));
}

#[test]
fn the_lost_draw_failing_late_does_not_close_an_unreadable_pin_drawn_again() {
    let mut r = Rig::shown();
    let frame = Frame {
        look: Look {
            unavailable: Some("资料库暂时不可用".into()),
            ..Look::default()
        },
        ..r.home_frame(PinMotion::Jump)
    };
    r.o.frame(frame, r.now);
    // 占位那一帧还在路上时设备丢了：重建后马上又画占位，旧的那一帧随后才报失败。
    assert!(r.o.pins[&A].pending.is_some());
    r.o.render().open.clear();
    r.o.render_event(RenderEvent::DeviceLost, r.now);
    assert!(r.o.pins[&A].pending.is_some(), "重建后画占位");
    r.o.render_event(
        RenderEvent::Drawn {
            pin: A,
            result: Err("GPU 设备丢失".into()),
        },
        r.now,
    );
    assert!(
        r.o.take_effects()
            .iter()
            .all(|e| !matches!(e, Effect::Failed(_) | Effect::Warn("原生钉图画不上", _))),
        "旧的失败不算在重建后那一帧上"
    );
    r.run();
    assert!(!r.o.pins[&A].closing);
    assert!(r.o.shell().window(A).is_some());
}
