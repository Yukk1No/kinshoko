//! 按需取得可写句柄与等导入收尾（ADR-0008）。

use super::*;

/// 整理要等导入收尾时给画师的轻提示（#112）：要整理的库，以及正在收尾的库名。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OrganizeWaiting {
    pub library_id: String,
    pub finishing: Vec<String>,
}

/// 按需取得可写句柄的结果（ADR-0008）。
pub enum WriterAccess {
    /// 可以整理了。`switched` 为真表示这次把唯一的可写句柄切到了这个库，调用方据此装配它。
    Ready {
        library: Arc<Library>,
        switched: bool,
    },
    /// 目标库或当前持有者有导入在收尾：放开登记表的锁，[`ImportFinishWait::wait`] 后重新请求。
    Waiting(ImportFinishWait),
}

/// 导入收尾结束的通知；每次收尾结束、回执关闭或取消登记都前进一代。
#[derive(Default)]
pub(super) struct FinishSignal {
    generation: Mutex<u64>,
    changed: Condvar,
}

impl FinishSignal {
    pub(super) fn current(&self) -> u64 {
        *self.generation.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(super) fn advance(&self) {
        *self.generation.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        self.changed.notify_all();
    }
}

/// 一次等待：持有它时不持有登记表的锁。
pub struct ImportFinishWait {
    pub notice: OrganizeWaiting,
    pub(super) signal: Arc<FinishSignal>,
    pub(super) seen: u64,
}

impl ImportFinishWait {
    /// 等到有导入收尾结束，最多 `timeout`；返回后调用方重新请求，不假定已经可以整理。
    pub fn wait(&self, timeout: Duration) {
        let generation = self
            .signal
            .generation
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _ = self
            .signal
            .changed
            .wait_timeout_while(generation, timeout, |generation| *generation == self.seen);
    }
}

/// 按需取可写句柄、等导入收尾时的结果错误（#112 的等待上限）。
#[derive(Debug)]
pub enum WriterWaitError<E> {
    /// 请求本身失败（未登记、不可用……）。
    Request(E),
    /// 等到上限，收尾仍没有结束：这次整理没有执行。
    TimedOut(OrganizeWaiting),
}

impl<E: fmt::Display> fmt::Display for WriterWaitError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Request(error) => error.fmt(f),
            Self::TimedOut(notice) => {
                let names = notice
                    .finishing
                    .iter()
                    .map(|name| format!("「{name}」"))
                    .collect::<Vec<_>>()
                    .join("、");
                write!(f, "{names}的导入一直没有收尾，这次整理没有执行，请稍后再试")
            }
        }
    }
}

impl<E: fmt::Debug + fmt::Display> std::error::Error for WriterWaitError<E> {}

/// 取得要整理的库的可写句柄（ADR-0008）：`request` 每次都重新请求（通常是加锁后调用
/// [`DeviceLibraries::organize`]，等待期间不持有锁）。要等导入收尾时只调用一次 `hint`（轻提示），
/// 每次最多等 `recheck` 再重新请求；总共等到 `limit` 仍要等待时放弃，返回
/// [`WriterWaitError::TimedOut`]，界面报告这次整理没有执行，请求不会永远挂着。
pub fn wait_for_writer<E>(
    mut request: impl FnMut() -> Result<WriterAccess, E>,
    mut hint: impl FnMut(&OrganizeWaiting),
    recheck: Duration,
    limit: Duration,
) -> Result<Arc<Library>, WriterWaitError<E>> {
    let deadline = Instant::now() + limit;
    let mut hinted = false;
    loop {
        match request().map_err(WriterWaitError::Request)? {
            WriterAccess::Ready { library, .. } => return Ok(library),
            WriterAccess::Waiting(wait) => {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(WriterWaitError::TimedOut(wait.notice));
                }
                if !hinted {
                    hinted = true;
                    hint(&wait.notice);
                }
                wait.wait(recheck.min(left));
            }
        }
    }
}
