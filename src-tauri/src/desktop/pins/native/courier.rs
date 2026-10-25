//! 跑腿线程：替界面线程等时间、等锁。
//!
//! - 平台层有新输入（在界面线程上、平台层的方法里通知）：在这里转投 `run_on_main_thread`。在主线程上
//!   调 `run_on_main_thread` 会就地执行，重入平台层；从别的线程调才排进事件循环；
//! - 渲染层的回报同样经这里排进事件循环；
//! - 手势到时：等到 [`super::Orchestra::next_deadline`] 再请界面线程收尾；
//! - 编排的结果：写 `pins.json`、走应用的关闭流程、写运行日志。

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{RecvTimeoutError, Sender, channel};
use std::time::Instant;

use tauri::AppHandle;

use super::host;
use super::orchestra::Effect;
use super::port::RenderEvent;
use crate::desktop::{lock, state};

pub enum Job {
    /// 平台层有输入排着。
    Wake,
    /// 最早的手势结束时刻（`None`：没有手势）。
    Deadline(Option<Instant>),
    Render(RenderEvent),
    Effect(Effect),
}

static COURIER: OnceLock<Sender<Job>> = OnceLock::new();
/// 已经请界面线程取输入、还没取：不重复请。
static PUMP_QUEUED: AtomicBool = AtomicBool::new(false);

/// 任意线程调用；第一次调用时起跑腿线程。
pub fn send(app: &AppHandle, job: Job) {
    let tx = COURIER.get_or_init(|| {
        let (tx, rx) = channel();
        let app = app.clone();
        std::thread::Builder::new()
            .name("pin-courier".into())
            .spawn(move || {
                let mut deadline: Option<Instant> = None;
                loop {
                    let job = match deadline {
                        Some(at) => rx.recv_timeout(at.saturating_duration_since(Instant::now())),
                        None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
                    };
                    match job {
                        Ok(Job::Deadline(at)) => deadline = at,
                        Ok(job) => run(&app, job),
                        Err(RecvTimeoutError::Timeout) => {
                            deadline = None;
                            host::post_existing(&app, |o| o.tick(Instant::now()));
                        }
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
            })
            .expect("建钉图跑腿线程");
        tx
    });
    let _ = tx.send(job);
}

fn run(app: &AppHandle, job: Job) {
    match job {
        Job::Wake => {
            if !PUMP_QUEUED.swap(true, Ordering::AcqRel) {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    PUMP_QUEUED.store(false, Ordering::Release);
                    host::with_existing(&handle, |o| o.pump(Instant::now()));
                });
            }
        }
        Job::Render(event) => {
            host::post_existing(app, move |o| o.render_event(event, Instant::now()));
        }
        Job::Effect(effect) => apply(app, effect),
        Job::Deadline(_) => {}
    }
}

fn apply(app: &AppHandle, effect: Effect) {
    match effect {
        Effect::Saved(pin) => {
            // 收起着的钉图只改了透明度：内容还在细边那里。
            let tucked = lock(&state(app).edge).is_hidden(&pin.id);
            if let Some(r) = lock(&state(app).pins).get_mut(&pin.id)
                && !tucked
            {
                r.content = pin.rect();
            }
            super::super::edit(app, &pin.id.clone(), |p| *p = pin);
        }
        Effect::Shown(pin) => {
            if let Some(r) = lock(&state(app).pins).get_mut(&pin) {
                r.shown = true;
            }
            super::super::stop_waiting(app, &pin);
        }
        Effect::CloseRequested(pin) => super::super::close(app, &pin),
        Effect::Menu(pin) => super::super::native_menu(app, &pin),
        Effect::Released(pin) => {
            lock(&state(app).edge).release(&pin);
            if let Some(r) = lock(&state(app).pins).get_mut(&pin) {
                r.click_through = false;
            }
        }
        Effect::Closed(_) => {}
        Effect::Failed(pin) => {
            super::super::stop_waiting(app, &pin);
            super::super::closed(app, &pin);
        }
        Effect::Warn(site, detail) => crate::run_log::warn(site, detail),
    }
}
