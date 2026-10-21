//! 把打标的状态变化折成运行日志里的事件（#219）。只记开始、结束、出错与不可用；
//! 张数增加、下载进度这类变化不记。暂停由暂停的一方记下原因（[`PauseReason`]）。
//!
//! [`PauseReason`]: crate::diagnostics::PauseReason

use std::time::Instant;

use super::scheduler::TaggingStatus;
use crate::diagnostics::{Detail, LibraryNo, LogEvent};

/// 一个资料库的打标在运行日志里的记录者。
#[derive(Debug)]
pub struct TaggingLog {
    library: Option<LibraryNo>,
    /// 正在打标时，这一轮从什么时候开始。
    run_started: Option<Instant>,
    /// 上次记下的出错或不可用原因，同一原因不重复记。
    last_problem: Option<String>,
}

impl TaggingLog {
    pub fn new(library: Option<LibraryNo>) -> TaggingLog {
        TaggingLog {
            library,
            run_started: None,
            last_problem: None,
        }
    }

    /// 看到新的状态；需要记下时返回事件。
    pub fn observe(&mut self, status: &TaggingStatus, now: Instant) -> Option<LogEvent> {
        match status {
            TaggingStatus::Running { device, .. } => {
                self.last_problem = None;
                if self.run_started.is_some() {
                    return None;
                }
                self.run_started = Some(now);
                Some(LogEvent::TaggingStarted {
                    library: self.library,
                    device: *device,
                })
            }
            TaggingStatus::Idle { tagged, .. } => {
                let started = self.run_started.take()?;
                Some(LogEvent::TaggingFinished {
                    tagged: *tagged,
                    ms: now.saturating_duration_since(started).as_millis() as u64,
                })
            }
            TaggingStatus::Failed { reason } => {
                self.run_started = None;
                self.problem(reason)
                    .map(|detail| LogEvent::TaggingFailed { detail })
            }
            TaggingStatus::NoDevice { reason } => {
                self.run_started = None;
                self.problem(reason)
                    .map(|detail| LogEvent::TaggingUnavailable { detail })
            }
            TaggingStatus::Paused => {
                self.run_started = None;
                None
            }
            TaggingStatus::Starting
            | TaggingStatus::NeedsDownload { .. }
            | TaggingStatus::Downloading { .. }
            | TaggingStatus::Preparing { .. } => None,
        }
    }

    fn problem(&mut self, reason: &str) -> Option<Detail> {
        if self.last_problem.as_deref() == Some(reason) {
            return None;
        }
        self.last_problem = Some(reason.to_owned());
        Some(Detail::new(reason))
    }
}
