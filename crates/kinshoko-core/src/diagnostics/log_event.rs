//! 运行日志能写的内容（#219）。
//!
//! 只有三种值进得来：数量与耗时、代码里写死的文字（`&'static str`），以及 [`Detail`]——它唯一的
//! 构造函数先经 [`scrub`] 去掉路径与文件名。资料库只写 [`LibraryNo`] 编号，标签只写数量。
//! 所以文件名、路径、标签文字与图片从类型上就写不进日志：
//!
//! ```compile_fail
//! use kinshoko_core::diagnostics::{Detail, Level, LogEvent};
//! let path = std::path::PathBuf::from(r"C:\Users\画师\参考.png");
//! // 运行时拼出来的字符串不是 `&'static str`，也不是 `Detail`。
//! let _ = LogEvent::Problem { level: Level::Error, site: &path.display().to_string(), detail: Detail::new("") };
//! ```
//!
//! ```compile_fail
//! use kinshoko_core::diagnostics::Detail;
//! // 没有不经脱敏的构造方式。
//! let _ = Detail(r"C:\Users\画师\参考.png".to_owned());
//! ```

use std::fmt::Display;

use serde::{Deserialize, Serialize};

use super::scrub;
use crate::tagging::Device;

/// 一条记录的级别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Error,
    Warn,
    Info,
}

/// 一段说明错误的文字，已去掉路径与文件名。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Detail(String);

/// 一条说明最多留这么多字，防止一条错误占满日志。
const DETAIL_CHARS: usize = 1000;

impl Detail {
    /// 经 [`scrub`]：像路径或带扩展名的文件名的部分连同其后的文字换成 `<路径>`。
    pub fn new(text: impl Display) -> Detail {
        Detail(
            scrub(&text.to_string())
                .chars()
                .take(DETAIL_CHARS)
                .collect(),
        )
    }
}

/// 资料库在本设备登记表里的编号，从 1 起，写作“资料库 #n”。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LibraryNo(usize);

impl LibraryNo {
    /// 登记表里从 0 起的位置。
    pub fn from_index(index: usize) -> LibraryNo {
        LibraryNo(index + 1)
    }
}

impl Serialize for LibraryNo {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(&format_args!("资料库 #{}", self.0))
    }
}

/// 记下创建与隐藏的窗口。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowKind {
    Main,
    /// 截图的框选窗口。
    Capture,
    PinMenu,
}

/// 钉图从哪里来。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PinSource {
    Clipboard,
    /// 截图历史。
    Capture,
    /// 资料库里的参考图。
    Reference,
}

/// 打标暂停的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PauseReason {
    /// 画师点了暂停。
    Artist,
    /// 有全屏程序或“请勿打扰”在前台，自动让出（#212）。
    FullScreen,
}

/// 运行日志里的一件事。只能带数量、耗时、编号与 [`Detail`]。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LogEvent {
    AppStarted {
        version: &'static str,
    },
    MainWindowOpened,
    WindowCreated {
        window: WindowKind,
        ms: u32,
    },
    WindowHidden {
        window: WindowKind,
    },
    WindowClosed {
        window: WindowKind,
    },
    ImportStarted {
        library: Option<LibraryNo>,
        paths: u32,
    },
    SearchResolved {
        terms: u32,
    },
    CaptureStarted,
    /// 框选完成后的收尾（复制、钉图或存入资料库）用了多久。
    CaptureFinished {
        ms: u32,
    },
    /// 钉住一张图用了多久。
    Pinned {
        from: PinSource,
        ms: u32,
    },
    PinsHidden,
    TaggingStarted {
        library: Option<LibraryNo>,
        device: Device,
    },
    TaggingPaused {
        reason: PauseReason,
    },
    TaggingResumed,
    /// 没有待打标的图了；`tagged` 是本次运行打过的张数，`ms` 从开始打标算起。
    TaggingFinished {
        tagged: u32,
        ms: u64,
    },
    /// 出错，稍后自动重试。
    TaggingFailed {
        detail: Detail,
    },
    /// 本机条件不满足任何模型。
    TaggingUnavailable {
        detail: Detail,
    },
    /// 打标子进程探测到的显卡与显存额度。
    VramBudget {
        gpu: Detail,
        budget_mb: u64,
    },
    /// 打标子进程写到标准错误的一行（运行库的警告、崩溃信息）。
    TaggerOutput {
        detail: Detail,
    },
    /// 打开资料库、首屏等一步用了多久（#313）；`step` 是代码里写死的步骤名，`count` 是处理了多少项。
    Took {
        step: &'static str,
        ms: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        count: Option<u32>,
    },
    /// 应用壳里的错误或警告；`site` 是代码里写死的出错位置。
    Problem {
        #[serde(skip)]
        level: Level,
        site: &'static str,
        detail: Detail,
    },
    /// 界面里没有接住的错误。
    Frontend {
        #[serde(skip)]
        level: Level,
        detail: Detail,
    },
}

impl LogEvent {
    pub fn level(&self) -> Level {
        match self {
            LogEvent::Problem { level, .. } | LogEvent::Frontend { level, .. } => *level,
            LogEvent::TaggingFailed { .. }
            | LogEvent::TaggingUnavailable { .. }
            | LogEvent::TaggerOutput { .. } => Level::Warn,
            _ => Level::Info,
        }
    }
}
