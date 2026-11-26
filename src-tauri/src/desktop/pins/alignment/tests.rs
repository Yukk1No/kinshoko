use super::*;
use std::collections::VecDeque;

use kinshoko_core::desktop::{PinContent, Placement};

#[derive(Debug, Clone, PartialEq, Eq)]
enum AdapterCall {
    Open(String),
    Close(String),
}

/// 可延迟回报的窗口 adapter：open / close 立即记进假窗口系统，回报留在队列里由测试决定何时送达。
struct DeferredAdapter {
    calls: Vec<AdapterCall>,
    open: BTreeSet<String>,
    reports: VecDeque<NativeReport>,
}

impl DeferredAdapter {
    fn new() -> DeferredAdapter {
        DeferredAdapter {
            calls: Vec::new(),
            open: BTreeSet::new(),
            reports: VecDeque::new(),
        }
    }
}

impl PinWindowAdapter for DeferredAdapter {
    fn open(&mut self, pin: SavedPin) {
        let id = pin.id.clone();
        self.calls.push(AdapterCall::Open(id.clone()));
        self.open.insert(id.clone());
        self.reports.push_back(NativeReport::Shown(id));
    }

    fn close(&mut self, pin: &str) {
        self.calls.push(AdapterCall::Close(pin.to_owned()));
        if self.open.remove(pin) {
            self.reports.push_back(NativeReport::Closed(pin.to_owned()));
        }
    }
}

struct Rig {
    alignment: PinAlignment,
    adapter: DeferredAdapter,
    desk: Vec<SavedPin>,
    writebacks: Vec<PinSave>,
}

impl Rig {
    fn new() -> Rig {
        Rig {
            alignment: PinAlignment::new(),
            adapter: DeferredAdapter::new(),
            desk: Vec::new(),
            writebacks: Vec::new(),
        }
    }

    fn submit(&mut self, intent: AlignIntent, desired: Vec<SavedPin>) {
        self.desk = desired.clone();
        let actions = self.alignment.submit(intent, desired);
        self.drive(actions);
    }

    fn report(&mut self, report: NativeReport) {
        let actions = self.alignment.report(report);
        self.drive(actions);
    }

    fn deliver_next(&mut self) {
        let report = self.adapter.reports.pop_front().expect("测试先确认有回报");
        self.report(report);
    }

    /// 回报可以乱序送达：挑出队列里最早的这一条，前面的继续扣着。
    fn deliver(&mut self, wanted: NativeReport) {
        let at = self
            .adapter
            .reports
            .iter()
            .position(|report| *report == wanted)
            .expect("测试先确认这条回报在队列里");
        let report = self.adapter.reports.remove(at).expect("刚找到");
        self.report(report);
    }

    fn deliver_all(&mut self) {
        while let Some(report) = self.adapter.reports.pop_front() {
            self.report(report);
        }
    }

    fn drive(&mut self, actions: Vec<AlignmentAction>) {
        for action in actions {
            match action {
                AlignmentAction::Open(pin) => self.adapter.open(pin),
                AlignmentAction::Close(pin) => self.adapter.close(&pin),
                AlignmentAction::Writeback(save) => {
                    if let Some(pin) = self.desk.iter_mut().find(|pin| pin.id == save.pin) {
                        save.apply_to(pin);
                    }
                    self.writebacks.push(save);
                }
                AlignmentAction::Retire(_) | AlignmentAction::Shown(_) => {}
            }
        }
    }

    fn calls(&self) -> &[AdapterCall] {
        &self.adapter.calls
    }
}

fn pin(id: &str) -> SavedPin {
    SavedPin {
        id: id.to_owned(),
        content: PinContent::Capture {
            capture_id: format!("capture-{id}"),
        },
        crop: None,
        width: 100,
        height: 80,
        placement: Placement {
            x: 10,
            y: 20,
            ..Placement::default()
        },
        opacity: 1.0,
        locked: false,
        member: None,
    }
}

#[test]
fn a_pin_switched_away_before_it_is_shown_is_closed_after_the_late_report() {
    let mut r = Rig::new();
    r.submit(AlignIntent::Pin, vec![pin("a")]);
    r.submit(AlignIntent::Desk, Vec::new());
    assert_eq!(
        r.calls(),
        [
            AdapterCall::Open("a".into()),
            AdapterCall::Close("a".into())
        ]
    );

    // 扣住回报后先送晚到的 Shown：关掉命令可能已在打开命令之前空操作，这里必须再关一次。
    r.deliver_next();
    assert_eq!(
        r.calls()
            .iter()
            .filter(|call| **call == AdapterCall::Close("a".into()))
            .count(),
        2
    );
    r.deliver_all();
    assert!(r.adapter.open.is_empty());
}

#[test]
fn switch_pin_and_close_interleave_to_the_final_desk() {
    let mut r = Rig::new();
    r.submit(AlignIntent::Desk, vec![pin("a")]);
    r.deliver_next();
    assert!(r.adapter.open.contains("a"));

    // 关闭 a 的回报扣住；其间钉上 b，又整桌换成 c。
    r.submit(AlignIntent::Close, Vec::new());
    r.submit(AlignIntent::Pin, vec![pin("b")]);
    r.submit(AlignIntent::Desk, vec![pin("c")]);
    assert_eq!(
        r.calls(),
        [
            AdapterCall::Open("a".into()),
            AdapterCall::Close("a".into()),
            AdapterCall::Open("b".into()),
            AdapterCall::Close("b".into()),
            AdapterCall::Open("c".into())
        ]
    );

    // b 的 Shown 越过还扣着的 Closed 晚到，对齐状态机按最新快照再关一次；最终只留下 c。
    r.deliver(NativeReport::Shown("b".into()));
    r.deliver_all();
    assert_eq!(r.adapter.open.iter().collect::<Vec<_>>(), ["c"]);
    assert_eq!(
        r.calls()
            .iter()
            .filter(|call| **call == AdapterCall::Close("b".into()))
            .count(),
        2,
        "b 的 Shown 晚到时已经不需要它，要再关一次"
    );
    assert_eq!(r.alignment.windows.len(), 1);
    assert_eq!(r.alignment.windows["c"].stage, Stage::Open);
}

#[test]
fn a_failed_open_is_not_retried_in_this_run() {
    let mut r = Rig::new();
    r.submit(AlignIntent::Pin, vec![pin("a")]);
    // 第一帧画不上时原生侧收掉窗口，随后报 Closed。
    r.adapter.open.remove("a");
    r.report(NativeReport::Failed("a".into()));
    r.report(NativeReport::Closed("a".into()));
    assert_eq!(
        r.calls()
            .iter()
            .filter(|call| matches!(call, AdapterCall::Open(_)))
            .count(),
        1
    );
    assert!(r.adapter.open.is_empty());
}

#[test]
fn a_delayed_writeback_merges_only_the_fields_it_changed() {
    let mut r = Rig::new();
    r.submit(AlignIntent::Pin, vec![pin("a")]);
    r.deliver_next();
    let mut placement = r.alignment.desired[0].placement;
    placement.x = 300;
    let writeback = PinSave::placement("a", placement);

    // 拖动回报已在原生窗口系统里产生，但先扣住；其间菜单改透明度与锁定。
    r.adapter
        .reports
        .push_back(NativeReport::Saved(writeback.clone()));
    r.desk[0].opacity = 0.4;
    r.desk[0].locked = true;
    r.deliver_next();

    assert_eq!(r.writebacks, [writeback]);
    assert_eq!(r.writebacks[0].pin, "a");
    assert_eq!(r.writebacks[0].opacity, None);
    assert_eq!(r.desk[0].placement, placement);
    assert_eq!(r.desk[0].opacity, 0.4);
    assert!(r.desk[0].locked);
}
