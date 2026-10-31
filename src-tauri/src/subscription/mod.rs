//! 订阅（#368）：定时检查线程、pixiv 登录窗口、托盘上的新图数量。领域逻辑在
//! `kinshoko_core::subscription`。
//!
//! - 只在设置里的订阅开关开着、有订阅、已登录时联网；关掉开关立即取消正在进行的检查。
//! - 检查线程按 `schedule` 睡到下一条订阅到期；退出期间错过的检查，重新打开后补上。
//! - 功能跨 #368–#371 几个 PR，最后一个合并前只在设了 `KINSHOKO_SUBSCRIPTIONS=1` 时出现：
//!   没设时不建线程、不打开订阅记录、不联网，命令一律报不可用。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use kinshoko_core::command_error::CommandError;
use kinshoko_core::library::{SaveDestination, SubscriptionPage};
use kinshoko_core::subscription::pixiv::{LoginRequest, LoginState, PixivAccount, PixivSource};
use kinshoko_core::subscription::{
    Destination, ReceivedImage, SourceError, SourceId, Store, Subscription, SubscriptionStatus,
    check, schedule,
};
use tauri::{AppHandle, Emitter, Listener, Manager, State};

use crate::shell::ShellState;

mod badge;
pub mod login;

pub use badge::badge;
use login::{LOGIN_WINDOW, remove_login_profile};

/// 订阅状态变了（检查开始或结束、登录变化、新图数量变化），载荷为 [`SubscriptionStatus`]。
const STATUS_EVENT: &str = "subscription-status";
/// 功能还没做完时，设了它才出现（见模块说明）。
const PREVIEW_ENV: &str = "KINSHOKO_SUBSCRIPTIONS";
/// 没有更早到期的订阅时也隔这么久醒一次，防止系统休眠或改时间后睡过头。
const MAX_SLEEP: Duration = Duration::from_secs(60 * 60);
/// 订阅页“最近收进来的图”最多列这么多张。
const RECENT_LIMIT: u32 = 200;

/// 订阅功能这一版是否出现。
pub fn available() -> bool {
    std::env::var(PREVIEW_ENV).is_ok_and(|v| v == "1")
}

#[derive(Default)]
struct Wake {
    /// 有新情况（开关、登录、立即检查）：检查线程马上重新判断。
    pending: bool,
    /// 立即检查：不论是否到期，每条订阅查一次（退避中仍不查）。
    check_all: bool,
}

pub struct SubscriptionState {
    store: Arc<Store>,
    account: Arc<PixivAccount>,
    /// 订阅数据目录：订阅记录、pixiv 登录与登录窗口的 WebView2 数据。
    dir: PathBuf,
    wake: Mutex<Wake>,
    signal: Condvar,
    /// 关掉订阅开关或退出登录时置位，正在进行的检查在下一个请求前停下。
    cancel: Arc<AtomicBool>,
    checking: AtomicBool,
    login: Mutex<Option<Arc<LoginRequest>>>,
}

impl SubscriptionState {
    fn poke(&self, check_all: bool) {
        let mut wake = self.wake.lock().unwrap_or_else(|e| e.into_inner());
        wake.pending = true;
        wake.check_all |= check_all;
        self.signal.notify_all();
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn enabled(app: &AppHandle) -> bool {
    app.state::<ShellState>()
        .0
        .lock()
        .map(|shell| shell.settings.subscriptions())
        .unwrap_or(false)
}

/// 启动时：功能出现时打开订阅记录、开始检查线程，并跟着安全模式更新托盘上的数量。
pub fn manage(app: &AppHandle) {
    if !available() {
        return;
    }
    let dir = crate::data_dirs::app_data(app)
        .device()
        .join("subscriptions");
    if dir.join("pixiv-webview.remove").exists() {
        remove_login_profile(&dir);
    }
    let store = match Store::open(&dir) {
        Ok(store) => Arc::new(store),
        Err(e) => {
            eprintln!("订阅记录打不开，本次不检查订阅：{e}");
            return;
        }
    };
    app.manage(SubscriptionState {
        store,
        account: Arc::new(PixivAccount::open(&dir)),
        dir,
        wake: Mutex::new(Wake::default()),
        signal: Condvar::new(),
        cancel: Arc::new(AtomicBool::new(false)),
        checking: AtomicBool::new(false),
        login: Mutex::new(None),
    });
    let worker = app.clone();
    std::thread::Builder::new()
        .name("subscription".into())
        .spawn(move || run(&worker))
        .expect("建不了订阅检查线程");
    let listener = app.clone();
    app.listen(crate::library::SAFE_MODE_EVENT, move |_| publish(&listener));
    publish(app);
}

fn status(app: &AppHandle, state: &SubscriptionState) -> SubscriptionStatus {
    let safe = crate::library::saved_safe_mode(app);
    SubscriptionStatus {
        enabled: enabled(app),
        login: state.account.state(),
        signing_in: state
            .login
            .lock()
            .map(|login| login.is_some())
            .unwrap_or(false),
        checking: state.checking.load(Ordering::SeqCst),
        new_count: state.store.new_count(!safe).unwrap_or(0),
        backoff_until: state
            .store
            .backoff(SourceId::Pixiv)
            .ok()
            .flatten()
            .map(|(until, _)| until)
            .filter(|until| *until > now_ms()),
    }
}

/// 把状态推给界面，并更新托盘上的数量。
fn publish(app: &AppHandle) {
    let Some(state) = app.try_state::<SubscriptionState>() else {
        return;
    };
    let status = status(app, &state);
    let count = if status.enabled { status.new_count } else { 0 };
    crate::desktop::set_tray_badge(app, count);
    let _ = app.emit(STATUS_EVENT, status);
}

/// 检查线程。
fn run(app: &AppHandle) {
    let state = app.state::<SubscriptionState>();
    let mut sleep = Duration::ZERO;
    loop {
        let check_all = {
            let wake = state.wake.lock().unwrap_or_else(|e| e.into_inner());
            let (mut wake, _) = state
                .signal
                .wait_timeout_while(wake, sleep, |w| !w.pending)
                .unwrap_or_else(|e| e.into_inner());
            wake.pending = false;
            std::mem::take(&mut wake.check_all)
        };
        sleep = round(app, &state, check_all);
    }
}

/// 一轮：查到期的订阅，返回睡多久。开关关着、没有订阅或没登录时不联网，等下一次唤醒。
fn round(app: &AppHandle, state: &SubscriptionState, check_all: bool) -> Duration {
    if !enabled(app) || !matches!(state.account.state(), LoginState::LoggedIn { .. }) {
        return MAX_SLEEP;
    }
    let Ok(subscriptions) = state.store.list() else {
        return MAX_SLEEP;
    };
    if subscriptions.is_empty() {
        return MAX_SLEEP;
    }
    let backoff = state.store.backoff(SourceId::Pixiv).ok().flatten();
    let now = now_ms();
    let backed_off = |_: SourceId| backoff.is_some_and(|(until, _)| now < until);
    let due: Vec<Subscription> = if check_all && !backed_off(SourceId::Pixiv) {
        subscriptions.clone()
    } else {
        schedule::due(&subscriptions, now, backed_off)
            .into_iter()
            .cloned()
            .collect()
    };
    if !due.is_empty() {
        state.cancel.store(false, Ordering::SeqCst);
        state.checking.store(true, Ordering::SeqCst);
        publish(app);
        check_each(app, state, &due, backoff.map_or(0, |(_, level)| level));
        state.checking.store(false, Ordering::SeqCst);
        publish(app);
    }
    let subscriptions = state.store.list().unwrap_or_default();
    let now = now_ms();
    let next = match state.store.backoff(SourceId::Pixiv).ok().flatten() {
        Some((until, _)) if until > now => Some(until),
        _ => schedule::next_due(&subscriptions, now),
    };
    next.map_or(MAX_SLEEP, |at| {
        Duration::from_millis((at - now).max(1_000) as u64).min(MAX_SLEEP)
    })
}

fn check_each(app: &AppHandle, state: &SubscriptionState, due: &[Subscription], level: u32) {
    let mut source = PixivSource::new(state.account.clone(), state.cancel.clone());
    let destination = Libraries(app.clone());
    let mut rate_limited = false;
    for subscription in due {
        let result = check(
            &state.store,
            subscription,
            &mut source,
            &destination,
            &now_ms,
            &state.cancel,
        );
        match result {
            Ok(report) => {
                if report.collected > 0 {
                    publish(app);
                }
            }
            Err(SourceError::RateLimited) => {
                rate_limited = true;
                break;
            }
            Err(SourceError::LoginExpired | SourceError::Cancelled) => break,
            Err(_) => {}
        }
    }
    let _ = if rate_limited {
        state.store.set_backoff(
            SourceId::Pixiv,
            now_ms() + schedule::backoff_ms(level),
            level + 1,
        )
    } else if !state.cancel.load(Ordering::SeqCst) {
        state.store.clear_backoff(SourceId::Pixiv)
    } else {
        Ok(())
    };
}

/// 收进资料库：按订阅选的资料库，放在未归类。
struct Libraries(AppHandle);

impl Destination for Libraries {
    fn import(
        &self,
        library_id: &str,
        page: SubscriptionPage,
        bytes: &[u8],
    ) -> Result<String, String> {
        let destination = SaveDestination {
            library_id: library_id.to_owned(),
            folder_id: None,
        };
        crate::library::with_destination(&self.0, &destination, |library| {
            Ok(library.import_from_subscription(page, bytes)?)
        })
        .map_err(|e| e.to_string())
    }
}

// 订阅命令的错误代码随订阅界面的文案再加（#368）；在那之前按原样显示中文说明。
fn require(app: &AppHandle) -> Result<State<'_, SubscriptionState>, CommandError> {
    app.try_state::<SubscriptionState>()
        .ok_or_else(|| CommandError::without_code("订阅功能在这个版本里还不可用"))
}

#[tauri::command]
pub async fn subscription_status(app: AppHandle) -> Result<SubscriptionStatus, CommandError> {
    let state = require(&app)?;
    Ok(status(&app, &state))
}

/// 设置里的订阅开关。关掉时取消正在进行的检查，之后不再联网。
#[tauri::command]
pub async fn set_subscriptions_enabled(
    app: AppHandle,
    on: bool,
) -> Result<SubscriptionStatus, CommandError> {
    let state = require(&app)?;
    app.state::<ShellState>()
        .0
        .lock()
        .map_err(CommandError::system)?
        .settings
        .set_subscriptions(on)?;
    if !on {
        state.cancel.store(true, Ordering::SeqCst);
        if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
            let _ = window.close();
        }
    }
    state.poke(false);
    publish(&app);
    Ok(status(&app, &state))
}

/// 立即检查全部订阅（退避中仍不查）。
#[tauri::command]
pub async fn subscription_check_now(app: AppHandle) -> Result<(), CommandError> {
    let state = require(&app)?;
    if !enabled(&app) {
        return Err(CommandError::without_code("订阅功能已关闭"));
    }
    state.poke(true);
    Ok(())
}

#[tauri::command]
pub async fn subscriptions(app: AppHandle) -> Result<Vec<Subscription>, CommandError> {
    require(&app)?.store.list().map_err(CommandError::system)
}

/// 最近收进来的图。安全模式开着时不含成人作品。
#[tauri::command]
pub async fn subscription_recent(app: AppHandle) -> Result<Vec<ReceivedImage>, CommandError> {
    let state = require(&app)?;
    let safe = crate::library::saved_safe_mode(&app);
    let recent = state
        .store
        .recent(RECENT_LIMIT)
        .map_err(CommandError::system)?;
    Ok(recent
        .into_iter()
        .filter(|r| !safe || !r.explicit)
        .collect())
}

/// 画师打开了订阅页：新图标为已看，入口与托盘上的数量清零。
#[tauri::command]
pub async fn subscription_mark_seen(app: AppHandle) -> Result<(), CommandError> {
    require(&app)?
        .store
        .mark_seen()
        .map_err(CommandError::system)?;
    publish(&app);
    Ok(())
}
