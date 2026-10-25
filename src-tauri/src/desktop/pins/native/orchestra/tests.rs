//! 编排对假平台层（`FakeShell`）与只记录的假渲染层的序列测试。

use std::time::{Duration, Instant};

use kinshoko_core::desktop::frame::{SourceSize, window_for};
use kinshoko_core::desktop::{PinContent, Placement, SavedPin, ScreenRect};
use pin_shell::fake::{Call, FakeShell};
use pin_shell::{
    Display, Key, PinId, PinInput, PinKeys, Pointer, PointerButton, PointerEvent, PointerKind,
};

use super::*;
use crate::desktop::pins::native::port::{DrawJob, RenderEvent, RenderPort};

mod failures;

/// 渲染层的一次调用。
#[derive(Debug, Clone, PartialEq)]
enum RCall {
    Attach(PinId),
    Load(PinId, SourceSize),
    Draw(Box<DrawJob>),
    Detach(PinId),
}

#[derive(Default)]
struct FakeRender {
    calls: Vec<RCall>,
    /// 还没回报的调用。
    open: Vec<RCall>,
}

impl RenderPort for FakeRender {
    fn attach(&mut self, pin: PinId, _: [wgpu::SurfaceTargetUnsafe; 2]) {
        self.calls.push(RCall::Attach(pin));
    }
    fn load(&mut self, pin: PinId, _: &SavedPin, size: SourceSize) {
        self.calls.push(RCall::Load(pin, size));
        self.open.push(RCall::Load(pin, size));
    }
    fn draw(&mut self, job: DrawJob) {
        self.calls.push(RCall::Draw(Box::new(job.clone())));
        self.open.push(RCall::Draw(Box::new(job)));
    }
    fn detach(&mut self, pin: PinId) {
        self.calls.push(RCall::Detach(pin));
        self.open.push(RCall::Detach(pin));
    }
}

const SCREEN: ScreenRect = ScreenRect {
    x: 0,
    y: 0,
    width: 2560,
    height: 1440,
};
const A: PinId = PinId(1);

type O = Orchestra<FakeShell, FakeRender>;

struct Rig {
    o: O,
    now: Instant,
}

fn marker() -> SavedPin {
    SavedPin {
        id: "marker".into(),
        content: PinContent::Reference {
            library_id: "lib".into(),
            image_id: "img".into(),
            source_width: 2000,
            source_height: 3000,
        },
        crop: None,
        width: 2000,
        height: 3000,
        placement: Placement {
            x: 100,
            y: 100,
            scale: 0.25,
            ..Placement::default()
        },
        opacity: 1.0,
        locked: false,
        member: None,
    }
}

impl Rig {
    /// 开一张钉图，渲染层把读图、绘制都做完，钉图显示出来；调用记录清空。
    fn shown() -> Rig {
        Rig::shown_on(vec![Display {
            id: "A".into(),
            rect: SCREEN,
            scale: 1.0,
            profile: None,
        }])
    }

    fn shown_on(displays: Vec<Display>) -> Rig {
        let shell = FakeShell::new(displays);
        let mut r = Rig {
            o: Orchestra::new(shell, FakeRender::default()),
            now: Instant::now(),
        };
        r.o.open(marker()).unwrap();
        r.finish_render();
        r.o.take_effects();
        r.o.shell().take_calls();
        r.o.render().calls.clear();
        r
    }

    /// 渲染层把排着的事都做完并回报。
    fn finish_render(&mut self) {
        loop {
            let open = std::mem::take(&mut self.o.render().open);
            if open.is_empty() {
                break;
            }
            for call in open {
                let event = match call {
                    RCall::Load(pin, size) => RenderEvent::Loaded { pin, size },
                    RCall::Draw(job) => RenderEvent::Drawn {
                        pin: job.pin,
                        result: Ok(()),
                    },
                    RCall::Detach(pin) => RenderEvent::Detached { pin },
                    RCall::Attach(_) => continue,
                };
                self.o.render_event(event);
            }
        }
    }

    /// 平台层排着的输入（含换窗完成）处理掉，渲染层也做完，直到都停下。
    fn run(&mut self) {
        for _ in 0..16 {
            self.o.pump(self.now);
            self.finish_render();
        }
    }

    fn input(&mut self, input: PinInput) {
        self.o.shell().push(input);
        self.run();
    }

    fn wheel(&mut self, notches: f64, ctrl: bool) {
        self.input(PinInput::Wheel {
            pin: A,
            at: (200, 300),
            notches,
            ctrl,
        });
    }

    fn pointer(&mut self, at: (i32, i32), event: PointerEvent) {
        self.input(PinInput::Pointer(Pointer {
            pin: A,
            kind: PointerKind::Mouse,
            at,
            event,
        }));
    }

    fn wait(&mut self, ms: u64) {
        self.now += Duration::from_millis(ms);
        self.o.tick(self.now);
        self.run();
    }

    fn shell_calls(&mut self) -> Vec<Call> {
        self.o.shell().take_calls()
    }

    fn draws(&mut self) -> Vec<DrawJob> {
        std::mem::take(&mut self.o.render().calls)
            .into_iter()
            .filter_map(|c| match c {
                RCall::Draw(j) => Some(*j),
                _ => None,
            })
            .collect()
    }
}

#[test]
fn a_new_pin_is_drawn_once_its_image_arrives_then_shown() {
    let shell = FakeShell::new(vec![Display {
        id: "A".into(),
        rect: SCREEN,
        scale: 1.0,
        profile: None,
    }]);
    let mut o: O = Orchestra::new(shell, FakeRender::default());
    let pin = marker();
    o.open(pin.clone()).unwrap();
    let window = window_for(pin.rect(), &[SCREEN]).unwrap();
    assert_eq!(
        o.render().calls,
        [RCall::Attach(A), RCall::Load(A, SourceSize::Width(500))]
    );
    assert_eq!(
        o.shell().take_calls(),
        [Call::Keys(PinKeys::new([Key::Escape])), Call::Create(A)]
    );

    o.render_event(RenderEvent::Loaded {
        pin: A,
        size: SourceSize::Width(500),
    });
    let RCall::Draw(job) = o.render().calls.last().cloned().unwrap() else {
        panic!("应当画第一帧");
    };
    assert_eq!((job.slot, job.window, job.content), (0, window, pin.rect()));
    assert!(o.shell().calls().is_empty(), "画好之前不显示");

    o.render_event(RenderEvent::Drawn {
        pin: A,
        result: Ok(()),
    });
    assert_eq!(o.shell().take_calls(), [Call::Show(A, window)]);
    assert_eq!(o.take_effects(), [Effect::Shown("marker".into())]);
}

#[test]
fn one_wheel_notch_swaps_once_then_only_redraws_until_settled() {
    let mut r = Rig::shown();
    r.wheel(1.0, false);
    let calls = r.shell_calls();
    assert!(
        matches!(calls.as_slice(), [Call::Stage(A, _), Call::Swap(A)]),
        "{calls:?}"
    );
    assert_eq!(r.draws().len(), 1);

    for _ in 0..3 {
        r.wheel(1.0, false);
        assert_eq!(r.shell_calls(), [], "包络里只重画");
        let draws = r.draws();
        assert_eq!(draws.len(), 1);
        assert_eq!(draws[0].slot, r.o.shell().visible_slot(A));
    }
}

#[test]
fn settling_swaps_the_window_back_to_fit_the_pin() {
    let mut r = Rig::shown();
    for _ in 0..3 {
        r.wheel(1.0, false);
    }
    r.shell_calls();
    r.wait(SETTLE_MS - 1);
    assert_eq!(r.shell_calls(), [], "还没停手");
    r.wait(1);
    let fit = window_for(r.o.pins[&A].pin.rect(), &[SCREEN]).unwrap();
    assert_eq!(r.shell_calls(), [Call::Stage(A, fit), Call::Swap(A)]);
    assert_eq!(r.o.shell().window(A), Some(fit));
    assert_eq!(r.o.next_deadline(), None);
}

#[test]
fn the_wheel_zooms_about_the_cursor() {
    let mut r = Rig::shown();
    let before = r.o.pins[&A].pin.clone();
    r.wheel(1.0, false);
    let after = &r.o.pins[&A].pin;
    assert!(after.placement.scale > before.placement.scale);
    let fraction = |at: f64, x: i32, w: f64| (at - f64::from(x)) / w;
    let (bw, _) = before.exact_size();
    let (aw, _) = after.exact_size();
    let f0 = fraction(200.0, before.placement.x, bw);
    let f1 = fraction(200.0, after.placement.x, aw);
    assert!((f0 - f1).abs() * aw < 1.0, "光标下的点不漂移");
}

#[test]
fn dragging_only_translates() {
    let mut r = Rig::shown();
    r.pointer((150, 150), PointerEvent::Down(PointerButton::Primary));
    assert_eq!(r.shell_calls(), [Call::Raise(A)]);
    for k in 1..=5 {
        r.pointer((150 + 10 * k, 150 + 3 * k), PointerEvent::Move);
    }
    r.pointer((200, 165), PointerEvent::Up(PointerButton::Primary));
    r.wait(SETTLE_MS);
    let calls = r.shell_calls();
    assert_eq!(calls.len(), 5, "{calls:?}");
    assert!(calls.iter().all(|c| matches!(c, Call::Translate(A, _))));
    assert_eq!(r.draws(), [], "拖动不重画");
    assert_eq!(r.o.pins[&A].pin.placement.x, 150);
    assert_eq!(r.o.pins[&A].pin.placement.y, 115);
}

#[test]
fn a_locked_pin_does_not_move_or_zoom() {
    let mut r = Rig::shown();
    r.o.pins.get_mut(&A).unwrap().pin.locked = true;
    r.pointer((150, 150), PointerEvent::Down(PointerButton::Primary));
    r.pointer((190, 150), PointerEvent::Move);
    r.wheel(1.0, false);
    assert_eq!(r.shell_calls(), [Call::Raise(A)]);
    assert_eq!(r.draws(), []);
    assert_eq!(r.o.take_effects(), []);
}

#[test]
fn updates_during_a_swap_wait_for_it_and_never_draw_the_outgoing_slot() {
    let mut r = Rig::shown();
    r.o.shell().hold_swaps(true);
    r.wheel(1.0, false);
    assert!(r.o.shell().swap_pending(A));
    r.draws();
    r.wheel(1.0, false);
    r.wheel(1.0, false);
    r.pointer((150, 150), PointerEvent::Down(PointerButton::Primary));
    r.pointer((170, 150), PointerEvent::Move);
    assert_eq!(r.draws(), [], "换窗完成前不画");
    r.shell_calls();

    r.o.shell().finish_swaps();
    r.run();
    let draws = r.draws();
    assert_eq!(draws.len(), 1, "攒下的更新合成一次");
    assert_eq!(draws[0].slot, r.o.shell().visible_slot(A));
    assert_eq!(draws[0].content, r.o.pins[&A].pin.rect());
}

#[test]
fn a_move_waits_for_a_redraw_still_in_flight() {
    let mut r = Rig::shown();
    r.wheel(1.0, false);
    r.shell_calls();
    r.draws();
    // 包络里重画，渲染层还没画完时又拖动。
    r.o.shell().push(PinInput::Wheel {
        pin: A,
        at: (200, 300),
        notches: 1.0,
        ctrl: false,
    });
    r.o.pump(r.now);
    assert_eq!(r.o.render().open.len(), 1);
    r.o.input(
        PinInput::Pointer(Pointer {
            pin: A,
            kind: PointerKind::Mouse,
            at: (150, 150),
            event: PointerEvent::Down(PointerButton::Primary),
        }),
        r.now,
    );
    r.o.input(
        PinInput::Pointer(Pointer {
            pin: A,
            kind: PointerKind::Mouse,
            at: (160, 150),
            event: PointerEvent::Move,
        }),
        r.now,
    );
    assert_eq!(r.shell_calls(), [Call::Raise(A)], "重画还在路上：不平移");
    r.run();
    assert_eq!(r.draws().len(), 2);
}

#[test]
fn ctrl_wheel_changes_opacity_and_only_redraws() {
    let mut r = Rig::shown();
    r.wheel(-1.0, true);
    assert_eq!(r.shell_calls(), []);
    let draws = r.draws();
    assert_eq!(draws.len(), 1);
    assert!((draws[0].state.opacity - 0.9).abs() < 1e-9);
    let effects = r.o.take_effects();
    assert!(matches!(effects.as_slice(), [Effect::Saved(p)] if (p.opacity - 0.9).abs() < 1e-9));
    r.wheel(1.0, true);
    r.wheel(1.0, true);
    assert_eq!(r.draws().len(), 1, "已到 100% 的那一格不重画");
}

#[test]
fn every_change_is_saved() {
    let mut r = Rig::shown();
    r.wheel(1.0, false);
    r.pointer((150, 150), PointerEvent::Down(PointerButton::Primary));
    r.pointer((160, 150), PointerEvent::Move);
    let effects = r.o.take_effects();
    assert_eq!(effects.len(), 2);
    let Effect::Saved(last) = &effects[1] else {
        panic!("{effects:?}")
    };
    assert_eq!(last, &r.o.pins[&A].pin);
}

#[test]
fn settling_after_zooming_out_asks_for_the_exact_size_derivative() {
    let mut r = Rig::shown();
    r.wheel(-1.0, false);
    r.o.render().calls.clear();
    r.wait(SETTLE_MS);
    let scale = r.o.pins[&A].pin.placement.scale;
    let want = SourceSize::Width((2000.0 * scale).round() as u32);
    let calls = std::mem::take(&mut r.o.render().calls);
    assert_eq!(calls[0], RCall::Load(A, want));
    // 图到了以后重画一次。
    assert!(matches!(calls.last(), Some(RCall::Draw(_))), "{calls:?}");
}

#[test]
fn a_stale_load_is_ignored() {
    let mut r = Rig::shown();
    r.o.render_event(RenderEvent::Loaded {
        pin: A,
        size: SourceSize::Full,
    });
    assert_eq!(r.draws(), []);
}

#[test]
fn escape_asks_the_app_to_close_and_close_tears_down_after_the_renderer() {
    let mut r = Rig::shown();
    r.o.shell().push(PinInput::Key {
        pin: A,
        key: Key::Escape,
        shift: false,
        repeat: false,
    });
    r.o.pump(r.now);
    assert_eq!(
        r.o.take_effects(),
        [Effect::CloseRequested("marker".into())]
    );
    r.o.close("marker");
    assert_eq!(r.o.render().calls, [RCall::Detach(A)]);
    assert_eq!(r.shell_calls(), [], "Surface 丢掉之前不关窗口");
    r.finish_render();
    assert_eq!(r.shell_calls(), [Call::Close(A)]);
    assert_eq!(r.o.take_effects(), [Effect::Closed("marker".into())]);
    assert!(r.o.is_empty());
}

#[test]
fn input_for_a_closing_pin_is_ignored() {
    let mut r = Rig::shown();
    r.o.close("marker");
    r.o.render().calls.clear();
    r.o.input(
        PinInput::Wheel {
            pin: A,
            at: (200, 300),
            notches: 1.0,
            ctrl: false,
        },
        r.now,
    );
    assert_eq!(r.o.render().calls, []);
    assert_eq!(r.shell_calls(), []);
}

#[test]
fn the_draw_carries_the_profile_of_the_display_under_the_pin() {
    let shell = FakeShell::new(vec![
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
    let mut o: O = Orchestra::new(shell, FakeRender::default());
    let mut pin = marker();
    pin.placement.x = 2700;
    o.open(pin).unwrap();
    o.render_event(RenderEvent::Loaded {
        pin: A,
        size: SourceSize::Width(500),
    });
    let RCall::Draw(job) = o.render().calls.last().cloned().unwrap() else {
        panic!()
    };
    assert_eq!(job.display.as_deref(), Some(&[4u8, 5][..]));
}

#[test]
fn submissions_are_reported_before_the_shell_is_told() {
    use std::cell::RefCell;
    use std::rc::Rc;
    let mut r = Rig::shown();
    let seen = Rc::new(RefCell::new(Vec::new()));
    let log = seen.clone();
    r.o.on_submit(move |s| log.borrow_mut().push(*s));
    r.wheel(1.0, false);
    r.pointer((150, 150), PointerEvent::Down(PointerButton::Primary));
    r.pointer((160, 150), PointerEvent::Move);
    let seen = seen.borrow();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[1].content, r.o.pins[&A].pin.rect());
    assert_eq!(Some(seen[1].window), r.o.shell().window(A));
}
