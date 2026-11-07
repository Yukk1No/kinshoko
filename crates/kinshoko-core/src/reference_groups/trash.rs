//! 删除参考组可撤销（#480）：刚删除的参考组暂放在 `trash/<参考组>/` 下。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{EXTENSION, GroupError, ReferenceGroups, RelinkReport};
use crate::desktop::CaptureHistory;

/// 刚删除、还能撤销的参考组暂放在 `trash/` 下。
const TRASH_DIR: &str = "trash";

/// 删除参考组（#480）时，桌面上被解除关联的钉图：撤销时据此重新记起自己是哪个成员。
/// 由应用壳在删除时返回、撤销时带回；参考组本身暂放在回收位置（[`ReferenceGroups::trash`]）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeletedGroup {
    pub group_id: String,
    pub name: String,
    pub unlinked_pins: Vec<UnlinkedPin>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UnlinkedPin {
    pub pin_id: String,
    pub member_id: String,
}

impl ReferenceGroups {
    /// 删除参考组（#480，可撤销）：参考组文件和它自带的截图移到 `trash/<参考组>/` 下，列表里不再出现。
    /// 提示期内 [`Self::untrash`] 原样放回；过期后 [`Self::purge`] 真正删除；程序在提示期间退出的，
    /// 下次启动时 [`Self::purge_all_trashed`] 清掉。
    pub fn trash(&self, id: &str) -> Result<(), GroupError> {
        let file = self.path(id)?;
        if !file.exists() {
            return Err(GroupError::UnknownGroup);
        }
        let slot = self.trash_slot(id)?;
        // 同一个 id 上一次留下的（不会发生，除非残留）先清掉，免得改名失败。
        let _ = fs::remove_dir_all(&slot);
        fs::create_dir_all(&slot)?;
        let moved = (|| -> Result<(), GroupError> {
            let captures = self.captures_dir(id)?;
            if captures.exists() {
                fs::rename(
                    &captures,
                    slot.join(captures.file_name().unwrap_or_default()),
                )?;
            }
            fs::rename(&file, slot.join(file.file_name().unwrap_or_default()))?;
            Ok(())
        })();
        if moved.is_err() {
            // 半途失败：把已移走的放回，参考组保持原样。
            let _ = self.move_back(id, &slot);
        }
        moved
    }

    /// 撤销 [`Self::trash`]：参考组文件和组内截图放回原处。已经过期清掉了为 [`GroupError::UnknownGroup`]。
    pub fn untrash(&self, id: &str) -> Result<(), GroupError> {
        let slot = self.trash_slot(id)?;
        if !slot.join(format!("{id}.{EXTENSION}")).exists() {
            return Err(GroupError::UnknownGroup);
        }
        self.move_back(id, &slot)?;
        let _ = fs::remove_dir_all(&slot);
        Ok(())
    }

    /// 撤销 [`Self::trash`] 并补上期间发生的收藏：参考组在回收位置时，从截图历史收藏了属于它的
    /// 组内截图（那时 [`Self::relink_collected`] 留着关联不动），放回后把这些成员改为引用收藏的参考图。
    /// 返回补上的改连结果。
    pub fn untrash_reconciling(
        &self,
        id: &str,
        history: &mut CaptureHistory,
    ) -> Result<RelinkReport, GroupError> {
        self.untrash(id)?;
        let mut report = RelinkReport::default();
        for entry in history.entries() {
            let Some(collected) = entry.collected.first() else {
                continue;
            };
            if !history
                .linked_members(&entry.id)
                .iter()
                .any(|m| m.group_id == id)
            {
                continue;
            }
            let done = self.relink_collected(history, &entry.id, collected);
            report.relinked.extend(done.relinked);
            report.skipped.extend(done.skipped);
            report.failed.extend(done.failed);
            report.unlink_error = report.unlink_error.or(done.unlink_error);
        }
        Ok(report)
    }

    /// 参考组 `id` 现在暂放在回收位置。
    pub(super) fn is_trashed(&self, id: &str) -> bool {
        self.trash_slot(id)
            .is_ok_and(|slot| slot.join(format!("{id}.{EXTENSION}")).exists())
    }

    /// 撤销提示过期：真正删除回收位置里的这个参考组。没有时什么也不做。
    pub fn purge(&self, id: &str) -> Result<(), GroupError> {
        match fs::remove_dir_all(self.trash_slot(id)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// 启动时清掉回收位置里留下的全部（上次退出时撤销提示还没过期的）。
    pub fn purge_all_trashed(&self) -> Result<(), GroupError> {
        match fs::remove_dir_all(self.dir.join(TRASH_DIR)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    fn trash_slot(&self, id: &str) -> Result<PathBuf, GroupError> {
        self.path(id)?;
        Ok(self.dir.join(TRASH_DIR).join(id))
    }

    fn move_back(&self, id: &str, slot: &Path) -> Result<(), GroupError> {
        let file = self.path(id)?;
        let captures = self.captures_dir(id)?;
        let kept_captures = slot.join(captures.file_name().unwrap_or_default());
        if kept_captures.exists() {
            fs::rename(&kept_captures, &captures)?;
        }
        let kept = slot.join(file.file_name().unwrap_or_default());
        if kept.exists() {
            fs::rename(&kept, &file)?;
        }
        Ok(())
    }
}
