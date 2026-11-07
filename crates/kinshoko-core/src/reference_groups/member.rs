//! 参考组成员与它用的是什么：资料库中的参考图，或参考组自带的截图（#270）。

use crate::CommandError;
use crate::command_error::ErrorKind;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::desktop::{
    GroupMemberRef, MAX_SCALE, MIN_SCALE, PinContent, Placement, Region, SavedPin,
};
use crate::library::ReferenceImage;

/// 成员用的是什么：资料库中的参考图，或参考组自带的截图（#270）。
/// 磁盘上不带标签，资料库成员仍是旧文件的 `libraryId`、`imageId` 两个字段，旧参考组不迁移也能读。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(untagged)]
#[ts(export)]
pub enum MemberSource {
    /// 按“资料库＋参考图”引用。
    #[serde(rename_all = "camelCase")]
    Library {
        library_id: String,
        image_id: String,
    },
    /// 参考组自带的截图：`<参考组>.captures/` 下的文件名。
    #[serde(rename_all = "camelCase")]
    Capture { capture_file: String },
}

impl MemberSource {
    /// 引用的“资料库＋参考图”；组内截图为 `None`。
    pub fn library_image(&self) -> Option<(&str, &str)> {
        match self {
            MemberSource::Library {
                library_id,
                image_id,
            } => Some((library_id, image_id)),
            MemberSource::Capture { .. } => None,
        }
    }
}

/// 参考组成员：参考视图或参考组自带的截图在这个参考组里的一次使用。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GroupMember {
    /// 在参考组内唯一。
    pub id: String,
    #[serde(flatten)]
    pub source: MemberSource,
    /// 原图尺寸：局部总能核对是否在图内，资料库不在时也能按原尺寸保留布局。
    pub source_width: u32,
    pub source_height: u32,
    /// 只显示原图的这一块（原图像素）；`None` 为整图。
    pub crop: Option<Region>,
    /// 位置、缩放、翻转与旋转；尺寸由局部与缩放得出。
    pub placement: Placement,
}

impl GroupMember {
    /// 引用的资料库；组内截图为 `None`。
    pub fn library_id(&self) -> Option<&str> {
        self.source.library_image().map(|(library, _)| library)
    }

    /// 引用的参考图；组内截图为 `None`。
    pub fn image_id(&self) -> Option<&str> {
        self.source.library_image().map(|(_, image)| image)
    }

    /// 资料库钉图对应的成员；截图钉图为 `None`。
    pub(super) fn from_pin(id: String, pin: &SavedPin) -> Option<GroupMember> {
        let PinContent::Reference {
            library_id,
            image_id,
            source_width,
            source_height,
        } = &pin.content
        else {
            return None;
        };
        Some(GroupMember {
            id,
            source: MemberSource::Library {
                library_id: library_id.clone(),
                image_id: image_id.clone(),
            },
            source_width: *source_width,
            source_height: *source_height,
            crop: pin.crop,
            placement: pin.placement,
        })
    }

    /// 截图钉图存成组内截图成员：截图尺寸，文件名由成员身份得出。
    pub(super) fn from_capture_pin(
        id: String,
        pin: &SavedPin,
        capture: &GroupCapture,
    ) -> GroupMember {
        GroupMember {
            source: MemberSource::Capture {
                capture_file: format!("{id}.png"),
            },
            id,
            source_width: capture.width,
            source_height: capture.height,
            crop: pin.crop,
            placement: pin.placement,
        }
    }

    /// 打开成员得到的钉图（不透明、不锁定）：资料库成员是参考图钉图，组内截图成员是截图历史中
    /// `capture_id` 这张截图的钉图。局部超出原图等不合法时为 `Err`。
    pub(super) fn pin(
        &self,
        pin_id: &str,
        group_id: &str,
        capture_id: &str,
    ) -> Result<SavedPin, CommandError> {
        let p = &self.placement;
        if !(p.scale.is_finite() && (MIN_SCALE..=MAX_SCALE).contains(&p.scale)) {
            return Err(CommandError::new(
                ErrorKind::GroupMemberScale {
                    member: self.id.clone(),
                },
                format!("成员 {} 的缩放不合法", self.id),
            ));
        }
        if p.rotation > 3 {
            return Err(CommandError::new(
                ErrorKind::GroupMemberRotation {
                    member: self.id.clone(),
                },
                format!("成员 {} 的旋转不合法", self.id),
            ));
        }
        let (library_id, image_id) = match &self.source {
            MemberSource::Library {
                library_id,
                image_id,
            } => (library_id.as_str(), image_id.clone()),
            MemberSource::Capture { capture_file } if valid_capture_file(capture_file) => {
                ("", String::new())
            }
            MemberSource::Capture { .. } => {
                return Err(CommandError::new(
                    ErrorKind::GroupMemberCaptureFile {
                        member: self.id.clone(),
                    },
                    format!("成员 {} 的截图文件名不合法", self.id),
                ));
            }
        };
        let image = ReferenceImage {
            id: image_id,
            width: self.source_width,
            height: self.source_height,
            sealed: false,
        };
        // 局部与尺寸的核对和参考图钉图相同；组内截图再换成截图钉图。
        let mut pin =
            SavedPin::reference(pin_id, library_id, &image, self.crop, *p).map_err(|e| {
                CommandError::caused_by(
                    e,
                    |cause| ErrorKind::GroupMemberPin {
                        member: self.id.clone(),
                        cause,
                    },
                    |e| format!("成员 {}：{e}", self.id),
                )
            })?;
        if let MemberSource::Capture { .. } = self.source {
            pin.content = PinContent::Capture {
                capture_id: capture_id.to_owned(),
            };
        }
        pin.member = Some(GroupMemberRef {
            group_id: group_id.to_owned(),
            member_id: self.id.clone(),
        });
        Ok(pin)
    }
}

/// 组内截图的文件名只用成员身份加 `.png`：不接受能跳出目录的字符。
pub(super) fn valid_capture_file(name: &str) -> bool {
    name.strip_suffix(".png").is_some_and(|stem| {
        !stem.is_empty()
            && stem
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    })
}

/// 存参考组时只存在参考组里的一张截图（#270）：截图历史中的文件与截图尺寸。
/// 由 [`crate::desktop::CaptureHistory::group_capture`] 给出。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupCapture {
    pub capture_id: String,
    pub file: PathBuf,
    pub width: u32,
    pub height: u32,
}
