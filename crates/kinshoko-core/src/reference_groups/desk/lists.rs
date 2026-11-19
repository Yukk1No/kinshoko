//! 侧栏的三段：常用、最近、更早（#588 决定 5）。

use super::{Desk, is_blank};
use crate::reference_groups::{GroupError, GroupSummary};

/// 没设常用、这么久没用过的参考组折进“更早”（#588 决定 5；期限试用后再定）。
pub const OLDER_AFTER_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// 侧栏的三段（[`Desk::lists`]）。桌面上的参考组在它所属的那段里。
#[derive(Debug, Clone, PartialEq)]
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

impl Desk {
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
}
