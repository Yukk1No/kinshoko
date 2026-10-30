//! 交给界面的错误（#355）：错误代码＋参数，文字由前端按界面语言取。
//!
//! 命令层返回 [`CommandError`]，不再把错误压成中文句子；前端按 `code` 判断错误种类、取对应文案。
//! 领域里各错误类型的 `Display` 仍是中文，只用于日志与还没有错误代码的地方。

use std::fmt;

use serde::Serialize;

use crate::backup::BackupError;
use crate::desktop::{CaptureError, HistoryError, PinError};
use crate::reference_groups::{GroupError, UnavailableReason};
use crate::tag_catalog::CatalogError;
use crate::{
    DeviceLibraryError, SettingsError, ShortcutError, UiScaleError, WriterWaitError, library,
};

mod domain;
mod kind;

pub use kind::ErrorKind;

/// 命令层返回给界面的错误：序列化时只有错误代码与参数（[`ErrorKind`]），
/// `Display` 是原来的中文说明，用于日志和拼进别的说明里。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandError {
    pub kind: ErrorKind,
    text: String,
}

impl CommandError {
    /// 还没有错误代码的错误，按原样显示 `message`。
    pub fn message(message: impl fmt::Display) -> Self {
        let text = message.to_string();
        CommandError {
            kind: ErrorKind::Message {
                message: text.clone(),
            },
            text,
        }
    }

    /// 带代码的错误；`text` 是日志里（以及拼进钉图提示等 Rust 自己写的话里）的中文说明。
    pub fn new(kind: ErrorKind, text: impl Into<String>) -> Self {
        CommandError {
            kind,
            text: text.into(),
        }
    }

    /// 包着下层原因的错误：`wrap` 用原因的代码做出这一层的代码，`text` 用原因的中文说明写出这一层的说明。
    pub fn wrapping(
        self,
        wrap: impl FnOnce(Box<ErrorKind>) -> ErrorKind,
        text: impl FnOnce(&str) -> String,
    ) -> Self {
        let text = text(&self.text);
        CommandError {
            kind: wrap(Box::new(self.kind)),
            text,
        }
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

impl std::error::Error for CommandError {}

impl Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.kind.serialize(serializer)
    }
}

impl From<String> for CommandError {
    fn from(message: String) -> Self {
        CommandError::message(message)
    }
}

impl From<&str> for CommandError {
    fn from(message: &str) -> Self {
        CommandError::message(message)
    }
}

/// 系统与底层库的错误还没有错误代码，按原样显示。
macro_rules! from_foreign_error {
    ($($error:ty),* $(,)?) => {$(
        impl From<$error> for CommandError {
            fn from(e: $error) -> Self {
                CommandError::message(e)
            }
        }
    )*};
}

from_foreign_error!(std::io::Error, serde_json::Error, image::ImageError);

/// 领域错误连同它的中文说明一起转过来。
macro_rules! from_domain_error {
    ($($error:ty),* $(,)?) => {$(
        impl From<$error> for CommandError {
            fn from(e: $error) -> Self {
                let text = e.to_string();
                CommandError { kind: e.into(), text }
            }
        }
    )*};
}

from_domain_error!(
    library::Error,
    DeviceLibraryError,
    CatalogError,
    GroupError,
    BackupError,
    SettingsError,
    ShortcutError,
    UiScaleError,
    CaptureError,
    HistoryError,
    PinError,
);

impl<E: Into<ErrorKind> + fmt::Display> From<WriterWaitError<E>> for CommandError {
    fn from(e: WriterWaitError<E>) -> Self {
        let text = e.to_string();
        CommandError {
            kind: e.into(),
            text,
        }
    }
}

/// 钉图、截图要用的参考图此刻取不到。
impl From<UnavailableReason> for CommandError {
    fn from(reason: UnavailableReason) -> Self {
        let text = reason.to_string();
        CommandError {
            kind: ErrorKind::CaptureSourceUnavailable { reason },
            text,
        }
    }
}

impl From<CommandError> for ErrorKind {
    fn from(e: CommandError) -> Self {
        e.kind
    }
}

#[cfg(test)]
mod tests;
