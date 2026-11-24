//! 读写设置的错误。

use std::fmt;
use std::io;

#[derive(Debug)]
pub enum SettingsError {
    Io(io::Error),
    /// 标签外观的分档阈值不合要求，没有保存。
    TagThresholds,
}

// 不上界面：领域错误交给界面时转成错误代码（command_error），Display 只进日志
impl fmt::Display for SettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SettingsError::Io(e) => write!(f, "读写设置文件失败：{e}"),
            SettingsError::TagThresholds => {
                f.write_str("低档上限要小于高档下限，且都在 0 到 1 之间")
            }
        }
    }
}

impl std::error::Error for SettingsError {}

impl From<io::Error> for SettingsError {
    fn from(e: io::Error) -> Self {
        SettingsError::Io(e)
    }
}
