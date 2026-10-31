//! 订阅（#368）：定时检查线程、pixiv 登录窗口、托盘上的新图数量。领域逻辑在
//! `kinshoko_core::subscription`。
//!
//! - 只在设置里的订阅开关开着、有订阅、已登录时联网；关掉开关立即取消正在进行的检查。
//! - 检查线程按 `schedule` 睡到下一条订阅到期；退出期间错过的检查，重新打开后补上。
//! - 功能跨 #368–#371 几个 PR，最后一个合并前只在设了 `KINSHOKO_SUBSCRIPTIONS=1` 时出现：
//!   没设时不建线程、不打开订阅记录、不联网，命令一律报不可用。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use kinshoko_core::command_error::CommandError;
use kinshoko_core::library::{SaveDestination, SubscriptionPage};
use kinshoko_core::subscription::pixiv::{
    LoginRequest, LoginState, PixivAccount, PixivSource, callback_code,
};
use kinshoko_core::subscription::{
    Destination, ReceivedImage, SourceError, SourceId, Store, Subscription, SubscriptionStatus,
    check, schedule,
};
use tauri::image::Image;
use tauri::{AppHandle, Emitter, Listener, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::shell::ShellState;

/// 订阅状态变了（检查开始或结束、登录变化、新图数量变化），载荷为 [`SubscriptionStatus`]。
const STATUS_EVENT: &str = "subscription-status";
const LOGIN_WINDOW: &str = "pixiv-login";
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

/// 登录窗口的 WebView2 数据目录：与主窗口分开，退出登录时连同 cookie 一起删掉。
fn login_profile(dir: &Path) -> PathBuf {
    dir.join("pixiv-webview")
}

/// 删登录窗口的数据目录；还被占用（窗口刚关）时留个记号，下次启动再删。
fn remove_login_profile(dir: &Path) {
    let profile = login_profile(dir);
    let marker = dir.join("pixiv-webview.remove");
    match std::fs::remove_dir_all(&profile) {
        Ok(()) => {
            let _ = std::fs::remove_file(&marker);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let _ = std::fs::remove_file(&marker);
        }
        Err(_) => {
            let _ = std::fs::write(&marker, b"");
        }
    }
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

/// 打开 pixiv 登录窗口。`title` 是界面按语言给的窗口标题。
#[tauri::command]
pub async fn subscription_login(app: AppHandle, title: String) -> Result<(), CommandError> {
    let state = require(&app)?;
    if !enabled(&app) {
        return Err(CommandError::without_code("订阅功能已关闭"));
    }
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = window.set_focus();
        return Ok(());
    }
    let request = Arc::new(LoginRequest::new());
    *state.login.lock().map_err(CommandError::system)? = Some(request.clone());
    let url = request.url().parse().map_err(CommandError::system)?;
    let handle = app.clone();
    let captured = Arc::new(AtomicBool::new(false));
    WebviewWindowBuilder::new(&app, LOGIN_WINDOW, WebviewUrl::External(url))
        .title(title)
        .inner_size(480.0, 760.0)
        .data_directory(login_profile(&state.dir))
        .on_navigation(move |url| {
            let Some(code) = callback_code(url.as_str()) else {
                return true;
            };
            if !captured.swap(true, Ordering::SeqCst) {
                let app = handle.clone();
                let request = request.clone();
                std::thread::spawn(move || finish_login(&app, request, &code));
            }
            false
        })
        .build()
        .map_err(|e| CommandError::system(format!("打不开登录窗口：{e}")))?;
    Ok(())
}

/// 用截到的 code 换登录会话，关掉登录窗口，检查线程随即按需开始。
/// 换会话期间画师退出了登录（或又开了一次登录）时，这次的结果作废。
fn finish_login(app: &AppHandle, request: Arc<LoginRequest>, code: &str) {
    let Some(state) = app.try_state::<SubscriptionState>() else {
        return;
    };
    let result = request.finish(code);
    {
        // 与退出登录同一把锁：核对这次登录仍有效和保存会话之间，退出登录插不进来。
        let mut login = state.login.lock().unwrap_or_else(|e| e.into_inner());
        if !login
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &request))
        {
            return;
        }
        *login = None;
        // 只关这次登录的窗口：作废后新开的登录窗口不受影响。
        if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
            let _ = window.close();
        }
        match result {
            Ok(session) => {
                if let Err(e) = state.account.logged_in(session) {
                    eprintln!("pixiv 登录没能保存：{e}");
                }
            }
            Err(e) => eprintln!("pixiv 登录没能完成：{e:?}"),
        }
    }
    state.poke(false);
    publish(app);
}

/// 退出 pixiv 登录：删掉本机保存的登录与登录窗口的 cookie，取消正在进行的检查。
#[tauri::command]
pub async fn subscription_logout(app: AppHandle) -> Result<SubscriptionStatus, CommandError> {
    let state = require(&app)?;
    state.cancel.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = window.destroy();
    }
    {
        // 作废还在换会话的登录，免得它晚到的结果把登录写回来。
        let mut login = state.login.lock().unwrap_or_else(|e| e.into_inner());
        *login = None;
        state.account.log_out().map_err(CommandError::system)?;
    }
    remove_login_profile(&state.dir);
    publish(&app);
    Ok(status(&app, &state))
}

/// 托盘图标右上角的新图数量：圆点里写数字，超过 9 写“9+”。
pub fn badge(icon: &Image<'_>, count: u32) -> Image<'static> {
    let (w, h) = (icon.width() as i32, icon.height() as i32);
    let mut rgba = icon.rgba().to_vec();
    if count == 0 {
        return Image::new_owned(rgba, w as u32, h as u32);
    }
    let r = (w.min(h) as f32 * 0.3).max(4.0);
    let (cx, cy) = (w as f32 - r, r);
    let mut put = |x: i32, y: i32, c: [u8; 4]| {
        if (0..w).contains(&x) && (0..h).contains(&y) {
            let i = ((y * w + x) * 4) as usize;
            rgba[i..i + 4].copy_from_slice(&c);
        }
    };
    for y in 0..h {
        for x in 0..w {
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            if d <= r {
                put(x, y, [0xC8, 0x3A, 0x2E, 0xFF]);
            }
        }
    }
    let text = if count > 9 {
        "9+".to_owned()
    } else {
        count.to_string()
    };
    let scale = ((r * 1.1) / 5.0).floor().max(1.0) as i32;
    let glyph_w = 3 * scale;
    let width = text.len() as i32 * glyph_w + (text.len() as i32 - 1) * scale;
    let (x0, y0) = (cx as i32 - width / 2, cy as i32 - 5 * scale / 2);
    for (n, ch) in text.chars().enumerate() {
        let rows = glyph(ch);
        let gx = x0 + n as i32 * (glyph_w + scale);
        for (row, bits) in rows.iter().enumerate() {
            for col in 0..3 {
                if bits & (0b100 >> col) != 0 {
                    for dy in 0..scale {
                        for dx in 0..scale {
                            put(
                                gx + col * scale + dx,
                                y0 + row as i32 * scale + dy,
                                [0xFF, 0xFF, 0xFF, 0xFF],
                            );
                        }
                    }
                }
            }
        }
    }
    Image::new_owned(rgba, w as u32, h as u32)
}

/// 3×5 点阵数字。
fn glyph(ch: char) -> [u8; 5] {
    match ch {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b010, 0b010, 0b010],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '+' => [0b000, 0b010, 0b111, 0b010, 0b000],
        _ => [0; 5],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn badge_draws_only_when_there_are_new_images() {
        let icon = Image::new_owned(vec![0; 32 * 32 * 4], 32, 32);
        assert_eq!(badge(&icon, 0).rgba(), icon.rgba());
        let drawn = badge(&icon, 12);
        // 右上角是红点，左下角不动。
        let at = |x: usize, y: usize| &drawn.rgba()[(y * 32 + x) * 4..(y * 32 + x) * 4 + 4];
        assert_eq!(at(31 - 9, 1)[3], 0xFF);
        assert_eq!(at(0, 31), [0, 0, 0, 0]);
    }
}
