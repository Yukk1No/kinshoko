//! 删除参考组与撤销（#480 的做法）、撤销提示过期后真正删除。

use super::{Desk, Switched};
use crate::desktop::CaptureHistory;
use crate::reference_groups::{GroupError, RelinkReport};

impl Desk {
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
}
