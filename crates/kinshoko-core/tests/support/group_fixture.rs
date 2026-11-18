//! 测试用：经桌面上的参考组（[`Desk`]，#588）存出参考组，代替已删掉的“存成参考组”“存进参考组”。
//! 桌面状态放在一个用完就丢的临时目录里，参考组照常写进 `groups`。

#![allow(dead_code)]

use kinshoko_core::desktop::{CaptureHistory, SavedPin};
use kinshoko_core::reference_groups::{
    Desk, GroupError, OpenedPins, ReferenceGroup, ReferenceGroups,
};

/// 把 `pins` 摆在一张新桌上、起名 `name` 并落盘，得到新的参考组；每张钉图记下自己成了哪个成员。
/// 只有资料库钉图；有截图钉图时用 [`save_group_with_history`]。
pub fn save_group(
    groups: &ReferenceGroups,
    name: &str,
    pins: &mut [SavedPin],
) -> Result<ReferenceGroup, GroupError> {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    save_group_with_history(groups, &mut history, name, pins)
}

/// 同 [`save_group`]；截图钉图的截图从 `history` 里取，复制进参考组成为它自带的截图，截图历史记下
/// 关联（之后收藏能改连）。存好后像钉图已经关掉一样，截图历史不再算它们钉住。
pub fn save_group_with_history(
    groups: &ReferenceGroups,
    history: &mut CaptureHistory,
    name: &str,
    pins: &mut [SavedPin],
) -> Result<ReferenceGroup, GroupError> {
    let dir = tempfile::tempdir().unwrap();
    let mut desk = Desk::open(dir.path(), groups.clone(), history)?;
    for pin in pins.iter_mut() {
        pin.member = desk.pin(pin.clone(), history)?.member;
    }
    let id = desk.group().id.clone();
    desk.rename(&id, name)?;
    desk.flush()?;
    for capture in pins.iter().filter_map(SavedPin::capture_id) {
        history.unpin(capture);
    }
    groups.get(&id)
}

/// 把参考组 `id` 摆到一张新桌上（切换过去），得到钉出来的钉图；组内截图放回 `history`。
pub fn open_group(
    groups: &ReferenceGroups,
    history: &mut CaptureHistory,
    id: &str,
) -> Result<OpenedPins, GroupError> {
    let dir = tempfile::tempdir().unwrap();
    let mut desk = Desk::open(dir.path(), groups.clone(), history)?;
    Ok(desk.switch_to(id, history)?.opened)
}

/// 让测试照旧写 `groups.save_group(…)`、`groups.add_to_group(…)`。
pub trait GroupFixture {
    fn save_group(&self, name: &str, pins: &mut [SavedPin]) -> Result<ReferenceGroup, GroupError>;
    fn add_to_group(&self, id: &str, pins: &mut [SavedPin]) -> Result<ReferenceGroup, GroupError>;
}

impl GroupFixture for ReferenceGroups {
    fn save_group(&self, name: &str, pins: &mut [SavedPin]) -> Result<ReferenceGroup, GroupError> {
        save_group(self, name, pins)
    }

    fn add_to_group(&self, id: &str, pins: &mut [SavedPin]) -> Result<ReferenceGroup, GroupError> {
        add_to_group(self, id, pins)
    }
}

/// 把资料库钉图加进已有的参考组 `id`（图库墙“加入参考组”），得到改好的参考组。
pub fn add_to_group(
    groups: &ReferenceGroups,
    id: &str,
    pins: &[SavedPin],
) -> Result<ReferenceGroup, GroupError> {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let mut desk = Desk::open(dir.path(), groups.clone(), &mut history)?;
    let mut group = groups.get(id)?;
    for pin in pins {
        group = desk.add_member(id, pin)?.expect("新桌上摆的不是这个参考组");
    }
    Ok(group)
}
