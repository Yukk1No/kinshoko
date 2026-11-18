//! 放慢请求（#366）：同一个订阅来源的相邻两次请求至少隔开一段时间，等待期间可以取消。
//!
//! 画师在界面里亲手发的请求（应用内浏览、查找画师，#461）排在后台检查前面：有手动请求在等时，
//! 后台检查让出下一个空档。缩略图走 CDN，不排这个队，只限同时进行的数量（[`Slots`]）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// 相邻两次请求的间隔。原型每次隔 1–1.5 秒没有遇到限流（#367），批量检查再放慢一些。
pub const API_GAP: Duration = Duration::from_secs(3);
pub const DOWNLOAD_GAP: Duration = Duration::from_secs(2);
/// 同时下载的缩略图最多几张。
pub const THUMBNAIL_SLOTS: usize = 4;

/// 等待时每隔多久看一次取消与排队情况。
const POLL: Duration = Duration::from_millis(50);

/// 谁发的请求。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    /// 后台检查。
    Background,
    /// 画师在界面里亲手发的请求，排在后台检查前面。
    Foreground,
}

#[derive(Debug, Default)]
struct Queue {
    last: Option<Instant>,
    /// 正在等的手动请求有几个。
    foreground_waiting: usize,
}

/// 一个请求节拍器。
#[derive(Debug)]
pub struct Pacer {
    gap: Duration,
    queue: Mutex<Queue>,
}

/// 手动请求离开等待（发出或取消）时减掉排队数。
struct Waiting<'a>(&'a Mutex<Queue>);

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        let mut queue = self.0.lock().unwrap_or_else(|e| e.into_inner());
        queue.foreground_waiting -= 1;
    }
}

impl Pacer {
    pub fn new(gap: Duration) -> Pacer {
        Pacer {
            gap,
            queue: Mutex::new(Queue::default()),
        }
    }

    /// 等到可以发下一个请求。`cancel` 置位时立即返回 `false`，不发请求。
    /// 后台请求在有手动请求排队时一直让着。
    pub fn wait(&self, priority: Priority, cancel: &AtomicBool) -> bool {
        let _waiting = (priority == Priority::Foreground).then(|| {
            self.lock().foreground_waiting += 1;
            Waiting(&self.queue)
        });
        loop {
            if cancel.load(Ordering::SeqCst) {
                return false;
            }
            let pause = {
                let mut queue = self.lock();
                let now = Instant::now();
                let ready = queue.last.map_or(now, |last| last + self.gap);
                let yielding = priority == Priority::Background && queue.foreground_waiting > 0;
                if now >= ready && !yielding {
                    queue.last = Some(now);
                    return true;
                }
                ready.saturating_duration_since(now).min(POLL)
            };
            std::thread::sleep(pause.max(Duration::from_millis(1)));
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 限制同时进行的请求数。
#[derive(Debug)]
pub struct Slots {
    max: usize,
    used: Mutex<usize>,
    freed: Condvar,
}

/// 占着的一个名额，放下时还回去。
pub struct Slot<'a>(&'a Slots);

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        *self.0.used.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        self.0.freed.notify_one();
    }
}

impl Slots {
    pub fn new(max: usize) -> Slots {
        Slots {
            max,
            used: Mutex::new(0),
            freed: Condvar::new(),
        }
    }

    /// 等到有空名额。`cancel` 置位时为空。
    pub fn take(&self, cancel: &AtomicBool) -> Option<Slot<'_>> {
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if cancel.load(Ordering::SeqCst) {
                return None;
            }
            if *used < self.max {
                *used += 1;
                return Some(Slot(self));
            }
            used = self
                .freed
                .wait_timeout(used, POLL)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
}

/// 一个订阅来源共用的节拍：检查线程与界面里的浏览、查找画师、读关注排同一个队，不会叠在一起加快。
#[derive(Debug)]
pub struct Pacers {
    pub(crate) api: Pacer,
    pub(crate) download: Pacer,
    /// 应用内浏览的缩略图（#461）。
    pub thumbnails: Slots,
}

impl Default for Pacers {
    fn default() -> Self {
        Pacers {
            api: Pacer::new(API_GAP),
            download: Pacer::new(DOWNLOAD_GAP),
            thumbnails: Slots::new(THUMBNAIL_SLOTS),
        }
    }
}

impl Pacers {
    /// 等到可以发下一个接口请求；见 [`Pacer::wait`]。
    pub(crate) fn api(&self, priority: Priority, cancel: &AtomicBool) -> bool {
        self.api.wait(priority, cancel)
    }

    /// 等到可以下载下一张原图；见 [`Pacer::wait`]。
    pub fn download(&self, priority: Priority, cancel: &AtomicBool) -> bool {
        self.download.wait(priority, cancel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn requests_are_spaced_by_the_gap() {
        let pacer = Pacer::new(Duration::from_millis(80));
        let cancel = AtomicBool::new(false);
        let start = Instant::now();
        assert!(pacer.wait(Priority::Background, &cancel));
        assert!(start.elapsed() < Duration::from_millis(40));
        assert!(pacer.wait(Priority::Background, &cancel));
        assert!(start.elapsed() >= Duration::from_millis(80));
    }

    #[test]
    fn cancel_stops_the_wait_without_a_request() {
        let pacer = Pacer::new(Duration::from_secs(60));
        let cancel = AtomicBool::new(false);
        assert!(pacer.wait(Priority::Foreground, &cancel));
        cancel.store(true, Ordering::SeqCst);
        assert!(!pacer.wait(Priority::Foreground, &cancel));
        // 取消的手动请求不再占着队，后台请求不会一直让下去。
        assert_eq!(pacer.lock().foreground_waiting, 0);
    }

    #[test]
    fn foreground_requests_go_before_waiting_background_ones() {
        let pacer = Arc::new(Pacer::new(Duration::from_millis(150)));
        let cancel = Arc::new(AtomicBool::new(false));
        assert!(pacer.wait(Priority::Background, &cancel));
        let order = Arc::new(Mutex::new(Vec::new()));
        let spawn = |priority, delay| {
            let (pacer, cancel, order) = (pacer.clone(), cancel.clone(), order.clone());
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(delay));
                assert!(pacer.wait(priority, &cancel));
                order.lock().unwrap().push(priority);
            })
        };
        // 后台请求先开始等，手动请求晚一点来，仍然先发。
        let background = spawn(Priority::Background, 0);
        let foreground = spawn(Priority::Foreground, 40);
        background.join().unwrap();
        foreground.join().unwrap();
        assert_eq!(
            *order.lock().unwrap(),
            [Priority::Foreground, Priority::Background]
        );
    }

    #[test]
    fn slots_limit_concurrent_requests() {
        let slots = Slots::new(2);
        let cancel = AtomicBool::new(false);
        let a = slots.take(&cancel).unwrap();
        let _b = slots.take(&cancel).unwrap();
        cancel.store(true, Ordering::SeqCst);
        assert!(slots.take(&cancel).is_none());
        cancel.store(false, Ordering::SeqCst);
        drop(a);
        assert!(slots.take(&cancel).is_some());
    }
}
