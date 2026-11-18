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
#[derive(Debug, Clone, PartialEq)]
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
        Some(pin)
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

    /// 把改动落盘：先复制新的组内截图、写参考组文件，再写桌面状态。没有改动时什么都不做。
    /// 写不进时改动留在内存里，下次再试。
    pub fn flush(&mut self) -> Result<(), GroupError> {
        if !self.dirty {
            return Ok(());
        }
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
            self.copies.clear();
            // 第一次落盘时进切换列表；已经在里面的不挪位置，改钉图不算“用过”，切换顺序不变。
            let id = self.group.id.clone();
            if !self.switch_list.contains(&id) {
                self.switch_list.insert(0, id);
            }
        }
        self.save_state()?;
        self.dirty = false;
        Ok(())
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
