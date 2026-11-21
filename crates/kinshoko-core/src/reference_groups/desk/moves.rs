//! 在参考组之间挪成员（#588、#590）：加进上一组、按添加日期移到新参考组（及其撤销）、
//! 移出没钉着的（及其撤销）。只写涉及的参考组（不变量 4）。

use std::collections::BTreeSet;
use std::ops::Range;

use super::{Desk, Held, Switched, blank};
use crate::desktop::{CaptureHistory, GroupMemberRef, SavedPin};
use crate::reference_groups::member::valid_capture_file;
use crate::reference_groups::{
    CaptureFiles, GroupError, GroupMember, MemberSource, ReferenceGroup, new_id,
};

/// 移到新参考组后（[`Desk::split_off`]）：新参考组，以及桌面上随之关掉的钉图。
/// 撤销用 [`Desk::undo_split`]。
#[derive(Debug, Clone, PartialEq)]
pub struct Split {
    /// 拆出的成员原来所在的参考组（桌面上那个）。
    pub from: String,
    /// 新参考组。
    pub to: String,
    pub closed: Vec<SavedPin>,
}

/// 移出没钉着的成员后（[`Desk::prune_unpinned`]）：撤销要用的全部，包括它们自带截图的字节。
#[derive(Debug, Clone, PartialEq)]
pub struct Pruned {
    /// 移出前的参考组：撤销时它已不在（空的且没有名称的会随之消失），按它重建。
    before: ReferenceGroup,
    /// 移出的成员与它们原来的位置。
    members: Vec<(usize, GroupMember)>,
    captures: CaptureFiles,
}

impl Pruned {
    pub fn group_id(&self) -> &str {
        &self.before.id
    }

    pub fn count(&self) -> usize {
        self.members.len()
    }
}

impl Desk {
    /// 加进上一组（空桌钉下第一张后的提示，#588 决定 4）：桌面上的参考组 `source_id`（提示所说的那个新参考组）
    /// 的成员连同自带截图移进 `target_id`，删掉 `source_id`，把 `target_id` 摆上桌面（返回这次换桌）。
    /// 桌面上已不是 `source_id`（提示出来之后换过桌）或 `target_id` 就是它时什么都不做。
    pub fn fold_into_previous(
        &mut self,
        source_id: &str,
        target_id: &str,
        history: &mut CaptureHistory,
    ) -> Result<Switched, GroupError> {
        let Some(source) = self
            .desk_id()
            .filter(|id| id == source_id && id != target_id)
        else {
            return Ok(Switched::none());
        };
        self.fold(&source, target_id, history)
    }

    /// 移到新参考组（#588“按天分段”）：桌面上参考组里添加时间落在 `added`（毫秒，左闭右开；应用壳按
    /// 本地日期算出一天的范围）的成员连同自带截图移到一个新参考组（没有名称）。桌面上的参考组不换，
    /// 移走的钉图随之关掉；新参考组里它们仍是钉着的，切换过去就回来。
    /// 桌面空着、这一段为空或就是全部成员时什么都不做（`None`）。
    pub fn split_off(
        &mut self,
        added: Range<i64>,
        history: &mut CaptureHistory,
    ) -> Result<Option<Split>, GroupError> {
        self.flush()?;
        let Some(held) = &self.on_desk else {
            return Ok(None);
        };
        let from = held.group.clone();
        let (moving, staying): (Vec<GroupMember>, Vec<GroupMember>) = from
            .members
            .iter()
            .cloned()
            .partition(|m| added.contains(&from.added_at(m)));
        if moving.is_empty() || staying.is_empty() {
            return Ok(None);
        }
        let mut created = blank();
        let dir = self.groups.captures_dir(&from.id)?;
        let mut copies = Vec::new();
        for m in &moving {
            let mut m = m.clone();
            m.added_at = Some(from.added_at(&m));
            if let MemberSource::Capture { capture_file } = &m.source {
                copies.push((capture_file.clone(), dir.join(capture_file)));
            }
            created.members.push(m);
        }
        // 先写新参考组：之后失败时成员两边都有，不会丢。
        self.groups.commit(&created, &copies)?;
        let moved: BTreeSet<String> = moving.iter().map(|m| m.id.clone()).collect();
        let (closed, kept): (Vec<SavedPin>, Vec<SavedPin>) =
            std::mem::take(&mut self.pins).into_iter().partition(|p| {
                p.member
                    .as_ref()
                    .is_some_and(|m| moved.contains(&m.member_id))
            });
        self.pins = kept;
        if let Some(held) = self.on_desk.as_mut() {
            held.group.members = staying;
        }
        self.used_at
            .insert(created.id.clone(), crate::library::now_ms());
        self.dirty = true;
        // 落盘到一半（参考组写进了、桌面状态没写进）时移走的截图已从原来的参考组清掉：先留着字节。
        let moved_captures = self.groups.read_captures(&from.id, &moving);
        if let Err(e) = self.flush() {
            // 桌面上那个写不进：像没拆过一样，截图放回原来的参考组，删掉新参考组，成员与钉图都放回。
            self.groups.put_captures(&from.id, &moved_captures);
            let _ = self.groups.delete(&created.id);
            self.used_at.remove(&created.id);
            if let Some(held) = self.on_desk.as_mut() {
                held.group.members = from.members.clone();
            }
            self.pins.extend(closed);
            return Err(e);
        }
        relink(history, &from.id, &created.id, &moved);
        for capture in closed.iter().filter_map(SavedPin::capture_id) {
            history.unpin(capture);
        }
        Ok(Some(Split {
            from: from.id,
            to: created.id,
            closed,
        }))
    }

    /// 撤销移到新参考组：新参考组的成员（包括之后加进去的）连同截图移回原来的参考组，删掉新参考组。
    /// 原来的参考组在桌面上时，移回的钉着的成员钉出来；新参考组在桌面上时换成原来的参考组。
    pub fn undo_split(
        &mut self,
        split: &Split,
        history: &mut CaptureHistory,
    ) -> Result<Switched, GroupError> {
        self.fold(&split.to, &split.from, history)
    }

    /// 移出没钉着的（画完想清理，#588 决定 3）：桌面上参考组里没钉着的成员全部移出，自带截图随之删除。
    /// 返回撤销要用的（[`Self::undo_prune`]）；桌面空着或没有没钉着的成员时为 `None`。
    pub fn prune_unpinned(&mut self) -> Result<Option<Pruned>, GroupError> {
        self.flush()?;
        let Some(held) = &self.on_desk else {
            return Ok(None);
        };
        let before = held.group.clone();
        let members: Vec<(usize, GroupMember)> = before
            .members
            .iter()
            .enumerate()
            .filter(|(_, m)| !m.pinned)
            .map(|(at, m)| (at, m.clone()))
            .collect();
        if members.is_empty() {
            return Ok(None);
        }
        let removed: Vec<GroupMember> = members.iter().map(|(_, m)| m.clone()).collect();
        let captures = self.groups.read_captures(&before.id, &removed);
        if let Some(held) = self.on_desk.as_mut() {
            held.group.members.retain(|m| m.pinned);
        }
        self.dirty = true;
        if let Err(e) = self.flush() {
            // 参考组写进了、桌面状态没写进时，移出的截图已清掉：连字节一起放回。
            self.groups.put_captures(&before.id, &captures);
            if let Some(held) = self.on_desk.as_mut() {
                held.group.members = before.members.clone();
            }
            return Err(e);
        }
        Ok(Some(Pruned {
            before,
            members,
            captures,
        }))
    }

    /// 撤销移出没钉着的：成员按原来的位置放回（仍是没钉着），自带截图写回。参考组已随之消失时按原样重建。
    pub fn undo_prune(&mut self, pruned: &Pruned) -> Result<(), GroupError> {
        self.flush()?;
        let id = pruned.group_id();
        let on_desk = self.desk_id().as_deref() == Some(id);
        let mut group = if on_desk {
            self.on_desk
                .as_ref()
                .map(|h| h.group.clone())
                .ok_or(GroupError::UnknownGroup)?
        } else {
            match self.groups.get(id) {
                Ok(group) => group,
                Err(GroupError::UnknownGroup) => ReferenceGroup {
                    members: Vec::new(),
                    ..pruned.before.clone()
                },
                Err(e) => return Err(e),
            }
        };
        for (at, m) in &pruned.members {
            if group.members.iter().any(|x| x.id == m.id) {
                continue;
            }
            let at = (*at).min(group.members.len());
            group.members.insert(at, m.clone());
        }
        group.updated_at = crate::library::now_ms();
        self.groups.commit_restoring(&group, &pruned.captures)?;
        if on_desk && let Some(held) = self.on_desk.as_mut() {
            held.group = group;
        }
        Ok(())
    }

    /// 参考组 `source_id` 的成员全部移进 `target_id`（连同自带截图与截图历史的关联），再删掉 `source_id`。
    /// 先写目标：之后失败时成员两边都有，不会丢。`source_id` 在桌面上时把目标摆上桌面；目标在桌面上时
    /// 钉出移来的钉着的成员。
    fn fold(
        &mut self,
        source_id: &str,
        target_id: &str,
        history: &mut CaptureHistory,
    ) -> Result<Switched, GroupError> {
        if source_id == target_id {
            return Ok(Switched::none());
        }
        self.flush()?;
        let desk = self.desk_id();
        let held = |id: &str| -> Result<ReferenceGroup, GroupError> {
            match (&self.on_desk, desk.as_deref()) {
                (Some(h), Some(d)) if d == id => Ok(h.group.clone()),
                _ => self.groups.get(id),
            }
        };
        let source = held(source_id)?;
        let mut target = held(target_id)?;
        let dir = self.groups.captures_dir(source_id)?;
        let mut copies = Vec::new();
        let mut moved = BTreeSet::new();
        let mut renamed = Vec::new();
        for m in &source.members {
            let mut m = m.clone();
            m.added_at = Some(source.added_at(&m));
            let old = m.id.clone();
            // 截图文件名由成员身份拼出：身份重复或拼不出合法的文件名（导入的参考组包里的身份不可信）时换一个。
            if target.members.iter().any(|x| x.id == m.id)
                || (matches!(m.source, MemberSource::Capture { .. })
                    && !valid_capture_file(&format!("{}.png", m.id)))
            {
                m.id = new_id();
            }
            if let MemberSource::Capture { capture_file } = &mut m.source {
                let original = dir.join(&*capture_file);
                *capture_file = format!("{}.png", m.id);
                copies.push((capture_file.clone(), original));
            }
            renamed.push((old, m.id.clone()));
            moved.insert(m.id.clone());
            target.members.push(m);
        }
        target.updated_at = crate::library::now_ms();
        self.groups.commit(&target, &copies)?;
        // 删掉 `source_id` 会连它的截图目录一起删：之后换桌失败、放回它时要用。
        let source_captures = if desk.as_deref() == Some(source_id) {
            self.groups.read_captures(source_id, &source.members)
        } else {
            Vec::new()
        };
        for (old, new) in &renamed {
            let from = GroupMemberRef {
                group_id: source_id.to_owned(),
                member_id: old.clone(),
            };
            if let Some(entry) = history.linked_entry(&from) {
                let at = GroupMemberRef {
                    group_id: target_id.to_owned(),
                    member_id: new.clone(),
                };
                let _ = history.link_member(&entry, at);
            }
        }
        match self.groups.delete(source_id) {
            Ok(()) | Err(GroupError::UnknownGroup) => {}
            Err(e) => return Err(e),
        }
        self.forget(source_id);
        if desk.as_deref() == Some(source_id) {
            // 桌面上那个已删掉：换桌时不再记它用过的时间。
            let source = self.on_desk.take();
            return match self.replace(Some(target), history) {
                Ok(switched) => Ok(switched),
                Err(e) => {
                    // 桌面状态写不进：桌面还是它（下次落盘时文件写回来，成员两边都有，不丢）。
                    if let Some(mut held) = source {
                        self.groups.put_captures(source_id, &source_captures);
                        self.used_at
                            .insert(held.group.id.clone(), crate::library::now_ms());
                        held.copies.clear();
                        self.on_desk = Some(held);
                        self.dirty = true;
                    }
                    Err(e.into())
                }
            };
        }
        if desk.as_deref() == Some(target_id) {
            self.on_desk = Some(Held::saved(target));
            let opened = self.open_pinned(history, |m| moved.contains(m));
            self.pins.extend(opened.pins.iter().cloned());
            self.save_state()?;
            return Ok(Switched {
                closed: Vec::new(),
                opened,
            });
        }
        self.save_state()?;
        Ok(Switched::none())
    }
}

/// 移走的组内截图成员：截图历史改连到新参考组里的同一个成员，之后收藏仍能改连。
fn relink(history: &mut CaptureHistory, from: &str, to: &str, moved: &BTreeSet<String>) {
    for member in moved {
        let old = GroupMemberRef {
            group_id: from.to_owned(),
            member_id: member.clone(),
        };
        if let Some(entry) = history.linked_entry(&old) {
            let at = GroupMemberRef {
                group_id: to.to_owned(),
                member_id: member.clone(),
            };
            let _ = history.link_member(&entry, at);
        }
    }
}
