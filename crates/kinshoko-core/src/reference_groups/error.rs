//! 参考组的错误。

use std::fmt;
use std::io;

use serde::Serialize;
use ts_rs::TS;

use super::UnavailableReason;
use crate::CommandError;
use crate::command_error::ErrorKind;

/// 导出参考组包时取不到原图的一个成员。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MemberUnavailable {
    /// 成员身份；整个资料库取不到时为 `None`。
    pub member: Option<String>,
    pub reason: UnavailableReason,
}

impl fmt::Display for MemberUnavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.member {
            Some(member) => write!(f, "成员 {member}：{}", self.reason),
            None => self.reason.fmt(f),
        }
    }
}

/// 参考组的错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupError {
    /// 读写参考组文件失败。
    Io(String),
    /// 没有这个参考组（或已删除）。
    UnknownGroup,
    /// 名称是空的。
    InvalidName,
    /// 没有可以存进参考组的钉图（截图要收藏，或选择只存在参考组里）。
    NoMembers,
    /// 文件由更新版本的 Kinshoko 写成，这一版读不懂。
    UnsupportedVersion(u32),
    /// 文件不是合法的参考组。
    Invalid(Box<CommandError>),
    /// 有成员此刻取不到原图，不能导出参考组包；逐个说明。
    MembersUnavailable(Vec<MemberUnavailable>),
    /// 文件不是 Kinshoko 参考组包。
    NotAPackage,
    /// 参考组包已损坏（原图缺失或与清单不符等）。
    PackageDamaged(Box<CommandError>),
    /// 资料库读写失败。
    Library(Box<CommandError>),
}

impl GroupError {
    /// 参考组文件不合要求：`kind` 是哪里不对，`text` 是它的中文说明。
    pub(crate) fn invalid(kind: ErrorKind, text: impl Into<String>) -> Self {
        GroupError::Invalid(Box::new(CommandError::new(kind, text)))
    }

    /// 参考组包已损坏。
    pub(crate) fn damaged(cause: impl Into<CommandError>) -> Self {
        GroupError::PackageDamaged(Box::new(cause.into()))
    }

    pub(crate) fn library(cause: impl Into<CommandError>) -> Self {
        GroupError::Library(Box::new(cause.into()))
    }
}

impl fmt::Display for GroupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GroupError::Io(e) => write!(f, "无法读写参考组：{e}"),
            GroupError::UnknownGroup => write!(f, "没有这个参考组，可能已被删除"),
            GroupError::InvalidName => write!(f, "参考组名称不能为空"),
            GroupError::NoMembers => {
                write!(
                    f,
                    "桌面上没有可以存进参考组的钉图；截图要收藏进资料库，或选择只存在参考组里"
                )
            }
            GroupError::UnsupportedVersion(v) => {
                write!(
                    f,
                    "参考组由更新版本的 Kinshoko 保存（格式版本 {v}），请升级后打开"
                )
            }
            GroupError::Invalid(why) => write!(f, "参考组文件已损坏：{why}"),
            GroupError::MembersUnavailable(members) => write!(
                f,
                "有成员取不到原图，无法导出参考组包：{}",
                members
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("；")
            ),
            GroupError::NotAPackage => write!(f, "这不是 Kinshoko 参考组包"),
            GroupError::PackageDamaged(why) => write!(f, "参考组包已损坏：{why}"),
            GroupError::Library(why) => write!(f, "{why}"),
        }
    }
}

impl std::error::Error for GroupError {}

impl From<io::Error> for GroupError {
    fn from(e: io::Error) -> Self {
        GroupError::Io(e.to_string())
    }
}
