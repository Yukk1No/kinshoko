//! 桌面上的参考组（#588、#590）：桌面上至多摆着一个参考组，桌面钉图是它“钉着”的成员。
//!
//! [`Desk`] 是唯一知道“桌面上是哪个参考组”和同步规则的地方。应用壳只提交事件（钉了、改了、
//! 关了、钉回、切换、新建、设为常用、加进上一组、移到新参考组、删除），不自己拼先后。不变量：
//!
//! 1. 桌面上至多一个参考组；桌面空着时没有（[`Desk::group`] 为 `None`）。关掉最后一张钉图后桌面空着；
//!    空着时钉下的第一张开一个新参考组。
//! 2. 桌面上的钉图与这个参考组里钉着的成员一一对应：钉上一张多一个钉着的成员，关掉一张只把成员
//!    标成没钉着（不移出），改动局部、摆放、透明度、锁定就更新那个成员。读不出来的成员（例如组内截图
//!    文件缺失）钉不出来，留在参考组里不动；资料库不可用的成员照常钉出（显示占位）。
//! 3. 组内截图文件有成员在用才存在，钉着、没钉着都算（落盘时 [`ReferenceGroups::commit`] 复制进来、
//!    清掉不用的）。
//! 4. 桌面上的动作只写桌面上的那个参考组；加进上一组、移到新参考组只写涉及的两个。
//!
//! 改动先记在内存里，[`Desk::flush`] 才落盘（应用壳在有改动时由后台线程调用，退出时必须调用）。
//! 切换、新建、删除等动到别的参考组之前都先落盘，崩溃后最多丢最近一次还没落盘的摆放。
//!
//! “常用”和最近用过的时间记在桌面状态文件里（[`state`]），不在参考组文件里。
//! 截图历史的钉住计数也由这里管：钉上、关掉、切换时成对地 `pin` / `unpin`。
//! 不是线程安全的；应用壳把它放在锁里，持锁时不调用窗口 API。

mod migrate;
mod moves;
mod state;

use std::collections::{BTreeMap, BTreeSet};
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

pub use moves::{Pruned, Split};

/// 没设常用、这么久没用过的参考组折进“更早”（#588 决定 5；期限试用后再定）。
pub const OLDER_AFTER_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// 侧栏的三段（[`Desk::lists`]）。桌面上的参考组在它所属的那段里。
#[derive(Debug, Clone, PartialEq, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeskLists {
    /// 桌面上的参考组；桌面空着时为 `None`。
    pub on_desk: Option<String>,
    /// 常用，按画师设的先后。
    pub favorites: Vec<GroupSummary>,
    /// 其余的，新建的在前；读不懂的文件排在最后，写明原因。
    pub recent: Vec<GroupSummary>,
    /// 没设常用、[`OLDER_AFTER_MS`] 没用过的，新建的在前。只折叠，不删除。
    pub older: Vec<GroupSummary>,
}

/// 换了一桌（切换、新建、删除桌面上那个、加进上一组）：先关掉 `closed`，再钉出 `opened`。
#[derive(Debug, Clone, PartialEq)]
pub struct Switched {
    pub closed: Vec<SavedPin>,
    pub opened: OpenedPins,
}

impl Switched {
    fn none() -> Switched {
        Switched {
            closed: Vec::new(),
            opened: OpenedPins {
                pins: Vec::new(),
                problems: Vec::new(),
            },
        }
    }
}

/// 钉上一张后（[`Desk::pin`]）。
#[derive(Debug, Clone, PartialEq)]
pub struct Pinned {
    /// 记着成员的钉图。
    pub pin: SavedPin,
    /// 这张钉在空桌上、开了一个新参考组：提示里可以“加进「上一组」”（[`Desk::fold_into_previous`]）。
    /// 没有上一组时为 `None`。
    pub fold_into: Option<String>,
}

/// 收藏截图后（[`Desk::collected`]）：参考组成员的改连结果，以及桌面上改为显示参考图的钉图。
#[derive(Debug, Clone, PartialEq)]
pub struct Collected {
    pub report: RelinkReport,
    pub converted: Vec<SavedPin>,
}

/// 内存里的一个参考组，以及还没复制进它的组内截图（文件名与截图历史中的文件）。
struct Held {
    group: ReferenceGroup,
    copies: Vec<(String, PathBuf)>,
}

impl Held {
    fn saved(group: ReferenceGroup) -> Held {
        Held {
            group,
            copies: Vec::new(),
        }
    }
}

/// 桌面上的参考组。见模块说明。
pub struct Desk {
    groups: ReferenceGroups,
    state_path: PathBuf,
    /// 桌面上的参考组，以内存里的为准；桌面空着时为 `None`。
    on_desk: Option<Held>,
    /// 关掉最后一张钉图后离开了桌面、还没落盘的参考组。
    left: Vec<Held>,
    /// 桌面钉图；每张的 `member` 指向桌面上参考组的一个钉着的成员。
    pins: Vec<SavedPin>,
    /// 常用，按画师设的先后。
    favorites: Vec<String>,
    /// 各参考组最近用过的时间。
    used_at: BTreeMap<String, i64>,
    /// 删除时摆在桌面上的参考组：撤销后桌面还空着就放回桌面。
    trashed_from_desk: BTreeSet<String>,
    /// 撤销删除时文件已放回、还没做完的参考组：再撤销一次时接着做完。
    untrashed: BTreeSet<String>,
    dirty: bool,
    /// 桌面状态写进 `desk.json`。打不开桌面状态时的临时空桌（[`Self::unsaved`]）为 `false`。
    persist: bool,
    /// 自上次落盘以来成员有增减：参考组列表上看得出（张数、缩略图）。
    members_changed: bool,
}

impl Desk {
    /// 打开 `dir`（应用数据目录，与 `pins.json` 同级）下的桌面状态。还没有时迁移：现有参考组都算常用，
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
        let on_desk = file
            .on_desk
            .as_ref()
            .and_then(|id| groups.get(id).ok())
            .map(Held::saved);
        // 参考组文件不在了（例如被别的程序删掉）：不再记着。读不懂的文件还在，照样记着。
        let listed: BTreeSet<String> = groups.list()?.into_iter().map(|s| s.id).collect();
        let mut favorites = file.favorites;
        favorites.retain(|id| listed.contains(id));
        let mut used_at = file.used_at;
        used_at.retain(|id, _| listed.contains(id));
        Ok(Desk {
            groups,
            state_path,
            on_desk,
            left: Vec::new(),
            pins: Vec::new(),
            favorites,
            used_at,
            trashed_from_desk: BTreeSet::new(),
            untrashed: BTreeSet::new(),
            dirty: false,
            persist: true,
            members_changed: false,
        })
    }

    /// 打不开 `dir` 下的桌面状态时（[`Self::open`] 出错）用的一张空桌：没有常用，参考组都按用过的时间分段，
    /// 可以照常切换、钉图；参考组文件照常写，`desk.json` 不写，下次启动再试着打开（或迁移）。
    pub fn unsaved(dir: &Path, groups: ReferenceGroups) -> Desk {
        Desk {
            groups,
            state_path: state::path(dir),
            on_desk: None,
            left: Vec::new(),
            pins: Vec::new(),
            favorites: Vec::new(),
            used_at: Default::default(),
            trashed_from_desk: BTreeSet::new(),
            untrashed: BTreeSet::new(),
            dirty: false,
            persist: false,
            members_changed: false,
        }
    }

    /// 启动时钉出桌面上的参考组：与 [`Self::switch_to`] 得到的一样，再把离开了所有显示器的拉回屏幕。
    pub fn restore(&mut self, history: &mut CaptureHistory, monitors: &[ScreenRect]) -> OpenedPins {
        let mut opened = self.open_pinned(history, |_| true);
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

    /// 桌面上的参考组；桌面空着时为 `None`。
    pub fn group(&self) -> Option<&ReferenceGroup> {
        self.on_desk.as_ref().map(|h| &h.group)
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

    /// 是不是常用。
    pub fn is_favorite(&self, id: &str) -> bool {
        self.favorites.iter().any(|x| x == id)
    }

    /// 上一组：桌面上那个以外、最近用过的参考组。空桌钉下第一张后提示里“加进”的就是它。
    pub fn previous(&self) -> Option<String> {
        let desk = self.desk_id();
        let mut used: Vec<(&String, &i64)> = self
            .used_at
            .iter()
            .filter(|(id, _)| Some(id.as_str()) != desk.as_deref())
            .collect();
        used.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        used.into_iter()
            .map(|(id, _)| id)
            .find(|id| self.left.iter().any(|h| h.group.id == **id) || self.groups.get(id).is_ok())
            .cloned()
    }

    /// 钉上一张新钉图：它成为桌面上参考组的新成员（钉着，记下添加时间），返回记着这个成员的钉图。
    /// 桌面空着时先开一个新参考组（没有名称，界面写日期）。截图钉图的截图成为参考组自带的截图
    /// （落盘时复制进来），截图历史记下钉住与关联，之后收藏能改连。
    /// 截图已不在截图历史中时报错，什么都不改。
    pub fn pin(
        &mut self,
        mut pin: SavedPin,
        history: &mut CaptureHistory,
    ) -> Result<Pinned, GroupError> {
        let member_id = new_id();
        let mut copy = None;
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
                    copy = Some((capture_file.clone(), capture.file));
                }
                member
            }
        };
        let now = crate::library::now_ms();
        member.follow(&pin);
        member.added_at = Some(now);
        let fold_into = match self.on_desk {
            Some(_) => None,
            None => {
                let previous = self.previous();
                let group = blank();
                self.used_at.insert(group.id.clone(), now);
                self.on_desk = Some(Held::saved(group));
                previous
            }
        };
        let held = self.on_desk.as_mut().expect("桌面上刚有了参考组");
        held.copies.extend(copy);
        let at = GroupMemberRef {
            group_id: held.group.id.clone(),
            member_id,
        };
        if let Some(capture_id) = pin.capture_id() {
            history.pin(capture_id);
            let _ = history.link_member(capture_id, at.clone());
        }
        pin.member = Some(at);
        held.group.members.push(member);
        self.pins.push(pin.clone());
        self.dirty = true;
        self.members_changed = true;
        Ok(Pinned { pin, fold_into })
    }

    /// 把资料库里的一张图加进参考组 `group_id`（图库墙“加入参考组”），成为它没钉着的新成员，返回改好的参考组。
    /// 那个参考组正摆在桌面上时什么都不改、返回 `None`：调用方把它钉到桌面上（[`Self::pin`]），
    /// 桌面上参考组的成员就是桌面上的钉图。截图钉图不能这样加（[`GroupError::NoMembers`]）。
    pub fn add_member(
        &mut self,
        group_id: &str,
        pin: &SavedPin,
    ) -> Result<Option<ReferenceGroup>, GroupError> {
        if self.desk_id().as_deref() == Some(group_id) {
            return Ok(None);
        }
        let mut group = self.groups.get(group_id)?;
        let mut member = GroupMember::from_pin(new_id(), pin).ok_or(GroupError::NoMembers)?;
        member.follow(pin);
        // 加进不在桌面上的组：没钉着，切过去时也不钉出来（#596）。
        member.pinned = false;
        group.members.push(member);
        group.updated_at = crate::library::now_ms();
        self.groups.commit(&group, &[])?;
        Ok(Some(group))
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

    /// 画师关掉了一张钉图（Esc 或关闭，#588 决定 3）：成员留在参考组里，标成没钉着，组内截图也留着。
    /// 关掉的是最后一张时桌面空着，这个参考组成为上一组。
    pub fn close(&mut self, pin_id: &str, history: &mut CaptureHistory) -> Option<SavedPin> {
        let at = self.pins.iter().position(|p| p.id == pin_id)?;
        let pin = self.pins.remove(at);
        if let (Some(member), Some(held)) = (&pin.member, self.on_desk.as_mut())
            && let Some(m) = held
                .group
                .members
                .iter_mut()
                .find(|m| m.id == member.member_id)
        {
            m.follow(&pin);
            m.pinned = false;
        }
        if let Some(capture) = pin.capture_id() {
            history.unpin(capture);
        }
        self.dirty = true;
        self.members_changed = true;
        if self.pins.is_empty()
            && let Some(held) = self.on_desk.take()
        {
            self.used_at
                .insert(held.group.id.clone(), crate::library::now_ms());
            self.left.push(held);
        }
        Some(pin)
    }

    /// 钉回桌面上参考组里没钉着的成员 `member_id`，在它原来的位置（侧栏里点淡色的那一项）。
    /// 已经钉着、不在桌面上的参考组里或桌面空着时为 `None`；钉不出来时报错，成员仍是没钉着。
    pub fn repin(
        &mut self,
        member_id: &str,
        history: &mut CaptureHistory,
    ) -> Result<Option<SavedPin>, GroupError> {
        let Some(held) = &self.on_desk else {
            return Ok(None);
        };
        if !held
            .group
            .members
            .iter()
            .any(|m| m.id == member_id && !m.pinned)
        {
            return Ok(None);
        }
        // 刚钉上、还没复制进来的截图要先落盘才钉得出。
        self.flush()?;
        let Some(held) = &self.on_desk else {
            return Ok(None);
        };
        let mut opened =
            self.groups
                .open_members(&held.group, history, |m| m.member_id != member_id, true);
        let Some(pin) = opened.pins.pop() else {
            return Err(match opened.problems.pop() {
                Some(why) => GroupError::Invalid(Box::new(why)),
                None => GroupError::NoMembers,
            });
        };
        if let Some(held) = self.on_desk.as_mut()
            && let Some(m) = held.group.members.iter_mut().find(|m| m.id == member_id)
        {
            m.pinned = true;
        }
        self.pins.push(pin.clone());
        self.dirty = true;
        Ok(Some(pin))
    }

    /// 改名。名称可以为空（回到“未命名”）。
    pub fn rename(&mut self, id: &str, name: &str) -> Result<ReferenceGroup, GroupError> {
        if let Some(held) = self.on_desk.as_mut().filter(|h| h.group.id == id) {
            held.group.name = name.trim().to_owned();
            self.dirty = true;
            self.flush()?;
            return Ok(self
                .on_desk
                .as_ref()
                .map_or_else(blank, |h| h.group.clone()));
        }
        self.flush()?;
        let mut group = self.groups.get(id)?;
        group.name = name.trim().to_owned();
        group.updated_at = crate::library::now_ms();
        self.groups.commit(&group, &[])?;
        Ok(group)
    }

    /// 设为常用（排在常用的最后）或取消常用。参考组不在时报错。
    pub fn set_favorite(&mut self, id: &str, favorite: bool) -> Result<(), GroupError> {
        let known = self.desk_id().as_deref() == Some(id)
            || self.left.iter().any(|h| h.group.id == id)
            || self.groups.get(id).is_ok();
        if !known {
            return Err(GroupError::UnknownGroup);
        }
        let before = self.favorites.clone();
        self.favorites.retain(|x| x != id);
        if favorite {
            match before.iter().position(|x| x == id) {
                // 已经是常用的不挪位置。
                Some(at) => self.favorites.insert(at, id.to_owned()),
                None => self.favorites.push(id.to_owned()),
            }
        }
        if let Err(e) = self.save_state() {
            self.favorites = before;
            return Err(e.into());
        }
        Ok(())
    }

    /// 把改动落盘：先写离开了桌面的参考组，再复制新的组内截图、写桌面上的参考组，最后写桌面状态。
    /// 没有改动时什么都不做。写不进时改动留在内存里，下次再试。
    ///
    /// 返回参考组列表上看不看得出这次落盘：成员有增减、钉着与否变了，或桌面上换了参考组（空桌钉上
    /// 第一张、关掉最后一张）。只拖动、缩放时为 `false`，界面不必重读参考组列表。
    pub fn flush(&mut self) -> Result<bool, GroupError> {
        if !self.dirty {
            return Ok(false);
        }
        let listed = self.desk_id();
        let now = crate::library::now_ms();
        while let Some(held) = self.left.first_mut() {
            held.group.updated_at = now;
            write(&self.groups, held)?;
            self.left.remove(0);
        }
        if let Some(held) = self.on_desk.as_mut() {
            held.group.updated_at = now;
            write(&self.groups, held)?;
            if is_blank(&held.group) {
                // 空的且没有名称（例如移出了全部没钉着的成员）：文件已删掉，桌面空着。
                self.on_desk = None;
            }
        }
        self.save_state()?;
        self.dirty = false;
        let seen = std::mem::take(&mut self.members_changed) || listed != self.desk_id();
        Ok(seen)
    }

    /// 切换到参考组 `id`：先把桌面上的参考组落盘，再整桌换过去，钉出它钉着的成员。原来那一桌原样留着。
    /// `id` 读不出来时报错，桌面不变。已经在桌面上时什么都不换。
    pub fn switch_to(
        &mut self,
        id: &str,
        history: &mut CaptureHistory,
    ) -> Result<Switched, GroupError> {
        if self.desk_id().as_deref() == Some(id) {
            return Ok(Switched::none());
        }
        self.flush()?;
        let target = self.groups.get(id)?;
        Ok(self.replace(Some(target), history)?)
    }

    /// 清空桌面（“新建”）：先落盘，再关掉所有钉图。原来那一组原样留着、成为上一组；
    /// 之后钉下的第一张开一个新参考组。
    pub fn new_desk(&mut self, history: &mut CaptureHistory) -> Result<Switched, GroupError> {
        if self.on_desk.is_none() {
            return Ok(Switched::none());
        }
        self.flush()?;
        Ok(self.replace(None, history)?)
    }

    /// 删除参考组 `id`（#480 的做法，能撤销，见 [`Self::undo_discard`]）：文件与组内截图暂放到回收位置。
    /// 删除的正是桌面上那个时桌面空着（返回这次换桌），不替画师换到别的参考组。
    pub fn discard(
        &mut self,
        id: &str,
        history: &mut CaptureHistory,
    ) -> Result<Option<Switched>, GroupError> {
        // 也写掉离开了桌面、还没落盘的参考组：删的可能正是它。
        self.flush()?;
        let on_desk = self.desk_id().as_deref() == Some(id);
        self.groups.trash(id)?;
        if !on_desk {
            // 常用与最近用过的时间留着：撤销后回到原来的段。过期时由 purge 清掉。
            return Ok(None);
        }
        // 参考组已在回收位置：换走时不能再把它写回去（落盘过，内存里没有没写的改动）。
        match self.replace(None, history) {
            Ok(switched) => {
                self.trashed_from_desk.insert(id.to_owned());
                Ok(Some(switched))
            }
            Err(e) => {
                // 写不进桌面状态：桌面还是它，把文件放回原处，像没删过一样。
                self.groups.untrash(id)?;
                Err(e.into())
            }
        }
    }

    /// 撤销删除：参考组连同自带截图放回原处，补上删除期间的收藏改连。删除时它摆在桌面上、
    /// 桌面现在还空着的话，再摆回桌面（返回这次换桌）。
    pub fn undo_discard(
        &mut self,
        id: &str,
        history: &mut CaptureHistory,
    ) -> Result<(RelinkReport, Option<Switched>), GroupError> {
        let to_desk = self.trashed_from_desk.contains(id) && self.on_desk.is_none();
        let report = match self.groups.untrash_reconciling(id, history) {
            Ok(report) => report,
            // 上次撤销已把文件放回、没能摆回桌面就失败了：这次接着做完。
            Err(GroupError::UnknownGroup) if self.untrashed.contains(id) => RelinkReport::default(),
            Err(e) => return Err(e),
        };
        // 做完才算撤销完：失败时留着记录，可以再撤销一次。
        self.untrashed.insert(id.to_owned());
        let switched = if to_desk {
            Some(self.switch_to(id, history)?)
        } else {
            None
        };
        self.trashed_from_desk.remove(id);
        self.untrashed.remove(id);
        Ok((report, switched))
    }

    /// 撤销提示过期：真正删除回收位置里的参考组 `id`，不再记它是不是常用、什么时候用过。
    pub fn purge(&mut self, id: &str) -> Result<(), GroupError> {
        self.trashed_from_desk.remove(id);
        self.untrashed.remove(id);
        self.groups.purge(id)?;
        self.favorites.retain(|x| x != id);
        self.used_at.remove(id);
        // 下次落盘时写进桌面状态；写不进也无妨，打开时会略过不在的参考组。
        self.dirty = true;
        Ok(())
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
        let Some(desk) = self.desk_id() else {
            return Ok(Collected {
                report,
                converted: Vec::new(),
            });
        };
        let mine: Vec<&GroupMemberRef> = report
            .relinked
            .iter()
            .filter(|m| m.group_id == desk)
            .collect();
        let mut converted = Vec::new();
        if !mine.is_empty() {
            let group = self.groups.get(&desk)?;
            for pin in &mut self.pins {
                let Some(member) = pin.member.as_ref().filter(|m| mine.contains(m)) else {
                    continue;
                };
                let Some(old) = pin.capture_id().map(str::to_owned) else {
                    continue;
                };
                let Some(m) = group.members.iter().find(|m| m.id == member.member_id) else {
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
            self.on_desk = Some(Held::saved(group));
        }
        Ok(Collected { report, converted })
    }

    /// 侧栏的三段，按现在的时间分“最近”和“更早”。
    pub fn lists(&self) -> Result<DeskLists, GroupError> {
        self.lists_at(crate::library::now_ms())
    }

    /// 同 [`Self::lists`]，按 `now`（毫秒）算。内存里还没落盘的也算：钉上第一张后新参考组就列出，
    /// 空的且没有名称的不列出。
    pub fn lists_at(&self, now: i64) -> Result<DeskLists, GroupError> {
        let mut all = self.groups.list()?;
        for held in self.left.iter().chain(self.on_desk.as_ref()) {
            let at = all.iter().position(|s| s.id == held.group.id);
            match (is_blank(&held.group), at) {
                (true, Some(at)) => {
                    all.remove(at);
                }
                (true, None) => {}
                (false, Some(at)) => all[at] = held.group.summary(),
                (false, None) => all.push(held.group.summary()),
            }
        }
        let mut favorites = Vec::new();
        for id in &self.favorites {
            if let Some(at) = all.iter().position(|s| s.id == *id) {
                favorites.push(all.remove(at));
            }
        }
        let (mut unreadable, mut rest): (Vec<_>, Vec<_>) =
            all.into_iter().partition(|s| s.problem.is_some());
        rest.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.name.cmp(&b.name)));
        let desk = self.desk_id();
        let (mut recent, older): (Vec<_>, Vec<_>) = rest.into_iter().partition(|s| {
            let used = self.used_at.get(&s.id).copied().unwrap_or(s.updated_at);
            Some(&s.id) == desk.as_ref() || now - used <= OLDER_AFTER_MS
        });
        recent.append(&mut unreadable);
        Ok(DeskLists {
            on_desk: desk,
            favorites,
            recent,
            older,
        })
    }

    fn desk_id(&self) -> Option<String> {
        self.on_desk.as_ref().map(|h| h.group.id.clone())
    }

    /// 桌面上的参考组换成 `next`（`None` 为空桌）：关掉现有钉图，钉出 `next` 钉着的成员，写桌面状态。
    /// 调用前要落盘过（内存里没有没写的改动）。
    fn replace(
        &mut self,
        next: Option<ReferenceGroup>,
        history: &mut CaptureHistory,
    ) -> io::Result<Switched> {
        let now = crate::library::now_ms();
        let mut used_at = self.used_at.clone();
        for id in self.desk_id().iter().chain(next.as_ref().map(|g| &g.id)) {
            used_at.insert(id.clone(), now);
        }
        // 先写桌面状态：写不进时内存与钉图都还是原来那一桌，调用方拿到错误、什么都不用改。
        self.write_desk_file(&DeskFile::new(
            next.as_ref().map(|g| g.id.clone()),
            self.favorites.clone(),
            used_at.clone(),
        ))?;
        self.used_at = used_at;
        let closed = std::mem::take(&mut self.pins);
        for capture in closed.iter().filter_map(SavedPin::capture_id) {
            history.unpin(capture);
        }
        self.on_desk = next.map(Held::saved);
        self.dirty = false;
        let opened = self.open_pinned(history, |_| true);
        self.pins = opened.pins.clone();
        Ok(Switched { closed, opened })
    }

    /// 钉出桌面上参考组里钉着、且 `only` 为真的成员。
    fn open_pinned(&self, history: &mut CaptureHistory, only: impl Fn(&str) -> bool) -> OpenedPins {
        let Some(held) = &self.on_desk else {
            return Switched::none().opened;
        };
        let unpinned: BTreeSet<&str> = held
            .group
            .members
            .iter()
            .filter(|m| !m.pinned)
            .map(|m| m.id.as_str())
            .collect();
        self.groups.open_members(
            &held.group,
            history,
            |m| unpinned.contains(m.member_id.as_str()) || !only(&m.member_id),
            true,
        )
    }

    /// 成员跟着钉图。
    fn sync(&mut self, pin: &SavedPin) {
        let (Some(member), Some(held)) = (&pin.member, self.on_desk.as_mut()) else {
            return;
        };
        if let Some(m) = held
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

    /// 写 `desk.json`；临时空桌（[`Self::unsaved`]）不写。
    fn write_desk_file(&self, file: &DeskFile) -> io::Result<()> {
        if !self.persist {
            return Ok(());
        }
        state::save(&self.state_path, file)
    }

    fn save_state(&self) -> io::Result<()> {
        self.write_desk_file(&DeskFile::new(
            self.desk_id(),
            self.favorites.clone(),
            self.used_at.clone(),
        ))
    }

    /// 不再记着参考组 `id`（它已删掉，例如并进了别的参考组）。
    fn forget(&mut self, id: &str) {
        self.favorites.retain(|x| x != id);
        self.used_at.remove(id);
    }
}

/// 写一个内存里的参考组：空的且没有名称的连文件一起删掉，其余的复制新截图后写文件。
fn write(groups: &ReferenceGroups, held: &mut Held) -> Result<(), GroupError> {
    if is_blank(&held.group) {
        return match groups.delete(&held.group.id) {
            Ok(()) | Err(GroupError::UnknownGroup) => Ok(()),
            Err(e) => Err(e),
        };
    }
    groups.commit(&held.group, &held.copies)?;
    held.copies.clear();
    Ok(())
}

/// 一个新的参考组：没有成员、没有名称（界面写日期）。
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
