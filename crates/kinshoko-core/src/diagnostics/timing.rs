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
