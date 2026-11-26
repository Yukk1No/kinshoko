//! 桌面钉图窗口对齐（#750）：参考组快照是想要的状态，原生窗口的回报是实际状态，
//! 这里统一决定打开、关闭与迟到的回报怎么收口。切组、新钉、关闭只交来意图；这里在串行段
//! 取最新快照，入口不各自比较名单，也不在打开后补查。
//!
//! 钉图 id 一次只走一条命：打开、关闭、关上。成员再钉回或换桌回来时由 core 另发新 id；
//! 同一张钉图的打开已在路上而要关闭时，关掉命令可能抢在打开命令前面变成空操作，所以
//! `Shown` 迟到时按此刻仍要不要它再关一次。打开失败保持本次运行不重试（与恢复语义相同）：
//! 状态仍在参考组里，下次启动再钉。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Mutex, OnceLock};

use kinshoko_core::desktop::{Placement, SavedPin};
use tauri::AppHandle;

use crate::desktop::{lock, state};

/// 提交对齐的入口。决策只看最新快照，入口只说明这次快照是怎么来的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::desktop) enum AlignIntent {
    /// 启动时恢复桌面。
    Restore,
    /// 桌面上的参考组变了（切换、新建、钉回、移出、撤销）。
    Desk,
    /// 新钉了一张。
    Pin,
    /// 画师关闭了一张。
    Close,
}

/// 原生钉图一次操作要写回桌面状态的字段。没改的字段为 `None`，由桌面状态合并到当前钉图上，
/// 免得晚到的拖动回报盖掉其间菜单改过的透明度或锁定。
#[derive(Debug, Clone, PartialEq)]
pub(in crate::desktop) struct PinSave {
    pub pin: String,
    pub placement: Option<Placement>,
    pub opacity: Option<f64>,
}

impl PinSave {
    pub(in crate::desktop) fn placement(pin: &str, placement: Placement) -> PinSave {
        PinSave {
            pin: pin.to_owned(),
            placement: Some(placement),
            opacity: None,
        }
    }

    pub(in crate::desktop) fn opacity(pin: &str, opacity: f64) -> PinSave {
        PinSave {
            pin: pin.to_owned(),
            placement: None,
            opacity: Some(opacity),
        }
    }

    pub(in crate::desktop) fn apply_to(&self, pin: &mut SavedPin) {
        if let Some(placement) = self.placement {
            pin.placement = placement;
        }
        if let Some(opacity) = self.opacity {
            pin.opacity = opacity;
        }
    }
}

/// 原生窗口与输入的异步回报。
#[derive(Debug, Clone, PartialEq)]
pub(in crate::desktop) enum NativeReport {
    Shown(String),
    Closed(String),
    Failed(String),
    Saved(PinSave),
}

/// 原生窗口 adapter：对齐状态机只决定动作，怎么开、怎么关由它执行。
trait PinWindowAdapter {
    fn open(&mut self, pin: SavedPin);
    fn close(&mut self, pin: &str);
}

#[derive(Debug, Clone, PartialEq)]
enum AlignmentAction {
    Open(SavedPin),
    Close(String),
    Retire(String),
    Shown(String),
    Writeback(PinSave),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Opening { close_after: bool },
    Open,
    Closing,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Window {
    stage: Stage,
}

/// “最新参考组状态 × 在途开关状态 × 原生窗口实际状态”的对齐状态机。
struct PinAlignment {
    desired: Vec<SavedPin>,
    windows: BTreeMap<String, Window>,
}

impl PinAlignment {
    fn new() -> PinAlignment {
        PinAlignment {
            desired: Vec::new(),
            windows: BTreeMap::new(),
        }
    }

    fn submit(&mut self, intent: AlignIntent, desired: Vec<SavedPin>) -> Vec<AlignmentAction> {
        // 三个入口走同一份决策：意图不另开分支，最终一致性只由最新快照与窗口回报推出。
        let _ = intent;
        self.desired = desired;
        self.reconcile()
    }

    fn report(&mut self, report: NativeReport) -> Vec<AlignmentAction> {
        match report {
            NativeReport::Saved(save) => vec![AlignmentAction::Writeback(save)],
            NativeReport::Shown(pin) => self.shown(pin),
            NativeReport::Failed(pin) => self.failed(pin),
            NativeReport::Closed(pin) => self.closed(pin),
        }
    }

    fn shown(&mut self, pin: String) -> Vec<AlignmentAction> {
        let mut actions = vec![AlignmentAction::Shown(pin.clone())];
        let Some(window) = self.windows.get_mut(&pin) else {
            return actions;
        };
        match window.stage {
            Stage::Opening { close_after: true } => {
                window.stage = Stage::Closing;
                actions.push(AlignmentAction::Close(pin));
            }
            Stage::Opening { close_after: false } => {
                window.stage = Stage::Open;
                actions.extend(self.reconcile());
            }
            _ => {}
        }
        actions
    }

    fn failed(&mut self, pin: String) -> Vec<AlignmentAction> {
        let wanted = self.desired.iter().any(|p| p.id == pin);
        let mut window = match self.windows.get_mut(&pin) {
            Some(window) => *window,
            None => return Vec::new(),
        };
        // 关闭动作可能赶在打开记录登记之前空操作；终端回报时再收一次，重复的 retire 是幂等的。
        let actions = vec![AlignmentAction::Retire(pin.clone())];
        if wanted {
            window.stage = Stage::Failed;
            self.windows.insert(pin, window);
        } else {
            self.windows.remove(&pin);
        }
        actions
    }

    fn closed(&mut self, pin: String) -> Vec<AlignmentAction> {
        let Some(window) = self.windows.get(&pin).copied() else {
            return Vec::new();
        };
        if window.stage == Stage::Failed {
            // 打开失败已经在 Failed 回报时收掉记录；它随后的 Closed 不是新的关闭意图，不能触发重试。
            return Vec::new();
        }
        self.windows.remove(&pin);
        // 关闭动作可能赶在打开记录登记之前空操作；终端回报时再收一次，重复的 retire 是幂等的。
        let mut actions = vec![AlignmentAction::Retire(pin)];
        actions.extend(self.reconcile());
        actions
    }

    /// 先关掉不想要的，再打开还没有的。关闭中的同 id 等 `Closed` 之后再按快照重开。
    fn reconcile(&mut self) -> Vec<AlignmentAction> {
        let desired_ids: BTreeSet<&str> = self.desired.iter().map(|p| p.id.as_str()).collect();
        let mut actions = Vec::new();
        let ids: Vec<String> = self.windows.keys().cloned().collect();
        for id in ids {
            if desired_ids.contains(id.as_str()) {
                continue;
            }
            let Some(window) = self.windows.get_mut(&id) else {
                continue;
            };
            match window.stage {
                Stage::Opening { close_after: false } => {
                    window.stage = Stage::Opening { close_after: true };
                    actions.push(AlignmentAction::Close(id));
                }
                Stage::Open => {
                    window.stage = Stage::Closing;
                    actions.push(AlignmentAction::Close(id));
                }
                Stage::Failed => {
                    self.windows.remove(&id);
                }
                _ => {}
            }
        }
        for pin in self.desired.clone() {
            if self.windows.contains_key(&pin.id) {
                continue;
            }
            self.windows.insert(
                pin.id.clone(),
                Window {
                    stage: Stage::Opening { close_after: false },
                },
            );
            actions.push(AlignmentAction::Open(pin));
        }
        actions
    }
}

static ALIGNING: Mutex<()> = Mutex::new(());

fn alignment() -> &'static Mutex<PinAlignment> {
    static ALIGNMENT: OnceLock<Mutex<PinAlignment>> = OnceLock::new();
    ALIGNMENT.get_or_init(|| Mutex::new(PinAlignment::new()))
}

/// 一个入口提交意图；快照在串行段里取，后到的快照不会盖住先到的快照。窗口动作放开串行锁再做：
/// 关闭要进可见性许可，而新钉入口本身可能正持有那把许可。
pub(in crate::desktop) fn submit(app: &AppHandle, intent: AlignIntent) {
    let actions = {
        let _aligning = lock(&ALIGNING);
        let desired = lock(&state(app).store).pins().to_vec();
        lock(alignment()).submit(intent, desired)
    };
    execute(app, Some(intent), actions);
}

/// 原生窗口或输入的异步回报。与入口提交走同一把串行锁，晚到的回报按最新快照收口。
pub(in crate::desktop) fn native_report(app: &AppHandle, report: NativeReport) {
    let actions = {
        let _aligning = lock(&ALIGNING);
        lock(alignment()).report(report)
    };
    execute(app, None, actions);
}

struct NativeAdapter<'a> {
    app: &'a AppHandle,
}

impl PinWindowAdapter for NativeAdapter<'_> {
    fn open(&mut self, pin: SavedPin) {
        super::open_pin(self.app, &pin);
    }

    fn close(&mut self, pin: &str) {
        super::dismiss(self.app, pin);
    }
}

/// 发起窗口动作。动作本身异步完成（原生窗口的回报之后才来）。新钉入口可能在可见性许可里：
/// 它理论上不需要关窗；一旦交错局面仍产生了关闭动作，就挪到别的线程做，免得重入许可。
fn execute(app: &AppHandle, intent: Option<AlignIntent>, actions: Vec<AlignmentAction>) {
    let prepare_library = matches!(intent, Some(AlignIntent::Restore | AlignIntent::Desk));
    let mut library_ready = false;
    let defer_close = intent == Some(AlignIntent::Pin);
    let mut deferred = Vec::new();
    for action in actions {
        // 恢复或换桌打开的资料库钉图先要本设备上次打开的资料库；新钉来自查看器，已经在读它的库。
        // 到第一张资料库钉图之前才开，前面的关闭动作不被它拖住。
        if prepare_library
            && !library_ready
            && matches!(&action, AlignmentAction::Open(pin) if pin.capture_id().is_none())
        {
            library_ready = true;
            if let Err(e) = crate::library::current_or_last(app)
                && intent == Some(AlignIntent::Restore)
            {
                crate::run_log::error("恢复资料库钉图时无法打开资料库", e);
            }
        }
        if defer_close
            && matches!(
                action,
                AlignmentAction::Close(_) | AlignmentAction::Retire(_)
            )
        {
            deferred.push(action);
        } else {
            perform(app, action);
        }
    }
    if !deferred.is_empty() {
        let app = app.clone();
        std::thread::spawn(move || {
            for action in deferred {
                perform(&app, action);
            }
        });
    }
}

fn perform(app: &AppHandle, action: AlignmentAction) {
    let mut adapter = NativeAdapter { app };
    match action {
        AlignmentAction::Open(pin) => adapter.open(pin),
        AlignmentAction::Close(pin) => adapter.close(&pin),
        AlignmentAction::Retire(pin) => super::closed(app, &pin),
        AlignmentAction::Shown(pin) => {
            if let Some(record) = lock(&state(app).pins).get_mut(&pin) {
                record.shown = true;
            }
            super::stop_waiting(app, &pin);
        }
        AlignmentAction::Writeback(save) => writeback(app, save),
    }
}

/// 原生钉图的写回只合并未改的字段以外的本次修改；位置写回同时更新本次运行记录里的内容位置。
fn writeback(app: &AppHandle, save: PinSave) {
    let pin = save.pin.clone();
    let rect = super::edit(app, &pin, |pin| {
        save.apply_to(pin);
        save.placement.map(|_| pin.rect())
    });
    let tucked = lock(&state(app).edge).is_hidden(&pin);
    if let (Some(Some(rect)), Some(record)) = (rect, lock(&state(app).pins).get_mut(&pin))
        && !tucked
    {
        record.content = rect;
    }
}

#[cfg(test)]
mod tests;
