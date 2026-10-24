//! 把桌面钉图并进参考组。

use std::path::PathBuf;

use super::{GroupCapture, GroupMember, MemberSource, ReferenceGroup, new_id};
use crate::desktop::{GroupMemberRef, SavedPin};

/// 钉图并进参考组的结果：每张钉图（按下标）成了哪个成员，写入成功后才交给 [`assign`]；
/// 以及要复制进参考组的截图（文件名与截图历史中的文件）。
pub(super) struct Merged {
    pub(super) assigned: Vec<(usize, GroupMemberRef)>,
    pub(super) copies: Vec<(String, PathBuf)>,
}

/// 把钉图并进参考组。资料库钉图成为（或更新）资料库成员；来自组内截图成员的截图钉图只更新局部与
/// 摆放，截图文件不动；`captures` 中的其他截图钉图成为新的组内截图成员；别的截图钉图不进组。
pub(super) fn merge(
    group: &mut ReferenceGroup,
    pins: &[SavedPin],
    captures: &[GroupCapture],
) -> Merged {
    let mut merged = Merged {
        assigned: Vec::new(),
        copies: Vec::new(),
    };
    for (index, pin) in pins.iter().enumerate() {
        let existing = pin
            .member
            .as_ref()
            .filter(|m| m.group_id == group.id)
            .and_then(|m| group.members.iter().position(|x| x.id == m.member_id));
        let member_id = existing.map_or_else(new_id, |at| group.members[at].id.clone());
        let member = match pin.capture_id() {
            None => GroupMember::from_pin(member_id.clone(), pin),
            Some(_) if existing.is_some_and(|at| group.members[at].library_id().is_none()) => {
                let kept = &group.members[existing.unwrap_or_default()];
                Some(GroupMember {
                    crop: pin.crop,
                    placement: pin.placement,
                    ..kept.clone()
                })
            }
            Some(capture_id) => {
                captures
                    .iter()
                    .find(|c| c.capture_id == capture_id)
                    .map(|capture| {
                        let member = GroupMember::from_capture_pin(member_id.clone(), pin, capture);
                        if let MemberSource::Capture { capture_file } = &member.source {
                            merged
                                .copies
                                .push((capture_file.clone(), capture.file.clone()));
                        }
                        member
                    })
            }
        };
        let Some(member) = member else {
            continue;
        };
        match existing {
            Some(at) => group.members[at] = member,
            None => group.members.push(member),
        }
        merged.assigned.push((
            index,
            GroupMemberRef {
                group_id: group.id.clone(),
                member_id,
            },
        ));
    }
    merged
}

pub(super) fn assign(pins: &mut [SavedPin], assigned: Vec<(usize, GroupMemberRef)>) {
    for (index, member) in assigned {
        pins[index].member = Some(member);
    }
}
