//! 把已关闭的成员钉回来（#588 11-19 晚 规则 4、5）：全部钉上；侧栏里点某个参考组的某张图。

use std::collections::BTreeSet;

use super::{Desk, Switched};
use crate::desktop::{CaptureHistory, SavedPin};
use crate::reference_groups::{GroupError, OpenedPins};

/// 侧栏里点了一张图之后（[`Desk::show_member`]）。
#[derive(Debug, Clone, PartialEq)]
pub struct ShownMember {
    /// 它的参考组原来不在桌面上时，这次整桌换过去。
    pub switched: Option<Switched>,
    /// 它原来已关闭时，这次钉出的钉图。
    pub opened: Option<SavedPin>,
    /// 它此刻的钉图；钉不出来（参考组里没有它）时为 `None`。已经钉着的由应用壳提到最前。
    pub pin_id: Option<String>,
}

impl Desk {
    /// 全部钉上：桌面上参考组里已关闭的成员都在原位置钉出（切到一张都没钉着的组时侧栏给的入口）。
    /// 桌面空着或没有已关闭的成员时什么都不做；钉不出来的成员留在已关闭，原因在 `problems` 里。
    pub fn repin_all(&mut self, history: &mut CaptureHistory) -> Result<OpenedPins, GroupError> {
        let none = || OpenedPins {
            pins: Vec::new(),
            problems: Vec::new(),
        };
        let closed: BTreeSet<String> = match &self.on_desk {
            Some(held) => held
                .group
                .members
                .iter()
                .filter(|m| !m.pinned)
                .map(|m| m.id.clone())
                .collect(),
            None => return Ok(none()),
        };
        if closed.is_empty() {
            return Ok(none());
        }
        // 刚钉上、还没复制进来的截图要先落盘才钉得出。
        self.flush()?;
        let Some(held) = &self.on_desk else {
            return Ok(none());
        };
        let opened = self.groups.open_members(
            &held.group,
            history,
            |m| !closed.contains(&m.member_id),
            true,
        );
        let reopened: BTreeSet<&str> = opened
            .pins
            .iter()
            .filter_map(|p| p.member.as_ref().map(|m| m.member_id.as_str()))
            .collect();
        if let Some(held) = self.on_desk.as_mut() {
            for m in held
                .group
                .members
                .iter_mut()
                .filter(|m| reopened.contains(m.id.as_str()))
            {
                m.pinned = true;
                m.closed_at = None;
            }
        }
        self.pins.extend(opened.pins.iter().cloned());
        self.dirty = !opened.pins.is_empty() || self.dirty;
        Ok(opened)
    }

    /// 侧栏里点了参考组 `group_id` 的成员 `member_id`：参考组不在桌面上时先整桌换过去，
    /// 它已关闭就在原位置钉出。`group_id` 读不出来时报错，桌面不变。
    pub fn show_member(
        &mut self,
        group_id: &str,
        member_id: &str,
        history: &mut CaptureHistory,
    ) -> Result<ShownMember, GroupError> {
        let switched = if self.desk_id().as_deref() == Some(group_id) {
            None
        } else {
            Some(self.switch_to(group_id, history)?)
        };
        let opened = self.repin(member_id, history)?;
        let pin_id = self
            .pins
            .iter()
            .find(|p| p.member.as_ref().is_some_and(|m| m.member_id == member_id))
            .map(|p| p.id.clone());
        Ok(ShownMember {
            switched,
            opened,
            pin_id,
        })
    }
}
