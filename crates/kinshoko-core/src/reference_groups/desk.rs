//! 桌面上的参考组（#588、#590）：桌面上始终摆着一个参考组，桌面钉图就是它的成员。
//!
//! [`Desk`] 是唯一知道“桌面上是哪个参考组”和同步规则的地方。应用壳只提交事件（钉了、改了、
//! 关了、切换、新建、归档、取出、删除、收藏），不自己拼先后：
//!
//! 1. 任何时刻桌面上恰好有一个参考组，可以是空的；空的且没有名称时不落盘（一张空桌）。
//! 2. 桌面上的钉图与这个参考组的成员一一对应：钉上一张多一个成员，关掉一张少一个成员，
//!    改动局部、摆放、透明度、锁定就更新那个成员。读不出来的成员（例如组内截图文件缺失）钉不出来，
//!    留在参考组里不动，不因为同步被丢掉；资料库不可用的成员照常钉出（显示占位）。
//! 3. 组内截图文件有成员在用才存在（落盘时 [`ReferenceGroups::commit`] 复制进来、清掉不用的）。
//! 4. 只写桌面上的那个参考组：归档的参考组文件不会被桌面上的动作改写。
//!
//! 改动先记在内存里，[`Desk::flush`] 才落盘（应用壳在有改动时由后台线程调用，退出时必须调用）。
//! 切换、新建、归档、删除之前都先落盘，崩溃后最多丢最近一次还没落盘的摆放。
//!
//! 截图历史的钉住计数也由这里管：钉上、关掉、切换时成对地 `pin` / `unpin`。
//! 不是线程安全的；应用壳把它放在锁里，持锁时不调用窗口 API。

mod migrate;
mod state;

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::{
    CaptureFiles, GroupError, GroupMember, GroupSummary, MemberSource, OpenedPins, ReferenceGroup,
    ReferenceGroups, RelinkReport, new_id,
};
use crate::CommandError;
use crate::command_error::ErrorKind;
use crate::desktop::{
    CaptureHistory, CollectedCapture, GroupMemberRef, PinContent, SavedPin, ScreenRect,
    pull_onto_screen,
};
use state::{DeskFile, Loaded};

/// 切换列表与归档的摘要（[`Desk::lists`]）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeskLists {
    /// 桌面上的参考组（落了盘的话）；空桌为 `None`。
    pub on_desk: Option<String>,
    /// 切换列表，最近用过的在前。
    pub switch_list: Vec<GroupSummary>,
    /// 归档，最近保存的在前；读不懂的文件也列出并写明原因。
    pub archived: Vec<GroupSummary>,
}

/// 换了一桌（切换、新建、归档或删除桌面上那个）：先关掉 `closed`，再钉出 `opened`。
#[derive(Debug, Clone, PartialEq)]
pub struct Switched {
    pub closed: Vec<SavedPin>,
    pub opened: OpenedPins,
}

/// 并入一个参考组之后（[`Desk::merge_in`]）：钉出的钉图，以及撤销要用的记录。
#[derive(Debug, Clone, PartialEq)]
pub struct MergedIn {
    pub undo: MergeUndo,
    pub opened: OpenedPins,
}

/// 撤销一次并入（[`Desk::undo_merge`]）要用的：并入到的参考组与这次加进去的成员。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MergeUndo {
    pub group_id: String,
    pub members: Vec<String>,
}

/// 收藏截图后（[`Desk::collected`]）：参考组成员的改连结果，以及桌面上改为显示参考图的钉图。
#[derive(Debug, Clone, PartialEq)]
pub struct Collected {
    pub report: RelinkReport,
    pub converted: Vec<SavedPin>,
}

/// 桌面上的参考组。见模块说明。
pub struct Desk {
    groups: ReferenceGroups,
    state_path: PathBuf,
    /// 桌面上的参考组，以内存里的为准。
    group: ReferenceGroup,
    /// 桌面钉图；每张的 `member` 指向 `group` 的一个成员。
    pins: Vec<SavedPin>,
    /// 切换列表，最近用过的在前。
    switch_list: Vec<String>,
    /// 还没复制进参考组的组内截图：文件名与截图历史中的文件。
    copies: Vec<(String, PathBuf)>,
    /// 删除时摆在桌面上的参考组：撤销后放回桌面。
    trashed_from_desk: BTreeSet<String>,
    /// 撤销删除时文件已放回、还没写进桌面状态的参考组：再撤销一次时接着做完。
    untrashed: BTreeSet<String>,
    dirty: bool,
    /// 自上次落盘以来成员有增减：参考组列表上看得出（张数、缩略图）。
    members_changed: bool,
}

impl Desk {
    /// 打开 `dir`（应用数据目录，与 `pins.json` 同级）下的桌面状态。还没有时迁移：现有参考组都算归档，
    /// 文件一个字节都不改；`pins.json` 里的钉图成为一个没有名称的参考组，摆在桌面上。
    /// 钉图要等 [`Self::restore`] 才钉出。
    pub fn open(
        dir: &Path,
        groups: ReferenceGroups,
        history: &mut CaptureHistory,
    ) -> Result<Desk, GroupError> {
        let state_path = state::path(dir);
        let file = match state::load(&state_path)? {
            Loaded::Found(file) => file,
            Loaded::Missing => migrate::migrate(dir, &groups, history, &state_path)?,
        };
        let group = match &file.on_desk {
            Some(id) => groups.get(id).ok(),
            None => None,
        };
        let mut desk = Desk {
            group: group.unwrap_or_else(blank),
            groups,
            state_path,
            pins: Vec::new(),
            switch_list: file.switch_list,
            copies: Vec::new(),
            trashed_from_desk: BTreeSet::new(),
            untrashed: BTreeSet::new(),
            dirty: false,
            members_changed: false,
        };
        // 切换列表里的参考组文件不在了（例如被别的程序删掉）：不再列出。
        let groups = &desk.groups;
        desk.switch_list.retain(|id| groups.get(id).is_ok());
        Ok(desk)
    }

    /// 启动时钉出桌面上的参考组：与 [`Self::switch_to`] 得到的一样，再把离开了所有显示器的拉回屏幕。
    pub fn restore(&mut self, history: &mut CaptureHistory, monitors: &[ScreenRect]) -> OpenedPins {
        let mut opened = self.open_pins(history);
        for pin in &mut opened.pins {
            let (x, y) = pull_onto_screen(pin.rect(), monitors);
            if (x, y) != (pin.placement.x, pin.placement.y) {
                pin.placement.x = x;
                pin.placement.y = y;
                self.dirty = true;
            }
        }
        self.pins = opened.pins.clone();
        self.sync_all();
        opened
    }

    /// 桌面上的参考组。
    pub fn group(&self) -> &ReferenceGroup {
        &self.group
    }

    pub fn pins(&self) -> &[SavedPin] {
        &self.pins
    }

    pub fn get(&self, pin_id: &str) -> Option<&SavedPin> {
        self.pins.iter().find(|p| p.id == pin_id)
    }

    /// 有还没落盘的改动。
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// 钉上一张新钉图：它成为桌面上参考组的新成员，返回记着这个成员的钉图。截图钉图的截图成为
    /// 参考组自带的截图（落盘时复制进来），截图历史记下钉住与关联，之后收藏能改连。
    /// 截图已不在截图历史中时报错，什么都不改。
    pub fn pin(
        &mut self,
        mut pin: SavedPin,
        history: &mut CaptureHistory,
    ) -> Result<SavedPin, GroupError> {
        let member_id = new_id();
        let mut member = match pin.capture_id() {
            None => GroupMember::from_pin(member_id.clone(), &pin).ok_or(GroupError::NoMembers)?,
            Some(capture_id) => {
                let capture = history.group_capture(capture_id).ok_or_else(|| {
                    GroupError::Invalid(Box::new(CommandError::new(
                        ErrorKind::MemberCaptureMissing,
                        "截图已不在截图历史中",
                    )))
                })?;
                let member = GroupMember::from_capture_pin(member_id.clone(), &pin, &capture);
                if let MemberSource::Capture { capture_file } = &member.source {
                    self.copies.push((capture_file.clone(), capture.file));
                }
                member
            }
        };
        member.follow(&pin);
        let at = GroupMemberRef {
            group_id: self.group.id.clone(),
            member_id,
        };
        if let Some(capture_id) = pin.capture_id() {
            history.pin(capture_id);
            let _ = history.link_member(capture_id, at.clone());
        }
        pin.member = Some(at);
        self.group.members.push(member);
        self.pins.push(pin.clone());
        self.dirty = true;
        self.members_changed = true;
        Ok(pin)
    }

    /// 改一张钉图（拖动、缩放、翻转、旋转、透明度、锁定）：成员跟着改。不存在时为 `None`。
    pub fn edit<T>(&mut self, pin_id: &str, edit: impl FnOnce(&mut SavedPin) -> T) -> Option<T> {
        let pin = self.pins.iter_mut().find(|p| p.id == pin_id)?;
        let out = edit(pin);
        let pin = pin.clone();
        self.sync(&pin);
        self.dirty = true;
        Some(out)
    }

    /// 画师关掉了一张钉图：成员随之移出（组内截图文件落盘时删除）。最后一个成员移出后，
    /// 没有名称的参考组连文件一起消失，有名称的留着、是空的。
    pub fn close(&mut self, pin_id: &str, history: &mut CaptureHistory) -> Option<SavedPin> {
        let at = self.pins.iter().position(|p| p.id == pin_id)?;
        let pin = self.pins.remove(at);
        if let Some(member) = &pin.member {
            self.group.members.retain(|m| m.id != member.member_id);
            let file = format!("{}.png", member.member_id);
            self.copies.retain(|(f, _)| *f != file);
        }
        if let Some(capture) = pin.capture_id() {
            history.unpin(capture);
        }
        self.dirty = true;
        self.members_changed = true;
        Some(pin)
    }

    /// 从参考组 `id` 移出成员 `member_id`（面板“查看成员”的“移出”）。是桌面上的参考组时由这里做：
    /// 钉着它的钉图随之关掉，落盘后返回参考组；不是时返回 `None`，交给 [`ReferenceGroups::remove_member`]
    /// 改文件（桌面上的参考组以内存里的为准，直接改文件会被下次落盘盖掉）。
    pub fn remove_member(
        &mut self,
        id: &str,
        member_id: &str,
        history: &mut CaptureHistory,
    ) -> Result<Option<ReferenceGroup>, GroupError> {
        if id != self.group.id {
            return Ok(None);
        }
        let pin = self
            .pins
            .iter()
            .find(|p| p.member.as_ref().is_some_and(|m| m.member_id == member_id))
            .map(|p| p.id.clone());
        // 备份不了组内截图时不动：移出后落盘失败就找不回它了。
        let before = self.snapshot(&[member_id.to_owned()])?;
        match pin {
            Some(pin) => {
                self.close(&pin, history);
            }
            None => {
                // 钉不出来的成员没有钉图。
                self.group.members.retain(|m| m.id != member_id);
                self.dirty = true;
                self.members_changed = true;
            }
        }
        if let Err(e) = self.flush() {
            // 写不进：成员和钉图都留着，像没移出过一样（钉图窗口本来就没关）。
            self.roll_back(before, history);
            return Err(e);
        }
        before.discard();
        Ok(Some(self.group.clone()))
    }

    /// 改名。名称可以为空（回到“未命名”）。
    pub fn rename(&mut self, id: &str, name: &str) -> Result<ReferenceGroup, GroupError> {
        if id != self.group.id {
            let mut group = self.groups.get(id)?;
            group.name = name.trim().to_owned();
            group.updated_at = crate::library::now_ms();
            self.groups.commit(&group, &[])?;
            return Ok(group);
        }
        self.group.name = name.trim().to_owned();
        self.dirty = true;
        self.flush()?;
        Ok(self.group.clone())
    }

    /// 并入参考组 `source_id`（#595）：把它的全部成员复制到桌面上的参考组，按原来的局部与摆放钉出，
    /// 落在所有显示器外的拉回屏幕。自带截图复制一份，两边各有各的；来源参考组不变。
    /// 先落盘再钉出（组内截图要先复制进来才能钉）。来源就是桌面上那个时什么都不做。
    pub fn merge_in(
        &mut self,
        source_id: &str,
        history: &mut CaptureHistory,
        monitors: &[ScreenRect],
    ) -> Result<MergedIn, GroupError> {
        let mut merged = MergedIn {
            undo: MergeUndo {
                group_id: self.group.id.clone(),
                members: Vec::new(),
            },
            opened: OpenedPins {
                pins: Vec::new(),
                problems: Vec::new(),
            },
        };
        if source_id == self.group.id {
            return Ok(merged);
        }
        let source = self.groups.get(source_id)?;
        let from = self.groups.captures_dir(source_id)?;
        // 截图成员：来源成员与它的副本，写好后让副本关联同一条截图历史（ADR-0002 收藏改连）。
        let mut captured: Vec<(String, String)> = Vec::new();
        for m in &source.members {
            let mut member = m.clone();
            member.id = new_id();
            if let MemberSource::Capture { capture_file } = &mut member.source {
                captured.push((m.id.clone(), member.id.clone()));
                let original = from.join(&*capture_file);
                *capture_file = format!("{}.png", member.id);
                // 来源里缺了的截图不复制：成员照样并入，钉不出来时写明原因，与切换过去时一样。
                if original.is_file() {
                    self.copies.push((capture_file.clone(), original));
                }
            }
            merged.undo.members.push(member.id.clone());
            self.group.members.push(member);
        }
        if merged.undo.members.is_empty() {
            return Ok(merged);
        }
        self.dirty = true;
        self.members_changed = true;
        if let Err(e) = self.flush() {
            // 写不进：这次并入整个不算，桌面上的参考组回到并入前。
            self.group
                .members
                .retain(|m| !merged.undo.members.contains(&m.id));
            let files: Vec<String> = merged
                .undo
                .members
                .iter()
                .map(|id| format!("{id}.png"))
                .collect();
            self.copies.retain(|(f, _)| !files.contains(f));
            return Err(e);
        }
        for (from_member, to_member) in captured {
            let source_ref = GroupMemberRef {
                group_id: source_id.to_owned(),
                member_id: from_member,
            };
            if let Some(entry) = history.linked_entry(&source_ref) {
                let at = GroupMemberRef {
                    group_id: self.group.id.clone(),
                    member_id: to_member,
                };
                let _ = history.link_member(&entry, at);
            }
        }
        let added: BTreeSet<&str> = merged.undo.members.iter().map(String::as_str).collect();
        let mut opened = self.groups.open_members(
            &self.group,
            history,
            |m| !added.contains(m.member_id.as_str()),
            true,
        );
        for pin in &mut opened.pins {
            let (x, y) = pull_onto_screen(pin.rect(), monitors);
            if (x, y) != (pin.placement.x, pin.placement.y) {
                pin.placement.x = x;
                pin.placement.y = y;
                self.dirty = true;
            }
        }
        self.pins.extend(opened.pins.iter().cloned());
        for pin in opened.pins.clone() {
            self.sync(&pin);
        }
        merged.undo.group_id = self.group.id.clone();
        merged.opened = opened;
        Ok(merged)
    }

    /// 撤销并入：去掉那次并入的成员（桌面上的钉图随之关掉），复制来的截图文件随之删除。
    /// 之后已经换了一桌的，改的是那个参考组的文件；其中的成员已经不在的略过。
    pub fn undo_merge(
        &mut self,
        undo: &MergeUndo,
        history: &mut CaptureHistory,
    ) -> Result<(), GroupError> {
        let (merged_group, members) = (undo.group_id.as_str(), &undo.members);
        if merged_group == self.group.id {
            let snapshot = self.snapshot(members);
            let pins: Vec<String> = self
                .pins
                .iter()
                .filter(|p| {
                    p.member
                        .as_ref()
                        .is_some_and(|m| members.contains(&m.member_id))
                })
                .map(|p| p.id.clone())
                .collect();
            for pin in pins {
                self.close(&pin, history);
            }
            // 钉不出来的成员没有钉图，也要去掉。
            let before = self.group.members.len();
            self.group.members.retain(|m| !members.contains(&m.id));
            if self.group.members.len() != before {
                self.dirty = true;
                self.members_changed = true;
            }
            if let Err(e) = self.flush() {
                // 写不进：并入的钉图还在（窗口本来就没关），像没撤销过一样，可以再撤销一次。
                self.roll_back(snapshot, history);
                return Err(e);
            }
            snapshot.discard();
            return Ok(());
        }
        let mut group = match self.groups.get(merged_group) {
            Ok(group) => group,
            Err(GroupError::UnknownGroup) => return Ok(()),
            Err(e) => return Err(e),
        };
        group.members.retain(|m| !members.contains(&m.id));
        if is_blank(&group) {
            // 并入的是一张空桌、之后又切走了：撤销后同落盘时一样，没有名称的空参考组连文件一起消失。
            match self.groups.delete(&group.id) {
                Ok(()) | Err(GroupError::UnknownGroup) => {}
                Err(e) => return Err(e),
            }
            self.switch_list.retain(|x| *x != group.id);
            self.save_state()?;
            return Ok(());
        }
        group.updated_at = crate::library::now_ms();
        self.groups.commit(&group, &[])
    }

    /// 把钉图 `pin_id` 移到参考组 `target_id`（#595）：它成为那个参考组的成员，摆放不变；
    /// 自带截图的文件跟着移过去。桌面上不再显示它（返回关掉的钉图）。
    /// 目标就是桌面上那个、或桌面上没有这张钉图时什么都不做（`None`）。
    pub fn move_pin(
        &mut self,
        pin_id: &str,
        target_id: &str,
        history: &mut CaptureHistory,
    ) -> Result<Option<SavedPin>, GroupError> {
        if target_id == self.group.id {
            return Ok(None);
        }
        let Some(member_id) = self
            .pins
            .iter()
            .find(|p| p.id == pin_id)
            .and_then(|p| p.member.as_ref())
            .map(|m| m.member_id.clone())
        else {
            return Ok(None);
        };
        let mut target = self.groups.get(target_id)?;
        // 先落盘：刚钉上的截图还没复制进桌面上的参考组。
        self.flush()?;
        let Some(mut member) = self
            .group
            .members
            .iter()
            .find(|m| m.id == member_id)
            .cloned()
        else {
            return Ok(None);
        };
        let mut copies = Vec::new();
        member.id = new_id();
        if let MemberSource::Capture { capture_file } = &mut member.source {
            let original = self
                .groups
                .captures_dir(&self.group.id)?
                .join(&*capture_file);
            *capture_file = format!("{}.png", member.id);
            copies.push((capture_file.clone(), original));
        }
        let moved = GroupMemberRef {
            group_id: target.id.clone(),
            member_id: member.id.clone(),
        };
        target.members.push(member);
        target.updated_at = crate::library::now_ms();
        self.groups.commit(&target, &copies)?;
        let snapshot = self.snapshot(std::slice::from_ref(&member_id));
        let closed = self.close(pin_id, history);
        if let Err(e) = self.flush() {
            // 桌面这边写不进：钉图留在桌面上，目标参考组里刚加的那个成员（连同截图）拿掉，像没移过一样。
            self.roll_back(snapshot, history);
            target.members.retain(|m| m.id != moved.member_id);
            target.updated_at = crate::library::now_ms();
            let _ = self.groups.commit(&target, &[]);
            return Err(e);
        }
        snapshot.discard();
        if let Some(capture) = closed.as_ref().and_then(SavedPin::capture_id) {
            // 之后从截图历史收藏这张截图，改连的是它在目标参考组里的成员。
            let _ = history.link_member(capture, moved);
        }
        Ok(closed)
    }

    /// 把改动落盘：先复制新的组内截图、写参考组文件，再写桌面状态。没有改动时什么都不做。
    /// 写不进时改动留在内存里，下次再试。
    ///
    /// 返回参考组列表上看不看得出这次落盘：成员有增减，或切换列表变了（空桌钉上第一张后出现在
    /// 切换列表里、最后一张关掉后消失）。只拖动、缩放时为 `false`，界面不必重读参考组列表。
    pub fn flush(&mut self) -> Result<bool, GroupError> {
        if !self.dirty {
            return Ok(false);
        }
        let listed = self.switch_list.clone();
        let mut copied = Vec::new();
        self.group.updated_at = crate::library::now_ms();
        if is_blank(&self.group) {
            match self.groups.delete(&self.group.id) {
                Ok(()) | Err(GroupError::UnknownGroup) => {}
                Err(e) => return Err(e),
            }
            let id = self.group.id.clone();
            self.switch_list.retain(|x| *x != id);
        } else {
            self.groups.commit(&self.group, &self.copies)?;
            copied = std::mem::take(&mut self.copies);
            // 第一次落盘时进切换列表；已经在里面的不挪位置，改钉图不算“用过”，切换顺序不变。
            let id = self.group.id.clone();
            if !self.switch_list.contains(&id) {
                self.switch_list.insert(0, id);
            }
        }
        self.save_state()?;
        // 撤回时放回的组内截图已复制进来、桌面状态也写好了：备份才删掉。之前删的话，外层的撤回
        // 还指着它。
        let rollback = self.state_path.with_extension("rollback");
        for (_, from) in copied {
            if from.starts_with(&rollback) {
                let _ = fs::remove_file(from);
            }
        }
        self.dirty = false;
        let seen = std::mem::take(&mut self.members_changed) || listed != self.switch_list;
        Ok(seen)
    }

    /// 切换到参考组 `id`：先把桌面上的参考组落盘，再整桌换过去。原来那一桌原样留着。
    /// `id` 读不出来时报错，桌面不变。已经在桌面上时什么都不换。
    pub fn switch_to(
        &mut self,
        id: &str,
        history: &mut CaptureHistory,
    ) -> Result<Switched, GroupError> {
        if id == self.group.id && !is_blank(&self.group) {
            return Ok(Switched {
                closed: Vec::new(),
                opened: OpenedPins {
                    pins: Vec::new(),
                    problems: Vec::new(),
                },
            });
        }
        self.flush()?;
        let target = self.groups.get(id)?;
        let before = self.switch_list.clone();
        self.move_to_front(id);
        match self.replace(target, history) {
            Ok(switched) => Ok(switched),
            Err(e) => {
                self.switch_list = before;
                Err(e.into())
            }
        }
    }

    /// 按切换列表的先后换到下一个（`forward`）或上一个参考组，到头后回到另一头（快捷键，#594）。
    /// 这样走不改切换列表的先后，连按能走完一圈。空桌时下一个是列表的第一个、上一个是最后一个。
    /// 列表里没有别的参考组时什么都不换（`None`）。
    pub fn step(
        &mut self,
        forward: bool,
        history: &mut CaptureHistory,
    ) -> Result<Option<Switched>, GroupError> {
        self.flush()?;
        let n = self.switch_list.len();
        let at = self.switch_list.iter().position(|x| *x == self.group.id);
        let next = match (at, forward) {
            (Some(_), _) if n < 2 => return Ok(None),
            (None, _) if n == 0 => return Ok(None),
            (Some(i), true) => (i + 1) % n,
            (Some(i), false) => (i + n - 1) % n,
            (None, true) => 0,
            (None, false) => n - 1,
        };
        let target = self.groups.get(&self.switch_list[next].clone())?;
        Ok(Some(self.replace(target, history)?))
    }

    /// 换到一张新的空桌。空桌不落盘、不用起名，钉上第一张后才出现在切换列表里。
    pub fn new_desk(&mut self, history: &mut CaptureHistory) -> Result<Switched, GroupError> {
        self.flush()?;
        Ok(self.replace(blank(), history)?)
    }

    /// 归档参考组 `id`：收出切换列表，文件不变。归档的正是桌面上那个时，桌面换到切换列表里
    /// 最近用过的另一个，没有就换到空桌（返回这次换桌）。
    pub fn archive(
        &mut self,
        id: &str,
        history: &mut CaptureHistory,
    ) -> Result<Option<Switched>, GroupError> {
        if id == self.group.id {
            self.flush()?;
            if is_blank(&self.group) {
                return Ok(None);
            }
            let before = self.switch_list.clone();
            self.switch_list.retain(|x| x != id);
            return match self.leave_desk(history) {
                Ok(switched) => Ok(Some(switched)),
                Err(e) => {
                    // 换不走：还摆在桌面上、还在切换列表里，像没归档过一样。
                    self.switch_list = before;
                    Err(e)
                }
            };
        }
        self.groups.get(id)?;
        let before = self.switch_list.clone();
        self.switch_list.retain(|x| x != id);
        if let Err(e) = self.save_state() {
            self.switch_list = before;
            return Err(e.into());
        }
        Ok(None)
    }

    /// 取出归档的参考组 `id`：放回切换列表并摆到桌面上。改的是原件，不是副本。
    pub fn unarchive(
        &mut self,
        id: &str,
        history: &mut CaptureHistory,
    ) -> Result<Switched, GroupError> {
        self.switch_to(id, history)
    }

    /// 删除参考组 `id`（#480 的做法，能撤销，见 [`Self::undo_discard`]）：文件与组内截图暂放到回收位置。
    /// 删除的正是桌面上那个时，桌面同 [`Self::archive`] 换走（返回这次换桌）。
    pub fn discard(
        &mut self,
        id: &str,
        history: &mut CaptureHistory,
    ) -> Result<Option<Switched>, GroupError> {
        let on_desk = id == self.group.id;
        if on_desk {
            self.flush()?;
        }
        self.groups.trash(id)?;
        let before = self.switch_list.clone();
        self.switch_list.retain(|x| x != id);
        if !on_desk {
            if let Err(e) = self.save_state() {
                // 写不进桌面状态：像没删过一样，文件放回原处、留在切换列表里。
                self.switch_list = before;
                self.groups.untrash(id)?;
                return Err(e.into());
            }
            return Ok(None);
        }
        // 参考组已在回收位置：换走时不能再把它写回去（落盘过，内存里没有没写的改动）。
        match self.leave_desk(history) {
            Ok(switched) => {
                self.trashed_from_desk.insert(id.to_owned());
                Ok(Some(switched))
            }
            Err(e) => {
                // 换不走：桌面还是它，把文件放回原处，像没删过一样。
                self.switch_list = before;
                self.groups.untrash(id)?;
                Err(e)
            }
        }
    }

    /// 撤销删除：参考组连同自带截图放回原处，补上删除期间的收藏改连，回到切换列表。删除时它摆在
    /// 桌面上的话，再摆回桌面（返回这次换桌）。
    pub fn undo_discard(
        &mut self,
        id: &str,
        history: &mut CaptureHistory,
    ) -> Result<(RelinkReport, Option<Switched>), GroupError> {
        let to_desk = self.trashed_from_desk.contains(id);
        let report = match self.groups.untrash_reconciling(id, history) {
            Ok(report) => report,
            // 上次撤销已把文件放回、桌面状态没写成就失败了：这次接着做完。
            Err(GroupError::UnknownGroup) if self.untrashed.contains(id) => RelinkReport::default(),
            Err(e) => return Err(e),
        };
        // 做完（换上桌面或写进切换列表）才算撤销完：失败时留着记录，可以再撤销一次。
        self.untrashed.insert(id.to_owned());
        if to_desk {
            let switched = self.switch_to(id, history)?;
            self.trashed_from_desk.remove(id);
            self.untrashed.remove(id);
            return Ok((report, Some(switched)));
        }
        self.move_to_front(id);
        self.save_state()?;
        self.untrashed.remove(id);
        Ok((report, None))
    }

    /// 撤销提示过期：真正删除回收位置里的参考组 `id`。
    pub fn purge(&mut self, id: &str) -> Result<(), GroupError> {
        self.trashed_from_desk.remove(id);
        self.untrashed.remove(id);
        self.groups.purge(id)
    }

    /// 截图历史条目 `capture_id` 收藏成了 `collected`：与它关联的组内截图成员（包括桌面上的）改为
    /// 引用那张参考图；桌面上显示它的钉图改为参考图钉图。
    pub fn collected(
        &mut self,
        history: &mut CaptureHistory,
        capture_id: &str,
        collected: &CollectedCapture,
    ) -> Result<Collected, GroupError> {
        // 先落盘：改连读写的是参考组文件。
        self.flush()?;
        let report = self.groups.relink_collected(history, capture_id, collected);
        let mine: Vec<&GroupMemberRef> = report
            .relinked
            .iter()
            .filter(|m| m.group_id == self.group.id)
            .collect();
        let mut converted = Vec::new();
        if !mine.is_empty() {
            self.group = self.groups.get(&self.group.id)?;
            for pin in &mut self.pins {
                let Some(member) = pin.member.as_ref().filter(|m| mine.contains(m)) else {
                    continue;
                };
                let Some(old) = pin.capture_id().map(str::to_owned) else {
                    continue;
                };
                let Some(m) = self.group.members.iter().find(|m| m.id == member.member_id) else {
                    continue;
                };
                pin.content = PinContent::Reference {
                    library_id: collected.library_id.clone(),
                    image_id: collected.image_id.clone(),
                    source_width: m.source_width,
                    source_height: m.source_height,
                };
                history.unpin(&old);
                converted.push(pin.clone());
            }
        }
        Ok(Collected { report, converted })
    }

    /// 切换列表（最近用过的在前）与归档（最近保存的在前）。桌面上的参考组按内存里的写。
    /// 还没落盘的也一样：钉上第一张后就在切换列表里，关掉最后一张后没有名称的就不再列出。
    pub fn lists(&self) -> Result<DeskLists, GroupError> {
        let mut all = self.groups.list()?;
        let blank = is_blank(&self.group);
        all.retain(|s| !(blank && s.id == self.group.id));
        if !blank {
            match all.iter_mut().find(|s| s.id == self.group.id) {
                Some(on_desk) => *on_desk = self.group.summary(),
                None => all.insert(0, self.group.summary()),
            }
        }
        let mut order = self.switch_list.clone();
        if !blank && !order.contains(&self.group.id) {
            order.insert(0, self.group.id.clone());
        }
        let mut switch_list = Vec::new();
        for id in &order {
            if let Some(at) = all.iter().position(|s| s.id == *id) {
                switch_list.push(all.remove(at));
            }
        }
        Ok(DeskLists {
            on_desk: (!is_blank(&self.group)).then(|| self.group.id.clone()),
            switch_list,
            archived: all,
        })
    }

    /// 桌面上的参考组换成 `next`：关掉现有钉图，钉出 `next` 的成员，写桌面状态。
    fn replace(
        &mut self,
        next: ReferenceGroup,
        history: &mut CaptureHistory,
    ) -> io::Result<Switched> {
        // 先写桌面状态：写不进时内存与钉图都还是原来那一桌，调用方拿到错误、什么都不用改。
        let on_desk = (!is_blank(&next)).then(|| next.id.clone());
        state::save(
            &self.state_path,
            &DeskFile::new(on_desk, self.switch_list.clone()),
        )?;
        let closed = std::mem::take(&mut self.pins);
        for capture in closed.iter().filter_map(SavedPin::capture_id) {
            history.unpin(capture);
        }
        self.group = next;
        self.copies.clear();
        self.dirty = false;
        let opened = self.open_pins(history);
        self.pins = opened.pins.clone();
        Ok(Switched { closed, opened })
    }

    /// 桌面上的参考组不再在切换列表里：换到最近用过的另一个，没有（或都读不出来）就换到空桌。
    fn leave_desk(&mut self, history: &mut CaptureHistory) -> Result<Switched, GroupError> {
        let next = self
            .switch_list
            .iter()
            .filter(|x| **x != self.group.id)
            .find_map(|x| self.groups.get(x).ok());
        let before = self.switch_list.clone();
        let next = match next {
            Some(group) => {
                self.move_to_front(&group.id.clone());
                group
            }
            None => blank(),
        };
        match self.replace(next, history) {
            Ok(switched) => Ok(switched),
            Err(e) => {
                self.switch_list = before;
                Err(e.into())
            }
        }
    }

    fn open_pins(&self, history: &mut CaptureHistory) -> OpenedPins {
        self.groups
            .open_members(&self.group, history, |_| false, true)
    }

    /// 成员跟着钉图。
    fn sync(&mut self, pin: &SavedPin) {
        let Some(member) = &pin.member else {
            return;
        };
        if let Some(m) = self
            .group
            .members
            .iter_mut()
            .find(|m| m.id == member.member_id)
        {
            m.follow(pin);
        }
    }

    fn sync_all(&mut self) {
        for pin in self.pins.clone() {
            self.sync(&pin);
        }
    }

    /// 移出成员之前记下桌面：落盘失败时用 [`Self::roll_back`] 回到这里。落盘会删掉移出成员的组内截图，
    /// 所以先把它们复制一份到桌面状态旁边；复制不了时报错，调用方什么都不改。
    fn snapshot(&self, removing: &[String]) -> Result<Snapshot, GroupError> {
        let mut backups = Vec::new();
        let dir = self.state_path.with_extension("rollback");
        if let Ok(from) = self.groups.captures_dir(&self.group.id) {
            for member in self
                .group
                .members
                .iter()
                .filter(|m| removing.contains(&m.id))
            {
                let MemberSource::Capture { capture_file } = &member.source else {
                    continue;
                };
                // 还没复制进来的截图本来就在截图历史里，留在 copies 中即可。
                let file = from.join(capture_file);
                let backup = dir.join(capture_file);
                if file.is_file() {
                    fs::create_dir_all(&dir)?;
                    fs::copy(&file, &backup)?;
                    backups.push((capture_file.clone(), backup));
                }
            }
        }
        Ok(Snapshot {
            group: self.group.clone(),
            pins: self.pins.clone(),
            copies: self.copies.clone(),
            switch_list: self.switch_list.clone(),
            members_changed: self.members_changed,
            backups,
        })
    }

    /// 回到 `before`：成员、钉图与截图历史的钉住次数都复原，删掉的组内截图下次落盘时从备份放回。
    fn roll_back(&mut self, before: Snapshot, history: &mut CaptureHistory) {
        let now: BTreeSet<&str> = self.pins.iter().map(|p| p.id.as_str()).collect();
        for pin in before.pins.iter().filter(|p| !now.contains(p.id.as_str())) {
            if let Some(capture) = pin.capture_id() {
                history.pin(capture);
            }
        }
        self.group = before.group;
        self.pins = before.pins;
        self.copies = before.copies;
        self.copies.extend(before.backups);
        self.switch_list = before.switch_list;
        // 文件可能已经改了一半：标成有改动，下次落盘按内存整个重写。
        self.dirty = true;
        self.members_changed = before.members_changed;
    }

    fn move_to_front(&mut self, id: &str) {
        self.switch_list.retain(|x| x != id);
        self.switch_list.insert(0, id.to_owned());
    }

    fn save_state(&self) -> io::Result<()> {
        let on_desk = (!is_blank(&self.group)).then(|| self.group.id.clone());
        state::save(
            &self.state_path,
            &DeskFile::new(on_desk, self.switch_list.clone()),
        )
    }
}

/// 移出成员前的桌面（[`Desk::snapshot`]）。
struct Snapshot {
    group: ReferenceGroup,
    pins: Vec<SavedPin>,
    copies: Vec<(String, PathBuf)>,
    switch_list: Vec<String>,
    members_changed: bool,
    /// 组内截图的备份：文件名与备份位置。
    backups: Vec<(String, PathBuf)>,
}

impl Snapshot {
    /// 落盘成功、用不着了：删掉备份。
    fn discard(self) {
        for (_, backup) in self.backups {
            let _ = fs::remove_file(backup);
        }
    }
}

/// 一张空桌：没有成员、没有名称，不落盘。
fn blank() -> ReferenceGroup {
    let now = crate::library::now_ms();
    ReferenceGroup {
        id: new_id(),
        name: String::new(),
        created_at: now,
        updated_at: now,
        members: Vec::new(),
        imported_from_package: None,
        restored_from: None,
    }
}

/// 空的且没有名称：不落盘，已经落了盘的随之消失。
fn is_blank(group: &ReferenceGroup) -> bool {
    group.members.is_empty() && group.is_unnamed()
}

/// 迁移时写参考组用：内容与截图一起发布。
fn publish(
    groups: &ReferenceGroups,
    group: &ReferenceGroup,
    captures: &CaptureFiles,
) -> Result<(), GroupError> {
    groups.publish_with_captures(group, captures)
}
