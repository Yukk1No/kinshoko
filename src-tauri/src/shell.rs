//! 应用壳：常驻进程的设置、全局快捷键、开机自启与主窗口。
//!
//! 线程规则（沿用 #7 钉图原型）：**持有 [`ShellState`] 的锁时，主线程不能来等这把锁。**
//! 注册快捷键和开关自启会把调用派发到主线程并等待结果，所以只在 async 命令（不在主线程上）
//! 和启动时（主线程上、还没有别的事件）持有这把锁；托盘、快捷键与窗口事件的回调一律不碰它。

use kinshoko_core::CommandError;
use std::sync::Mutex;

use kinshoko_core::diagnostics::{LogEvent, WindowKind};
use kinshoko_core::interface_lang::{self, InterfaceLanguageSetting};
use kinshoko_core::{
    AppSettings, GlobalShortcuts, HotkeyFailure, HotkeyRegistrar, ShellSettingsView,
    ShortcutAction, UiScale,
};
use tauri::{AppHandle, Emitter as _, Manager, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt as _, Shortcut, ShortcutState};

use crate::data_dirs::SharedWebview as _;
use crate::desktop;

mod window_state;
use window_state::Placement;
#[cfg(windows)]
mod windows_autostart;

/// 主窗口的标签，与 `tauri.conf.json` 一致。
pub const MAIN_WINDOW: &str = "main";

/// 界面语言改变时发给各窗口的事件，带新的界面语言（#354）。
pub const INTERFACE_LANGUAGE_EVENT: &str = "interface-language";

/// 开机自启时附带的参数：带着它启动时只进托盘，不打开主窗口。
pub const AUTOSTART_ARG: &str = "--autostart";

pub struct Shell {
    pub settings: AppSettings,
    pub shortcuts: GlobalShortcuts<TauriHotkeys>,
    #[cfg(windows)]
    autostart_name: String,
}

pub struct ShellState(pub Mutex<Shell>);

/// 设置里选的界面语言（#358）。与 [`ShellState`] 分开一把锁，命令不在持锁时通知窗口。
pub struct InterfaceLanguageState(pub Mutex<InterfaceLanguageSetting>);

/// 主窗口的界面缩放（#173）。与 [`ShellState`] 分开一把锁：打开主窗口（托盘、第二次启动的
/// 回调，在主线程上）要读它；改档位的命令不在持锁时调用 WebView。
pub struct UiScaleState(pub Mutex<UiScale>);

struct MainWindowState(Mutex<Placement>);

impl Shell {
    pub fn view(&self) -> ShellSettingsView {
        let view = self.shortcuts.settings_view(&self.settings);
        #[cfg(windows)]
        if !skip_autostart() {
            match windows_autostart::read(&self.autostart_name) {
                Ok(registration) => {
                    return ShellSettingsView {
                        autostart: registration.enabled(),
                        ..view
                    };
                }
                Err(error) => crate::run_log::warn("read Windows startup registration", error),
            }
        }
        view
    }
}

/// 打开设置、注册快捷键、按设置同步开机自启。在 `setup` 里调用一次。
pub fn start(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let mut settings = AppSettings::open(crate::data_dirs::app_data(app).settings())?;
    // 在装上新版本之前记下按本构建推定的更新通道（#204）。
    if let Err(e) = settings.remember_update_channel() {
        crate::run_log::warn("记下更新通道失败", e);
    }
    // 先定下 WebView2 启动参数（强制 sRGB），之后才建窗口。
    crate::diagnostics::start(app, &settings)?;
    // 托盘与第一个窗口建好之前按设置里的界面语言来（#358）。
    let language = InterfaceLanguageSetting::open(crate::data_dirs::app_data(app).settings())?;
    interface_lang::set(choose_interface_language(language.choice()));
    app.manage(InterfaceLanguageState(Mutex::new(language)));
    let ui_scale = UiScale::open(crate::data_dirs::app_data(app).settings())?;
    app.manage(UiScaleState(Mutex::new(ui_scale)));
    let placement =
        Placement::open(crate::data_dirs::app_data(app).settings()).unwrap_or_else(|error| {
            crate::run_log::warn("read main window placement", error);
            Placement::default()
        });
    app.manage(MainWindowState(Mutex::new(placement)));
    let shortcuts = GlobalShortcuts::start(TauriHotkeys { app: app.clone() }, &settings);
    if let Err(e) = sync_autostart(app, settings.autostart()) {
        crate::run_log::warn("同步开机自启失败", e);
    }
    app.manage(ShellState(Mutex::new(Shell {
        settings,
        shortcuts,
        #[cfg(windows)]
        autostart_name: app.package_info().name.clone(),
    })));
    Ok(())
}

/// 先按系统语言定下界面语言（#354）。在准备数据目录之前调用：迁移旧数据时留下的说明与
/// 启动失败的对话框也按界面语言写。设置里的选择在数据目录准备好之后由 [`start`] 读进来。
pub fn start_interface_language() {
    interface_lang::set(choose_interface_language(interface_lang::SYSTEM));
}

/// 设置里的选择（`system` 或某种界面语言）对应的界面语言。`KINSHOKO_INTERFACE_LANG`
/// （`zh-CN`、`en` 或 `system`）供开发时指定，优先于设置。
pub fn choose_interface_language(choice: &str) -> &'static str {
    let specified = std::env::var("KINSHOKO_INTERFACE_LANG").ok();
    let system = sys_locale::get_locale();
    interface_lang::choose(
        Some(specified.as_deref().unwrap_or(choice)),
        system.as_deref(),
    )
}

/// 告诉各窗口界面语言改了。
pub fn announce_interface_language(app: &AppHandle, lang: &str) {
    let _ = app.emit(INTERFACE_LANGUAGE_EVENT, lang);
    desktop::relabel_tray(app);
    crate::backup::publish(app);
}

/// Apply an explicit change from the startup switch.
pub fn apply_autostart<R: tauri::Runtime>(
    app: &AppHandle<R>,
    on: bool,
) -> Result<(), CommandError> {
    update_autostart(app, on, true)
}

/// Sync a saved preference without overriding a Windows startup veto.
pub fn sync_autostart<R: tauri::Runtime>(app: &AppHandle<R>, on: bool) -> Result<(), CommandError> {
    update_autostart(app, on, false)
}

fn skip_autostart() -> bool {
    cfg!(debug_assertions) || std::env::var_os("KINSHOKO_SKIP_AUTOSTART").is_some()
}

fn update_autostart<R: tauri::Runtime>(
    app: &AppHandle<R>,
    on: bool,
    explicit: bool,
) -> Result<(), CommandError> {
    if skip_autostart() {
        return Ok(());
    }
    let launcher = app.autolaunch();
    #[cfg(windows)]
    {
        let name = &app.package_info().name;
        let registration = windows_autostart::read(name).map_err(CommandError::system)?;
        registration.update(
            on,
            explicit,
            |mode| windows_autostart::enable(name, mode),
            || launcher.disable().map_err(CommandError::system),
        )
    }
    #[cfg(not(windows))]
    {
        let _ = explicit;
        let current = launcher.is_enabled().map_err(CommandError::system)?;
        apply_autostart_change(current, on, || launcher.enable(), || launcher.disable())
            .map_err(CommandError::system)
    }
}

fn apply_autostart_change<E>(
    current: bool,
    on: bool,
    enable: impl FnOnce() -> Result<(), E>,
    disable: impl FnOnce() -> Result<(), E>,
) -> Result<(), E> {
    match (current, on) {
        (false, true) => enable(),
        (true, false) => disable(),
        _ => Ok(()),
    }
}

/// 按本机的界面缩放档位缩放主窗口的 WebView。截图遮罩、钉图等其他窗口不缩放。
pub fn apply_ui_scale(app: &AppHandle, factor: f64) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW)
        && let Err(e) = window.set_zoom(factor)
    {
        crate::run_log::warn("应用界面缩放失败", e);
    }
}

pub fn observe_main_window(app: &AppHandle, save: bool) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let observation = match window.is_minimized() {
        Ok(false) => window
            .is_maximized()
            .and_then(|maximized| {
                let size = window
                    .inner_size()?
                    .to_logical::<f64>(window.scale_factor()?);
                Ok((maximized, [size.width, size.height]))
            })
            .ok(),
        _ => None,
    };
    let state = app.state::<MainWindowState>();
    let placement = {
        let mut placement = crate::sync::lock(&state.0);
        if let Some((maximized, size)) = observation {
            placement.observe(maximized, size);
        }
        *placement
    };
    if save && let Err(error) = placement.save(crate::data_dirs::app_data(app).settings()) {
        crate::run_log::warn("save main window placement", error);
    }
}

/// 打开主窗口；关闭后 WebView 已销毁，这里按配置重新建一个。
///
/// 新建的窗口先不显示，套上界面缩放再显示，首帧就是保存的档位。
pub fn open_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        crate::library::wake_workspace_monitor();
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
    crate::run_log::record(LogEvent::MainWindowOpened);
    let started = std::time::Instant::now();
    let scale = app
        .try_state::<UiScaleState>()
        .and_then(|state| state.0.lock().ok().map(|scale| scale.clone()));
    let factor = scale.as_ref().map_or(1.0, UiScale::factor);
    // 档位也预先写给页面：图片墙首帧就按它排，不等 `ui_scale` 命令。界面语言同样，首帧就是它。
    let seed = format!(
        "window.__KINSHOKO_UI_SCALE__ = {}; window.__KINSHOKO_INTERFACE_LANG__ = \"{}\";",
        scale.as_ref().map_or(100, UiScale::percent),
        interface_lang::current()
    );
    #[cfg(windows)]
    let seed = format!("{seed}{}", crate::file_drop::initialization_script(app));
    let placement = *crate::sync::lock(&app.state::<MainWindowState>().0);
    match WebviewWindowBuilder::from_config(app, config).and_then(|mut b| {
        if let Some([width, height]) = placement.normal_size {
            b = b.inner_size(width, height);
        }
        b.visible(false)
            .maximized(placement.maximized)
            .initialization_script(seed)
            .shared_webview(app)
            .build()
    }) {
        Ok(window) => {
            #[cfg(windows)]
            if let Err(error) = crate::file_drop::install(&window) {
                crate::run_log::error("file drop bridge", error);
            }
            crate::run_log::window_created(WindowKind::Main, started);
            apply_ui_scale(app, factor);
            let _ = window.show();
            let _ = window.set_focus();
            crate::library::wake_workspace_monitor();
        }
        Err(e) => crate::run_log::error("打开主窗口失败", e),
    }
}

/// 用 Tauri 全局快捷键插件实现的系统热键表。每个键注册时带上自己的动作，
/// 按下时直接派发，不查设置、不加锁。
pub struct TauriHotkeys {
    app: AppHandle,
}

impl HotkeyRegistrar for TauriHotkeys {
    fn register(&mut self, action: ShortcutAction, accelerator: &str) -> Result<(), HotkeyFailure> {
        let shortcut: Shortcut = accelerator.parse().map_err(|_| HotkeyFailure::UnknownKey)?;
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
                    HotkeyFailure::Taken
                } else {
                    HotkeyFailure::Refused { detail: message }
                }
            })
    }

    fn unregister(&mut self, accelerator: &str) {
        if let Ok(shortcut) = accelerator.parse::<Shortcut>()
            && let Err(e) = self.app.global_shortcut().unregister(shortcut)
        {
            crate::run_log::warn("注销快捷键失败", format!("{accelerator}：{e}"));
        }
    }
}
