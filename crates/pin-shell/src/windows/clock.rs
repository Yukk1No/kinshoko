//! 合成器时钟线程：替界面线程等合成器。
//!
//! 换窗要等合成器收下备用槽的 Present 与摆放，原型在界面线程上 `DwmFlush`，一次 4～30 ms。这里
//! 改到自己的线程：收到请求后记下 DWM 的帧计数，`DwmFlush` 到下一次合成，确认帧计数往前走了，
//! 再给宿主窗口投一条消息，界面线程收到后一次 `Commit` 换上。请求是开始等之前收到的，所以报出的
//! 序号及以前的请求都已被收下。另有定时投递（换下的槽过两个刷新周期再收起）。

use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::Graphics::Dwm::{DWM_TIMING_INFO, DwmFlush, DwmGetCompositionTimingInfo};
use windows::Win32::UI::WindowsAndMessaging::PostMessageW;

enum Job {
    /// 等下一次合成，然后投 `composed` 消息，`wParam` 为序号。
    Composition(u64),
    /// 到时投这条消息。
    At(Instant, u32),
}

pub(super) struct Clock {
    tx: Option<Sender<Job>>,
    thread: Option<JoinHandle<()>>,
}

impl Clock {
    /// `target` 是收消息的宿主窗口，`composed` 是“合成器已收下”的消息号。
    pub fn start(target: HWND, composed: u32) -> Clock {
        let (tx, rx) = channel();
        let target = target.0 as isize;
        let thread = std::thread::Builder::new()
            .name("pin-shell clock".into())
            .spawn(move || run(rx, target, composed))
            .ok();
        Clock {
            tx: Some(tx),
            thread,
        }
    }

    pub fn after_composition(&self, ticket: u64) {
        self.send(Job::Composition(ticket));
    }

    pub fn at(&self, when: Instant, msg: u32) {
        self.send(Job::At(when, msg));
    }

    fn send(&self, job: Job) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(job);
        }
    }
}

impl Clock {
    /// 停下线程并等它退出；之后不再投消息。可以调多次。
    pub fn stop(&mut self) {
        self.tx = None;
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Clock {
    fn drop(&mut self) {
        self.stop();
    }
}

fn post(target: isize, msg: u32, wp: usize) {
    // SAFETY：只投递消息，不解引用句柄；窗口已销毁时投递失败，忽略。
    unsafe {
        let _ = PostMessageW(Some(HWND(target as *mut _)), msg, WPARAM(wp), LPARAM(0));
    }
}

/// DWM 已合成的帧数；读不到为 None。
fn frame() -> Option<u64> {
    let mut info = DWM_TIMING_INFO {
        cbSize: std::mem::size_of::<DWM_TIMING_INFO>() as u32,
        ..Default::default()
    };
    // SAFETY：`info` 由本函数持有，`cbSize` 已填；空句柄表示整个桌面的合成。
    unsafe { DwmGetCompositionTimingInfo(HWND::default(), &mut info) }.ok()?;
    Some(info.cFrame)
}

fn wait_for_composition() {
    let start = frame();
    for _ in 0..3 {
        // SAFETY：无参数；只阻塞本线程到下一次合成。
        if unsafe { DwmFlush() }.is_err() {
            return;
        }
        match (start, frame()) {
            (Some(a), Some(b)) if b > a => return,
            (None, _) | (_, None) => return,
            _ => {}
        }
    }
}

fn run(rx: Receiver<Job>, target: isize, composed: u32) {
    let mut timers: Vec<(Instant, u32)> = Vec::new();
    let mut ticket: Option<u64> = None;
    loop {
        let job = match timers.iter().map(|t| t.0).min() {
            Some(next) => rx.recv_timeout(next.saturating_duration_since(Instant::now())),
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match job {
            Ok(Job::Composition(t)) => ticket = Some(ticket.map_or(t, |old| old.max(t))),
            Ok(Job::At(when, msg)) => timers.push((when, msg)),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        // 一次把排着的请求都收下，再开始等。
        while let Ok(job) = rx.try_recv() {
            match job {
                Job::Composition(t) => ticket = Some(ticket.map_or(t, |old| old.max(t))),
                Job::At(when, msg) => timers.push((when, msg)),
            }
        }
        let now = Instant::now();
        timers.retain(|&(when, msg)| {
            if when <= now {
                post(target, msg, 0);
                false
            } else {
                true
            }
        });
        if let Some(t) = ticket.take() {
            wait_for_composition();
            post(target, composed, t as usize);
        }
    }
}

/// 一个刷新周期（读不到时按 60 Hz）。
pub(super) fn refresh_period() -> Duration {
    let mut info = DWM_TIMING_INFO {
        cbSize: std::mem::size_of::<DWM_TIMING_INFO>() as u32,
        ..Default::default()
    };
    let mut freq = 0i64;
    // SAFETY：两个出参都由本函数持有。
    let ok = unsafe {
        DwmGetCompositionTimingInfo(HWND::default(), &mut info).is_ok()
            && windows::Win32::System::Performance::QueryPerformanceFrequency(&mut freq).is_ok()
    };
    if ok && info.qpcRefreshPeriod > 0 && freq > 0 {
        Duration::from_secs_f64(info.qpcRefreshPeriod as f64 / freq as f64)
    } else {
        Duration::from_micros(16_667)
    }
}
