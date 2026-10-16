//! 应用壳：常驻进程的设置、全局快捷键、开机自启与主窗口。
//!
//! 线程规则（沿用 #7 钉图原型）：**持有 [`ShellState`] 的锁时，主线程不能来等这把锁。**
//! 注册快捷键和开关自启会把调用派发到主线程并等待结果，所以只在 async 命令（不在主线程上）
//! 和启动时（主线程上、还没有别的事件）持有这把锁；托盘、快捷键与窗口事件的回调一律不碰它。

use std::sync::Mutex;

use kinshoko_core::diagnostics::UsageEvent;
use kinshoko_core::{
    AppSettings, GlobalShortcuts, HotkeyRegistrar, ShellSettingsView, ShortcutAction,
};
use tauri::{AppHandle, Manager, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt as _, Shortcut, ShortcutState};

use crate::desktop;

/// 主窗口的标签，与 `tauri.conf.json` 一致。
pub const MAIN_WINDOW: &str = "main";

/// 开机自启时附带的参数：带着它启动时只进托盘，不打开主窗口。
pub const AUTOSTART_ARG: &str = "--autostart";

pub struct Shell {
    pub settings: AppSettings,
    pub shortcuts: GlobalShortcuts<TauriHotkeys>,
}

pub struct ShellState(pub Mutex<Shell>);

impl Shell {
    pub fn view(&self) -> ShellSettingsView {
        self.shortcuts.settings_view(&self.settings)
    }
}

/// 打开设置、注册快捷键、按设置同步开机自启。在 `setup` 里调用一次。
pub fn start(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_config_dir()?;
    let settings = AppSettings::open(&dir)?;
    // 先定下 WebView2 启动参数（强制 sRGB），之后才建窗口。
    crate::diagnostics::start(app, &settings)?;
    let shortcuts = GlobalShortcuts::start(TauriHotkeys { app: app.clone() }, &settings);
    if let Err(e) = apply_autostart(app, settings.autostart()) {
        eprintln!("同步开机自启失败：{e}");
    }
    app.manage(ShellState(Mutex::new(Shell {
        settings,
        shortcuts,
    })));
    Ok(())
}

/// 让系统的开机自启与设置一致。
///
/// 调试构建与设置了 `KINSHOKO_SKIP_AUTOSTART` 时不写系统，免得把 `target/` 里的开发版
/// 登记成开机启动；设置本身照常保存。
pub fn apply_autostart(app: &AppHandle, on: bool) -> Result<(), String> {
    if cfg!(debug_assertions) || std::env::var_os("KINSHOKO_SKIP_AUTOSTART").is_some() {
        return Ok(());
    }
    let launcher = app.autolaunch();
    let current = launcher.is_enabled().map_err(|e| e.to_string())?;
    match (current, on) {
        (false, true) => launcher.enable(),
        (true, false) => launcher.disable(),
        _ => Ok(()),
    }
    .map_err(|e| e.to_string())
}

/// 打开主窗口；关闭后 WebView 已销毁，这里按配置重新建一个。
pub fn open_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
    else {
        return;
    };
    crate::desktop::clear_viewer_reference(app);
    crate::diagnostics::record(app, UsageEvent::MainWindowOpened);
    match WebviewWindowBuilder::from_config(app, config).and_then(|b| {
        b.additional_browser_args(crate::diagnostics::browser_args())
            .build()
    }) {
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(e) => eprintln!("打开主窗口失败：{e}"),
    }
}

/// 用 Tauri 全局快捷键插件实现的系统热键表。每个键注册时带上自己的动作，
/// 按下时直接派发，不查设置、不加锁。
pub struct TauriHotkeys {
    app: AppHandle,
}

impl HotkeyRegistrar for TauriHotkeys {
    fn register(&mut self, action: ShortcutAction, accelerator: &str) -> Result<(), String> {
        let shortcut: Shortcut = accelerator
            .parse()
            .map_err(|_| "无法识别这个按键".to_owned())?;
        self.app
            .global_shortcut()
            .on_shortcut(shortcut, move |app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    desktop::on_shortcut(app, action);
                }
            })
            .map_err(|e| {
                let message = e.to_string();
                if message.contains("already registered") {
                    "已被其他程序占用".to_owned()
                } else {
                    format!("系统拒绝注册（{message}）")
                }
            })
    }

    fn unregister(&mut self, accelerator: &str) {
        if let Ok(shortcut) = accelerator.parse::<Shortcut>()
            && let Err(e) = self.app.global_shortcut().unregister(shortcut)
        {
            eprintln!("注销快捷键 {accelerator} 失败：{e}");
        }
    }
}
