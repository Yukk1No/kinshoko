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

use kinshoko_core::command_error::{CommandError, ErrorKind};
use kinshoko_core::library::{SaveDestination, SubscriptionPage};
use kinshoko_core::subscription::pace::Pacers;
use kinshoko_core::subscription::pixiv::{
    Artist, LoginRequest, LoginState, PixivAccount, PixivSource, artist_id,
};
use kinshoko_core::subscription::{
    Destination, NewSubscription, ReceivedImage, SourceError, SourceId, Store, Subscription,
    SubscriptionStatus, Target, check, schedule,
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
    /// pixiv 的请求节拍：检查线程与查找画师、读关注共用。
    pacers: Arc<Pacers>,
    /// 订阅数据目录：订阅记录、pixiv 登录与登录窗口的 WebView2 数据。
    dir: PathBuf,
    wake: Mutex<Wake>,
    signal: Condvar,
    /// 关掉订阅开关或退出登录时置位，正在进行的检查在下一个请求前停下。
    cancel: Arc<AtomicBool>,
    /// 同上，管界面里的查找画师与读关注：关掉订阅开关或退出登录时置位。
    foreground_cancel: Arc<AtomicBool>,
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
        pacers: Arc::new(Pacers::default()),
        dir,
        wake: Mutex::new(Wake::default()),
        signal: Condvar::new(),
        cancel: Arc::new(AtomicBool::new(false)),
        foreground_cancel: Arc::new(AtomicBool::new(false)),
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
        check_each(app, state, &due, backoff);
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

/// `backoff` 是这一轮开始时看到的退避。轮中别处（查找画师、读关注）遇到频率限制定下的新退避，
/// 这一轮照样遵守，也不会在结束时把它清掉。
fn check_each(
    app: &AppHandle,
    state: &SubscriptionState,
    due: &[Subscription],
    backoff: Option<(i64, u32)>,
) {
    let level = backoff.map_or(0, |(_, level)| level);
    let current = || state.store.backoff(SourceId::Pixiv).ok().flatten();
    let mut source = PixivSource::new(
        state.account.clone(),
        state.pacers.clone(),
        state.cancel.clone(),
    );
    let destination = Libraries(app.clone());
    let mut rate_limited = false;
    for subscription in due {
        if current() != backoff {
            return;
        }
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
            Err(SourceError::LoginExpired) => break,
            // 不是整轮取消，而是这条在检查期间被退订了：接着查下一条。
            Err(SourceError::Cancelled) if !state.cancel.load(Ordering::SeqCst) => {}
            Err(SourceError::Cancelled) => break,
            Err(_) => {}
        }
    }
    if current() != backoff {
        return;
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

fn require(app: &AppHandle) -> Result<State<'_, SubscriptionState>, CommandError> {
    app.try_state::<SubscriptionState>().ok_or_else(|| {
        CommandError::new(
            ErrorKind::SubscriptionsUnavailable,
            "subscriptions are not available in this build",
        )
    })
}

/// 设置里关掉了订阅功能。
fn switched_off() -> CommandError {
    CommandError::new(
        ErrorKind::SubscriptionsOff,
        "subscriptions are switched off",
    )
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
        state.foreground_cancel.store(true, Ordering::SeqCst);
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
        return Err(switched_off());
    }
    state.poke(true);
    Ok(())
}

#[tauri::command]
pub async fn subscriptions(app: AppHandle) -> Result<Vec<Subscription>, CommandError> {
    require(&app)?.store.list().map_err(CommandError::system)
}

/// 最近收进来的图。安全模式开着时不含成人作品：来源标为成人的，以及在图库里按有效分级
/// 落在安全模式范围内的（例如收进来以后画师手动改了分级），与缩略图的放行规则一致。
/// `safe_mode` 是界面这次读取用的视角；它与设置里的安全模式有一个开着就按开着过滤，
/// 界面把结果当作“已按安全模式过滤”时，它一定过滤过。
#[tauri::command]
pub async fn subscription_recent(
    app: AppHandle,
    safe_mode: bool,
) -> Result<Vec<ReceivedImage>, CommandError> {
    let state = require(&app)?;
    let safe = safe_mode || crate::library::saved_safe_mode(&app);
    let recent = state
        .store
        .recent(RECENT_LIMIT)
        .map_err(CommandError::system)?;
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        recent
            .into_iter()
            .filter(|r| {
                !safe
                    || (!r.explicit
                        && crate::library::image_shown(&app, &r.library_id, &r.image_id))
            })
            .collect()
    })
    .await
    .map_err(CommandError::system)
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

/// 订阅来源的请求没成。
fn source_failed(reason: SourceError) -> CommandError {
    CommandError::new(
        ErrorKind::SubscriptionSource {
            reason: reason.clone(),
        },
        format!("pixiv request failed: {reason:?}"),
    )
}

/// 界面里向 pixiv 要东西（查找画师、读关注）：要开着订阅、登录着，并且不在退避中。
/// 和检查线程排同一个节拍；遇到频率限制时整个来源退避，与检查一样。
async fn ask_pixiv<T: Send + 'static>(
    app: &AppHandle,
    ask: impl FnOnce(&mut PixivSource) -> Result<T, SourceError> + Send + 'static,
) -> Result<T, CommandError> {
    let state = require(app)?;
    if !enabled(app) {
        return Err(switched_off());
    }
    match state.account.state() {
        LoginState::LoggedIn { .. } => {}
        LoginState::LoggedOut => return Err(source_failed(SourceError::LoginRequired)),
        LoginState::Expired { .. } => return Err(source_failed(SourceError::LoginExpired)),
    }
    let backoff = state.store.backoff(SourceId::Pixiv).ok().flatten();
    if backoff.is_some_and(|(until, _)| until > now_ms()) {
        return Err(source_failed(SourceError::RateLimited));
    }
    state.foreground_cancel.store(false, Ordering::SeqCst);
    let mut source = PixivSource::new(
        state.account.clone(),
        state.pacers.clone(),
        state.foreground_cancel.clone(),
    );
    let store = state.store.clone();
    let result = tauri::async_runtime::spawn_blocking(move || ask(&mut source))
        .await
        .map_err(CommandError::system)?;
    match result {
        Ok(value) => Ok(value),
        Err(SourceError::RateLimited) => {
            let level = backoff.map_or(0, |(_, level)| level);
            let _ = store.set_backoff(
                SourceId::Pixiv,
                now_ms() + schedule::backoff_ms(level),
                level + 1,
            );
            publish(app);
            Err(source_failed(SourceError::RateLimited))
        }
        Err(e @ SourceError::LoginExpired) => {
            publish(app);
            Err(source_failed(e))
        }
        Err(e) => Err(source_failed(e)),
    }
}

/// 订阅画师（#369）：从画师主页链接或 ID 找到画师。
#[tauri::command]
pub async fn subscription_find_artist(
    app: AppHandle,
    input: String,
) -> Result<Artist, CommandError> {
    let Some(user_id) = artist_id(&input) else {
        return Err(CommandError::new(
            ErrorKind::ArtistUnrecognized,
            "not a pixiv artist link or id",
        ));
    };
    ask_pixiv(&app, move |source| source.artist(&user_id))
        .await?
        .ok_or_else(|| CommandError::new(ErrorKind::ArtistNotFound, "no such pixiv artist"))
}

/// 登录账号在 pixiv 上关注的画师（#369 从 pixiv 关注导入）。
#[tauri::command]
pub async fn subscription_following(app: AppHandle) -> Result<Vec<Artist>, CommandError> {
    ask_pixiv(&app, |source| source.following()).await
}

/// 添加订阅（可以一次几条，例如从关注导入）。已订阅过的对象报错，一条都不加；加好后马上检查。
#[tauri::command]
pub async fn subscription_add(
    app: AppHandle,
    subscriptions: Vec<NewSubscription>,
) -> Result<Vec<Subscription>, CommandError> {
    let state = require(&app)?;
    if !enabled(&app) {
        return Err(switched_off());
    }
    let existing = state.store.list().map_err(CommandError::system)?;
    let taken = |target: &Target| existing.iter().any(|s| same_target(&s.target, target));
    let mut seen: Vec<&Target> = Vec::new();
    for new in &subscriptions {
        if taken(&new.target) || seen.iter().any(|t| same_target(t, &new.target)) {
            return Err(CommandError::new(
                ErrorKind::AlreadySubscribed,
                "already subscribed",
            ));
        }
        seen.push(&new.target);
    }
    let now = now_ms();
    let added = subscriptions
        .into_iter()
        .map(|new| state.store.add(new, now))
        .collect::<Result<Vec<_>, _>>()
        .map_err(CommandError::system)?;
    state.poke(false);
    publish(&app);
    Ok(added)
}

/// 画师订阅按画师判断是不是同一个；其余按整个对象。
fn same_target(a: &Target, b: &Target) -> bool {
    match (a, b) {
        (Target::PixivArtist { user_id: x }, Target::PixivArtist { user_id: y }) => x == y,
        _ => a == b,
    }
}

/// 改一条订阅收不收漫画与成人作品。
#[tauri::command]
pub async fn subscription_set_options(
    app: AppHandle,
    id: String,
    include_explicit: bool,
    include_manga: bool,
) -> Result<Subscription, CommandError> {
    require(&app)?
        .store
        .set_options(&id, include_explicit, include_manga)
        .map_err(CommandError::system)
}

/// 退订：删掉这条订阅，已收进图库的图留着。
#[tauri::command]
pub async fn subscription_remove(app: AppHandle, id: String) -> Result<(), CommandError> {
    require(&app)?
        .store
        .remove(&id)
        .map_err(CommandError::system)?;
    publish(&app);
    Ok(())
}
