//! 参考组的错误。

use std::fmt;
use std::io;

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
    Invalid(String),
    /// 有成员此刻取不到原图，不能导出参考组包；逐个说明。
    MembersUnavailable(Vec<String>),
    /// 文件不是 Kinshoko 参考组包。
    NotAPackage,
    /// 参考组包已损坏（原图缺失或与清单不符等）。
    PackageDamaged(String),
    /// 资料库读写失败。
    Library(String),
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
                members.join("；")
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
