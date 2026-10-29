//! 打开资料库、首屏等步骤的耗时（#313）：core 里没有运行日志，由应用壳在启动时接上去。
//! 没接上（测试、命令行工具）时什么也不做。

use std::sync::OnceLock;
use std::time::Instant;

use super::LogEvent;

static SINK: OnceLock<fn(LogEvent)> = OnceLock::new();

/// 把耗时记录交给 `sink`（应用壳的运行日志）。只有第一次调用生效。
pub fn set_timing_sink(sink: fn(LogEvent)) {
    let _ = SINK.set(sink);
}

/// 同 [`took`]，但只记用了 20 毫秒以上的：常被调用、平常很快的步骤只在慢的时候留痕。
pub fn took_if_slow(step: &'static str, started: Instant, count: Option<usize>) {
    if started.elapsed().as_millis() >= 20 {
        took(step, started, count);
    }
}

/// 记下 `step` 从 `started` 到现在用了多久；`count` 是这一步处理了多少项（张数、行数）。
pub fn took(step: &'static str, started: Instant, count: Option<usize>) {
    if let Some(sink) = SINK.get() {
        sink(LogEvent::Took {
            step,
            ms: started.elapsed().as_millis().min(u32::MAX as u128) as u32,
            count: count.map(|n| n.min(u32::MAX as usize) as u32),
        });
    }
}

/// 等锁、持锁这么久以上才记（#337）。
const LOCK_LOG_MS: u128 = 100;

/// 拿着一把锁的这段时间（#337）：取到时等了 100 毫秒以上就记一条“等锁”，放开时拿了 100 毫秒以上
/// 就记一条“持锁”，都带取锁处的源文件名（不含目录）与行号，用来查谁让别人排队。只有超过门槛时才
/// 写一行日志，平常不多占锁。
pub struct HeldLock {
    lock: &'static str,
    site: &'static std::panic::Location<'static>,
    since: Instant,
}

impl HeldLock {
    /// `waiting` 是开始等这把锁的时刻。
    pub fn acquired(
        lock: &'static str,
        site: &'static std::panic::Location<'static>,
        waiting: Instant,
    ) -> HeldLock {
        let waited = waiting.elapsed().as_millis();
        if waited >= LOCK_LOG_MS
            && let Some(sink) = SINK.get()
        {
            sink(LogEvent::LockWaited {
                lock,
                at: file_stem(site),
                line: site.line(),
                ms: waited.min(u32::MAX as u128) as u32,
            });
        }
        HeldLock {
            lock,
            site,
            since: Instant::now(),
        }
    }
}

impl Drop for HeldLock {
    fn drop(&mut self) {
        let held = self.since.elapsed().as_millis();
        if held >= LOCK_LOG_MS
            && let Some(sink) = SINK.get()
        {
            sink(LogEvent::LockHeld {
                lock: self.lock,
                at: file_stem(self.site),
                line: self.site.line(),
                ms: held.min(u32::MAX as u128) as u32,
            });
        }
    }
}

/// 源文件名，不带目录与扩展名：日志里不出现路径。
fn file_stem(site: &'static std::panic::Location<'static>) -> &'static str {
    std::path::Path::new(site.file())
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("?")
}
