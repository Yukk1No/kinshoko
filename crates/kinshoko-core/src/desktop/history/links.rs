//! 截图历史条目与参考组自带截图成员的关联（#270）：截图只存在参考组里时，记下那个成员；从截图历史
//! 或钉图菜单收藏这张截图时，参考组据此把成员改为引用收藏成的参考图
//! （[`crate::reference_groups::ReferenceGroups::relink_collected`]）。
//! 关联存在索引里，条目被丢弃时一起消失；参考组那份截图不受影响。

use super::{CaptureHistory, HistoryError};
use crate::desktop::GroupMemberRef;

impl CaptureHistory {
    /// 记下截图 `id` 成了参考组成员 `member`。截图不在历史中或已记下时什么都不改。
    pub fn link_member(&mut self, id: &str, member: GroupMemberRef) -> Result<(), HistoryError> {
        let Some(stored) = self.entries.iter_mut().find(|s| s.id == id) else {
            return Ok(());
        };
        if stored.members.contains(&member) {
            return Ok(());
        }
        stored.members.push(member);
        self.save()?;
        Ok(())
    }

    /// 截图 `id` 关联的参考组成员；不在历史中时为空。只读，关联留着。
    pub fn linked_members(&self, id: &str) -> Vec<GroupMemberRef> {
        self.entries
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.members.clone())
            .unwrap_or_default()
    }

    /// 去掉截图 `id` 与 `done` 里成员的关联（改连已完成或关联已明确失效）。写不进索引时报错，
    /// 内存里也照旧留着，下次收藏再处理。
    pub fn unlink_members(
        &mut self,
        id: &str,
        done: &[GroupMemberRef],
    ) -> Result<(), HistoryError> {
        let Some(stored) = self.entries.iter_mut().find(|s| s.id == id) else {
            return Ok(());
        };
        if !stored.members.iter().any(|m| done.contains(m)) {
            return Ok(());
        }
        let before = stored.members.clone();
        stored.members.retain(|m| !done.contains(m));
        if let Err(e) = self.save() {
            if let Some(stored) = self.entries.iter_mut().find(|s| s.id == id) {
                stored.members = before;
            }
            return Err(e.into());
        }
        Ok(())
    }
}
