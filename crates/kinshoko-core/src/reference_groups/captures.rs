//! 参考组自带的截图（#270）：存在 `<参考组>.captures/` 下，打开参考组时放回截图历史再钉出，
//! 没有成员再用时删除，收藏后成员改为引用资料库。

use crate::CommandError;
use crate::command_error::ErrorKind;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use super::member::valid_capture_file;
use super::{
    CAPTURES_EXTENSION, GroupError, GroupMember, MemberSource, MemberState, ReferenceGroup,
    ReferenceGroupView, ReferenceGroups, ReferenceSource, UnavailableReason, new_id,
};
use crate::desktop::{CaptureHistory, CollectedCapture, GroupMemberRef, PreparedCapture, SavedPin};

/// 参考组自带的截图：文件名与字节（参考组包、备份用）。
pub type CaptureFiles = Vec<(String, Vec<u8>)>;

/// 打开参考组得到的钉图（[`ReferenceGroups::open_pins`]）。组内截图文件缺失、放不回截图历史的
/// 成员钉不出来，在 `problems` 里逐个说明。
#[derive(Debug, Clone, PartialEq)]
pub struct OpenedPins {
    pub pins: Vec<SavedPin>,
    pub problems: Vec<CommandError>,
}

/// 收藏截图后改连参考组成员的结果（[`ReferenceGroups::relink_collected`]），每个关联的成员恰在
/// `relinked`、`skipped`、`failed` 之一。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RelinkReport {
    /// 改为引用收藏成的参考图的成员。
    pub relinked: Vec<GroupMemberRef>,
    /// 关联已明确失效而略过的成员：参考组已删除、成员已移出或已改连。
    pub skipped: Vec<GroupMemberRef>,
    /// 这次没改连的成员；关联留着，下次收藏这张截图时再试。
    pub failed: Vec<RelinkFailure>,
    /// 改连了、略过了的关联没能从截图历史去掉时的原因。关联留着，下次按已改连略过后再去掉。
    pub unlink_error: Option<String>,
}

/// 没改连的成员与原因。
#[derive(Debug, Clone, PartialEq)]
pub struct RelinkFailure {
    pub member: GroupMemberRef,
    pub reason: GroupError,
}

impl ReferenceGroups {
    /// 备份的快照入口（#69、#270）：快照字节 `snapshot` 里组内截图成员用到的截图文件与字节，
    /// 从参考组 `id` 的目录读。有文件读不到时报错，不交出缺了截图的快照。
    pub fn snapshot_captures(&self, id: &str, snapshot: &[u8]) -> Result<CaptureFiles, GroupError> {
        let group = super::parse(snapshot)?;
        let dir = self.captures_dir(id)?;
        group
            .capture_files()
            .into_iter()
            .map(|file| match fs::read(dir.join(file)) {
                Ok(bytes) => Ok((file.to_owned(), bytes)),
                Err(e) => Err(GroupError::invalid(
                    ErrorKind::GroupCaptureUnreadable {
                        file: file.to_owned(),
                        detail: e.to_string(),
                    },
                    format!("{}（{file}）：{e}", UnavailableReason::CaptureMissing),
                )),
            })
            .collect()
    }

    /// 打开参考组：每个成员一个新的桌面钉图，按成员的先后，带着各自的局部与摆放；`skip` 为真的
    /// 成员（例如已在桌面上）不钉。组内截图按字节放回截图历史（不重编码），钉成截图钉图，截图历史
    /// 知道它正被钉住。资料库成员同 [`ReferenceGroup::pins`]。
    pub fn open_pins(
        &self,
        group: &ReferenceGroup,
        history: &mut CaptureHistory,
        skip: impl Fn(&GroupMemberRef) -> bool,
    ) -> OpenedPins {
        let mut opened = OpenedPins {
            pins: Vec::new(),
            problems: Vec::new(),
        };
        for m in &group.members {
            let member = GroupMemberRef {
                group_id: group.id.clone(),
                member_id: m.id.clone(),
            };
            if skip(&member) {
                continue;
            }
            let capture_id = match &m.source {
                MemberSource::Library { .. } => String::new(),
                MemberSource::Capture { .. } => {
                    let added = self
                        .capture_file(&group.id, m)
                        .ok_or_else(|| {
                            CommandError::new(
                                ErrorKind::MemberCaptureFileInvalid,
                                "截图文件名不合法",
                            )
                        })
                        .and_then(|path| {
                            fs::read(path).map_err(|_| {
                                CommandError::new(
                                    ErrorKind::MemberCaptureMissing,
                                    "组内截图文件缺失",
                                )
                            })
                        })
                        .and_then(|png| {
                            history
                                .add_prepared(PreparedCapture::from_png(
                                    png,
                                    m.source_width,
                                    m.source_height,
                                ))
                                .map_err(CommandError::from)
                        });
                    match added {
                        Ok(entry) => entry.id,
                        Err(why) => {
                            let member = m.id.clone();
                            opened.problems.push(CommandError::caused_by(
                                why,
                                |cause| ErrorKind::GroupMemberPin {
                                    member: member.clone(),
                                    cause,
                                },
                                |why| format!("成员 {member}：{why}"),
                            ));
                            continue;
                        }
                    }
                }
            };
            match m.pin(&new_id(), &group.id, &capture_id) {
                Ok(pin) => {
                    if let Some(capture) = pin.capture_id() {
                        history.pin(capture);
                        let _ = history.link_member(capture, member);
                    }
                    opened.pins.push(pin);
                }
                Err(why) => opened.problems.push(why),
            }
        }
        opened
    }

    /// 参考组及其成员此刻的状态：资料库成员跨库核对（[`super::resolve`]）；组内截图没有内容分级，
    /// 安全模式下也照常显示，文件不在时标出 [`UnavailableReason::CaptureMissing`]。
    pub fn view(&self, group: ReferenceGroup, source: &dyn ReferenceSource) -> ReferenceGroupView {
        let mut view = ReferenceGroupView::new(group, source);
        for (status, m) in view.members.iter_mut().zip(&view.group.members) {
            if matches!(m.source, MemberSource::Capture { .. })
                && !self
                    .capture_file(&view.group.id, m)
                    .is_some_and(|p| p.is_file())
            {
                let reason = UnavailableReason::CaptureMissing;
                status.state = MemberState::Unavailable {
                    message: reason.to_string(),
                    reason,
                };
            }
        }
        view
    }

    /// 参考组 `id` 里组内截图成员 `member_id` 的截图文件；不是组内截图时为 `None`。
    pub fn capture_path(&self, id: &str, member_id: &str) -> Option<PathBuf> {
        let group = self.get(id).ok()?;
        let member = group.members.iter().find(|m| m.id == member_id)?;
        self.capture_file(id, member)
    }

    /// 存进参考组后：显示截图历史条目、又是组内截图成员的钉图，在截图历史里记下这层关联，
    /// 之后钉图关掉再从截图历史收藏也能改连（[`Self::relink_collected`]）。记不下时略过。
    pub fn link_captures(&self, history: &mut CaptureHistory, pins: &[SavedPin]) {
        for pin in pins {
            let (Some(capture_id), Some(member)) = (pin.capture_id(), &pin.member) else {
                continue;
            };
            if self.is_capture_member(member) {
                let _ = history.link_member(capture_id, member.clone());
            }
        }
    }

    /// 截图历史条目 `capture_id` 收藏成了 `collected`（截图历史或钉图菜单的“收藏”）：与它关联的
    /// 组内截图成员逐个改为引用那张参考图，组内副本删除。参考组已删除、成员已移出或已改连的关联
    /// 略过。改连了、略过了的关联才从截图历史去掉；参考组读不了、写不进的成员关联留着，下次收藏
    /// 这张截图时再试，已改连的那些不会再动。
    pub fn relink_collected(
        &self,
        history: &mut CaptureHistory,
        capture_id: &str,
        collected: &CollectedCapture,
    ) -> RelinkReport {
        let mut report = RelinkReport::default();
        for member in history.linked_members(capture_id) {
            match self.relink(&member, collected) {
                Ok(true) => report.relinked.push(member),
                Ok(false) => report.skipped.push(member),
                Err(reason) => report.failed.push(RelinkFailure { member, reason }),
            }
        }
        let done: Vec<GroupMemberRef> = report
            .relinked
            .iter()
            .chain(&report.skipped)
            .cloned()
            .collect();
        report.unlink_error = history
            .unlink_members(capture_id, &done)
            .err()
            .map(|e| e.to_string());
        report
    }

    /// `member` 现在还是组内截图成员。
    fn is_capture_member(&self, member: &GroupMemberRef) -> bool {
        self.get(&member.group_id).is_ok_and(|g| {
            g.members
                .iter()
                .any(|m| m.id == member.member_id && m.library_id().is_none())
        })
    }

    /// 把一个关联的成员改连：改了为真；参考组明确不在、成员已移出或已改连为假；参考组读写失败
    /// 时报错（读不了不当作已删除）。
    fn relink(
        &self,
        member: &GroupMemberRef,
        collected: &CollectedCapture,
    ) -> Result<bool, GroupError> {
        let mut group = match self.get(&member.group_id) {
            Err(GroupError::UnknownGroup) => return Ok(false),
            got => got?,
        };
        let Some(m) = group
            .members
            .iter_mut()
            .find(|m| m.id == member.member_id && m.library_id().is_none())
        else {
            return Ok(false);
        };
        m.source = MemberSource::Library {
            library_id: collected.library_id.clone(),
            image_id: collected.image_id.clone(),
        };
        group.updated_at = crate::library::now_ms();
        self.commit(&group, &[])?;
        Ok(true)
    }

    /// 组内截图收藏进了资料库：成员改为引用那张参考图（局部与摆放不变），组内那份截图删除。
    /// 成员已不是组内截图时什么都不改。
    pub fn collected(
        &self,
        member: &GroupMemberRef,
        collected: &CollectedCapture,
    ) -> Result<ReferenceGroup, GroupError> {
        let group = self.get(&member.group_id)?;
        self.relink(member, collected)?;
        self.get(&group.id)
    }
}

impl ReferenceGroups {
    /// 参考组 `id` 自带截图的目录。
    pub(super) fn captures_dir(&self, id: &str) -> Result<PathBuf, GroupError> {
        Ok(self.path(id)?.with_extension(CAPTURES_EXTENSION))
    }

    /// 组内截图成员的截图文件；资料库成员或文件名不合法时为 `None`。
    fn capture_file(&self, id: &str, member: &GroupMember) -> Option<PathBuf> {
        match &member.source {
            MemberSource::Capture { capture_file } if valid_capture_file(capture_file) => {
                Some(self.captures_dir(id).ok()?.join(capture_file))
            }
            _ => None,
        }
    }

    /// 先把新的组内截图复制进参考组（`copies`：文件名与截图历史中的文件），再写参考组文件，
    /// 最后删掉不再被成员用到的组内截图。中途失败时删掉这次复制的截图，参考组文件保持原样。
    pub(super) fn commit(
        &self,
        group: &ReferenceGroup,
        copies: &[(String, PathBuf)],
    ) -> Result<(), GroupError> {
        let dir = self.captures_dir(&group.id)?;
        let written = (|| -> Result<(), GroupError> {
            for (file, from) in copies {
                fs::create_dir_all(&dir)?;
                write_atomically(&dir.join(file), &fs::read(from)?)?;
            }
            self.write(group)
        })();
        if written.is_err() {
            for (file, _) in copies {
                let _ = fs::remove_file(dir.join(file));
            }
            return written;
        }
        self.sweep(group);
        Ok(())
    }

    /// 新参考组连同它自带的截图一起写入：先写截图，再写参考组文件；失败时删掉写了一半的截图目录。
    pub(super) fn publish_with_captures(
        &self,
        group: &ReferenceGroup,
        captures: &CaptureFiles,
    ) -> Result<(), GroupError> {
        let dir = self.captures_dir(&group.id)?;
        let written = (|| -> Result<(), GroupError> {
            for (file, bytes) in captures {
                if !valid_capture_file(file) {
                    return Err(GroupError::invalid(
                        ErrorKind::CaptureFileInvalid { file: file.clone() },
                        format!("截图文件名 {file} 不合法"),
                    ));
                }
                fs::create_dir_all(&dir)?;
                write_atomically(&dir.join(file), bytes)?;
            }
            self.write(group)
        })();
        if written.is_err() {
            let _ = fs::remove_dir_all(&dir);
        }
        written
    }

    /// 删掉参考组目录下不再被成员用到的截图（和写到一半的临时文件）；一张也不剩时删掉目录。
    /// 删不掉只留下孤立文件，下次改动这个参考组时再删。
    fn sweep(&self, group: &ReferenceGroup) {
        let Ok(dir) = self.captures_dir(&group.id) else {
            return;
        };
        let Ok(entries) = fs::read_dir(&dir) else {
            return;
        };
        let used = group.capture_files();
        for entry in entries.flatten() {
            let name = entry.file_name();
            if !used.contains(name.to_string_lossy().as_ref()) {
                let _ = fs::remove_file(entry.path());
            }
        }
        if used.is_empty() {
            let _ = fs::remove_dir(&dir);
        }
    }
}

/// 先写同目录的临时文件并落盘，再改名替换，写到一半断电也不会留下半份。
pub(super) fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let tmp = path.with_file_name(format!(".{name}.tmp-{}", new_id()));
    let written = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}
