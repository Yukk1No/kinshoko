//! pixiv 登录窗口（#368）：打开、画师自己关掉或取消、换到会话后关掉，以及退出登录。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use kinshoko_core::command_error::CommandError;
use kinshoko_core::subscription::SubscriptionStatus;
use kinshoko_core::subscription::pixiv::{LoginRequest, callback_code};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use super::{SubscriptionState, enabled, publish, require, status};

pub(super) const LOGIN_WINDOW: &str = "pixiv-login";

/// 登录窗口的 WebView2 数据目录：与主窗口分开，退出登录时连同 cookie 一起删掉。
fn login_profile(dir: &Path) -> PathBuf {
    dir.join("pixiv-webview")
}

/// 删登录窗口的数据目录；还被占用（窗口刚关）时留个记号，下次启动再删。
pub(super) fn remove_login_profile(dir: &Path) {
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
    let closed = (app.clone(), request.clone(), captured.clone());
    let window = WebviewWindowBuilder::new(&app, LOGIN_WINDOW, WebviewUrl::External(url))
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
    // 画师自己关掉登录窗口：这次登录作废，订阅页回到未登录。已截到 code 的由 finish_login 收尾。
    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::Destroyed) || closed.2.load(Ordering::SeqCst) {
            return;
        }
        let (app, request, _) = &closed;
        if let Some(state) = app.try_state::<SubscriptionState>() {
            let mut login = state.login.lock().unwrap_or_else(|e| e.into_inner());
            if login
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, request))
            {
                *login = None;
            }
        }
        publish(app);
    });
    publish(&app);
    Ok(())
}

/// 订阅页的“取消”：关掉登录窗口，这次登录作废。
#[tauri::command]
pub async fn subscription_cancel_login(app: AppHandle) -> Result<SubscriptionStatus, CommandError> {
    let state = require(&app)?;
    state.login.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = window.destroy();
    }
    publish(&app);
    Ok(status(&app, &state))
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
