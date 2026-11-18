//! 第一次打开桌面状态时的迁移（#590）：现有参考组全部算归档，文件一个字节都不改；
//! `pins.json` 里的钉图成为一个没有名称的参考组，摆在桌面上。
//!
//! 可重复执行：迁移出的参考组用固定的身份 [`MIGRATED_ID`]，先写它、最后写桌面状态。中途断电后
//! 再启动会从头再迁一次，覆盖上次写了一半的同一个参考组，不产生重复的参考组，也不丢钉图。

use std::fs;
use std::path::Path;

use super::super::{
    CaptureFiles, GroupError, GroupMember, MemberSource, ReferenceGroup, ReferenceGroups, new_id,
};
use super::state::{self, DeskFile};
use crate::desktop::{CaptureHistory, GroupMemberRef, PinStore};

/// 迁移出的参考组的身份。
pub(super) const MIGRATED_ID: &str = "desk-from-pins";

pub(super) fn migrate(
    dir: &Path,
    groups: &ReferenceGroups,
    history: &mut CaptureHistory,
    state_path: &Path,
) -> Result<DeskFile, GroupError> {
    // pins.json 读不懂时 PinStore 从空开始：没有钉图可迁。
    let store = PinStore::open(dir)?;
    let now = crate::library::now_ms();
    let mut group = ReferenceGroup {
        id: MIGRATED_ID.to_owned(),
        name: String::new(),
        created_at: now,
        updated_at: now,
        members: Vec::new(),
        imported_from_package: None,
        restored_from: None,
    };
    let mut captures: CaptureFiles = Vec::new();
    // 截图钉图的截图与迁移出的成员：写好参考组后记进截图历史，之后复用同一条截图、收藏能改连。
    let mut links: Vec<(String, String)> = Vec::new();
    for pin in store.pins() {
        // 钉图原来记着的成员（指向旧参考组）丢弃，旧参考组不受影响。
        let member_id = new_id();
        let mut member = match pin.capture_id() {
            None => match GroupMember::from_pin(member_id, pin) {
                Some(m) => m,
                None => continue,
            },
            // 截图已不在截图历史中的钉图去掉（同 `PinStore::restore`）。
            Some(capture_id) => {
                let Some(capture) = history.group_capture(capture_id) else {
                    continue;
                };
                let Ok(bytes) = fs::read(&capture.file) else {
                    continue;
                };
                let member = GroupMember::from_capture_pin(member_id, pin, &capture);
                if let MemberSource::Capture { capture_file } = &member.source {
                    captures.push((capture_file.clone(), bytes));
                }
                links.push((capture_id.to_owned(), member.id.clone()));
                member
            }
        };
        member.follow(pin);
        group.members.push(member);
    }
    let on_desk = if group.members.is_empty() {
        None
    } else {
        // 上次迁到一半留下的同一个参考组：整个换掉。
        match groups.delete(MIGRATED_ID) {
            Ok(()) | Err(GroupError::UnknownGroup) => {}
            Err(e) => return Err(e),
        }
        super::publish(groups, &group, &captures)?;
        for (capture_id, member_id) in links {
            let at = GroupMemberRef {
                group_id: group.id.clone(),
                member_id,
            };
            let _ = history.link_member(&capture_id, at);
        }
        Some(group.id.clone())
    };
    let file = DeskFile::new(on_desk.clone(), on_desk.into_iter().collect());
    state::save(state_path, &file)?;
    Ok(file)
}
