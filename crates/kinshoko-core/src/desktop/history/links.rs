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

    /// 取走截图 `id` 关联的全部参考组成员；不在历史中时为空。
    pub fn take_members(&mut self, id: &str) -> Vec<GroupMemberRef> {
        let Some(stored) = self.entries.iter_mut().find(|s| s.id == id) else {
            return Vec::new();
        };
        let members = std::mem::take(&mut stored.members);
        if !members.is_empty() {
            // 写不进索引只会让下次收藏再试一次改连，已改连的成员会被略过。
            let _ = self.save();
        }
        members
    }
}
