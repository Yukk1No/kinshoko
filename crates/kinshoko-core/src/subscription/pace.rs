//! 放慢请求（#366）：同一个订阅来源的相邻两次请求至少隔开一段时间，等待期间可以取消。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// 相邻两次请求的间隔。原型每次隔 1–1.5 秒没有遇到限流（#367），批量检查再放慢一些。
pub const API_GAP: Duration = Duration::from_secs(3);
pub const DOWNLOAD_GAP: Duration = Duration::from_secs(2);

/// 一个请求节拍器。
#[derive(Debug)]
pub struct Pacer {
    gap: Duration,
    last: Option<Instant>,
}

impl Pacer {
    pub fn new(gap: Duration) -> Pacer {
        Pacer { gap, last: None }
    }

    /// 等到可以发下一个请求。`cancel` 置位时立即返回 `false`，不发请求。
    pub fn wait(&mut self, cancel: &AtomicBool) -> bool {
        if let Some(last) = self.last {
            let ready = last + self.gap;
            while Instant::now() < ready {
                if cancel.load(Ordering::SeqCst) {
                    return false;
                }
                let left = ready.saturating_duration_since(Instant::now());
                std::thread::sleep(left.min(Duration::from_millis(100)));
            }
        }
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        self.last = Some(Instant::now());
        true
    }
}
