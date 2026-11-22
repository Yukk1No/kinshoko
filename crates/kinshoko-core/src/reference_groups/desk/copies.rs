//! 复制参考组（#588 决定 6），以及复制出的组内截图成员连回截图历史（并入也用）。

use super::Desk;
use crate::desktop::{CaptureHistory, GroupMemberRef};
use crate::reference_groups::{GroupError, GroupMember, ReferenceGroup, new_id};

impl Desk {
    /// 复制参考组 `id`（#588 决定 6：要保持原样先复制）：成员、摆放与自带截图都照搬到一个叫 `name`
    /// 的新参考组，新参考组不在桌面上、不是常用。组内截图成员连到原成员连着的截图历史，之后收藏那张截图
    /// 时副本也改连到参考图。返回新参考组。
    pub fn duplicate(
        &mut self,
        id: &str,
        name: &str,
        history: &mut CaptureHistory,
    ) -> Result<ReferenceGroup, GroupError> {
        self.flush()?;
        let source = match &self.on_desk {
            Some(held) if held.group.id == id => held.group.clone(),
            _ => self.groups.get(id)?,
        };
        let now = crate::library::now_ms();
        let copy = ReferenceGroup {
            id: new_id(),
            name: name.trim().to_owned(),
            created_at: now,
            updated_at: now,
            members: source
                .members
                .iter()
                .map(|m| GroupMember {
                    added_at: Some(source.added_at(m)),
                    ..m.clone()
                })
                .collect(),
            imported_from_package: None,
            restored_from: None,
        };
        let captures = self.groups.read_captures(id, &source.members);
        self.groups.publish_with_captures(&copy, &captures)?;
        let same = copy.members.iter().map(|m| (m.id.clone(), m.id.clone()));
        link_copies(history, id, &copy.id, same);
        Ok(copy)
    }
}

/// 复制出的组内截图成员（原成员身份 → 新成员身份）连到原成员连着的截图历史，收藏时一起改连。
pub(super) fn link_copies(
    history: &mut CaptureHistory,
    from: &str,
    to: &str,
    members: impl IntoIterator<Item = (String, String)>,
) {
    for (old, new) in members {
        let source = GroupMemberRef {
            group_id: from.to_owned(),
            member_id: old,
        };
        if let Some(entry) = history.linked_entry(&source) {
            let at = GroupMemberRef {
                group_id: to.to_owned(),
                member_id: new,
            };
            let _ = history.link_member(&entry, at);
        }
    }
}
