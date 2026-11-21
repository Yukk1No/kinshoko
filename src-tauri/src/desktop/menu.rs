//! 钉图的统一样式菜单窗口（#102 T5，#106）。
//!
//! 钉图窗口小且透明，菜单不在里面渲染：右键（笔侧键、按住不动）时，应用壳把一个置顶、无边框、
//! 透明、不进任务栏的菜单窗口（[`MENU_WINDOW`]，页面 `?view=desktop-menu`）铺满指针所在的显示器
//! （[`menu_surface`]），把这次菜单（[`PinMenuOpen`]）发给它；页面画好菜单后调用
//! `desktop_menu_shown` 才显示窗口并给它焦点。菜单关掉（Esc、点外部、窗口失去焦点）或选中一项后
//! 窗口只隐藏，下次复用。显示、隐藏都是即时的，不带系统过渡（#194）。
//!
//! 焦点：钉图不拿焦点，菜单窗口拿着焦点关掉时（Esc、选中一项、点在菜单外的空白处），焦点交回打开
//! 菜单之前的程序。因为点了别的程序而失去焦点时不抢回来。
//!
//! 线程规则同 [`super`]：持有锁时不调用窗口 API。

use kinshoko_core::CommandError;
use kinshoko_core::command_error::ErrorKind;
use kinshoko_core::desktop::ScreenRect;
use kinshoko_core::desktop::{PinMenu, PinMenuOpen, menu_surface};
use kinshoko_core::diagnostics::{LogEvent, WindowKind};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

use super::{lock, pins, state};
use crate::data_dirs::SharedWebview as _;

pub const MENU_WINDOW: &str = "desktop-menu";
const OPEN_EVENT: &str = "desktop-menu";

/// 菜单窗口的状态：最近一次菜单的编号，以及此刻打开着的那一次。
#[derive(Default)]
pub struct MenuState {
    generation: u32,
    open: Option<PinMenuOpen>,
    previous_foreground: Option<isize>,
}

/// 在指针处为钉图弹出菜单。
pub fn popup(app: &AppHandle, menu: PinMenu) -> Result<(), CommandError> {
    #[cfg(windows)]
    let previous_foreground = super::win32::foreground_window().map(|(hwnd, _)| hwnd);
    #[cfg(not(windows))]
    let previous_foreground = None;
    let cursor = app.cursor_position().map_err(CommandError::system)?;
    let surface = menu_surface(
        (cursor.x.floor() as i32, cursor.y.floor() as i32),
        &pins::monitors(),
    )
    .ok_or_else(|| CommandError::new(ErrorKind::NoMonitor, "找不到显示器"))?;
    let open = {
        let mut menus = lock(&state(app).menu);
        menus.generation = menus.generation.wrapping_add(1);
        let open = PinMenuOpen {
            generation: menus.generation,
            surface,
            menu,
        };
        menus.previous_foreground = foreground_for_popup(
            menus.open.is_some(),
            menus.previous_foreground,
            previous_foreground,
        );
        menus.open = Some(open.clone());
        open
    };
    let window = match app.get_webview_window(MENU_WINDOW) {
        Some(window) => window,
        None => build(app)?,
    };
    place(&window, surface.window)?;
    let _ = app.emit_to(MENU_WINDOW, OPEN_EVENT, &open);
    Ok(())
}

fn foreground_for_popup(
    replacing: bool,
    saved: Option<isize>,
    captured: Option<isize>,
) -> Option<isize> {
    if replacing { saved } else { captured }
}

fn build(app: &AppHandle) -> Result<tauri::WebviewWindow, CommandError> {
    let started = std::time::Instant::now();
    let window = WebviewWindowBuilder::new(
        app,
        MENU_WINDOW,
        WebviewUrl::App("index.html?view=desktop-menu".into()),
    )
    .title(crate::ui_text::text(crate::ui_text::Text::MenuWindowTitle))
    .decorations(false)
    .transparent(true)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .shadow(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible(false)
    .shared_webview(app)
    .build()
    .map_err(CommandError::system)?;
    crate::run_log::window_created(WindowKind::PinMenu, started);
    // 显示、隐藏都要即时：系统过渡会让铺满显示器的窗口从中间放大、隐藏时边缩小边淡出，
    // 菜单就像向左滑走（#194）。三种关法最后都只是隐藏这个窗口，在这里关掉一次即可。
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        super::win32::disable_transitions(hwnd.0 as isize);
        // 铺满显示器：不标成工具窗口时，菜单开着的这一会儿背后的程序停止绘制（#275）。
        super::win32::make_tool_window(hwnd.0 as isize);
    }
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Resized(size) = event {
            keep_on_monitor(&handle, *size);
        }
    });
    Ok(window)
}

/// 移到缩放比例不同的显示器上时系统会按新比例改窗口尺寸：改回菜单窗口的矩形。
fn keep_on_monitor(app: &AppHandle, size: PhysicalSize<u32>) {
    let Some(rect) = lock(&state(app).menu)
        .open
        .as_ref()
        .map(|open| open.surface.window)
    else {
        return;
    };
    if (size.width, size.height) != (rect.width, rect.height)
        && let Some(window) = app.get_webview_window(MENU_WINDOW)
    {
        let _ = place(&window, rect);
    }
}

/// 此刻打开着的菜单（菜单窗口第一次建好、页面加载完时取）。
pub fn current(app: &AppHandle) -> Option<PinMenuOpen> {
    lock(&state(app).menu).open.clone()
}

/// 页面画好了第 `generation` 次菜单：显示菜单窗口并给它焦点。
pub fn shown(app: &AppHandle, generation: u32) {
    let current = lock(&state(app).menu)
        .open
        .as_ref()
        .is_some_and(|open| open.generation == generation);
    if current && let Some(window) = app.get_webview_window(MENU_WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 关掉第 `generation` 次菜单，返回它是哪个钉图的；不是此刻打开着的那一次时什么都不做。
/// 菜单窗口拿着焦点时，焦点交回打开菜单之前的程序。
pub fn close(app: &AppHandle, generation: u32) -> Option<String> {
    let (open, previous_foreground) = {
        let mut menus = lock(&state(app).menu);
        if menus.open.as_ref()?.generation != generation {
            return None;
        }
        (menus.open.take()?, menus.previous_foreground.take())
    };
    let pin = open.menu.pin;
    if let Some(window) = app.get_webview_window(MENU_WINDOW) {
        let focused = window.is_focused().unwrap_or(false);
        let _ = window.hide();
        crate::run_log::record(LogEvent::WindowHidden {
            window: WindowKind::PinMenu,
        });
        pins::menu_closed(app);
        super::edge::restore_menu_focus(focused, previous_foreground);
    } else {
        pins::menu_closed(app);
    }
    Some(pin)
}

/// 关掉此刻打开着的菜单（换一桌钉图之前，#591）。没有打开的菜单时什么都不做。
pub fn close_open(app: &AppHandle) {
    let generation = lock(&state(app).menu).open.as_ref().map(|o| o.generation);
    if let Some(generation) = generation {
        close(app, generation);
    }
}

/// 一次调用同时改窗口的位置与尺寸（Windows 上），免得合成出只改了一半的一帧。
fn place(window: &tauri::WebviewWindow, rect: ScreenRect) -> Result<(), CommandError> {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd()
        && super::win32::set_window_rect(hwnd.0 as isize, rect.x, rect.y, rect.width, rect.height)
    {
        return Ok(());
    }
    // 先移到目标显示器再定尺寸：跨越缩放比例不同的显示器时，移动会先按新比例改一次尺寸。
    window
        .set_position(PhysicalPosition::new(rect.x, rect.y))
        .and_then(|_| window.set_size(PhysicalSize::new(rect.width, rect.height)))
        .map_err(CommandError::system)
}

#[cfg(test)]
mod tests {
    use super::foreground_for_popup;

    #[test]
    fn replacing_a_menu_keeps_the_original_foreground() {
        assert_eq!(foreground_for_popup(true, Some(10), Some(20)), Some(10));
        assert_eq!(foreground_for_popup(true, Some(10), None), Some(10));
    }

    #[test]
    fn replacing_a_menu_without_a_return_target_keeps_it_empty() {
        assert_eq!(foreground_for_popup(true, None, Some(20)), None);
    }

    #[test]
    fn a_new_menu_records_the_current_foreground() {
        assert_eq!(foreground_for_popup(false, Some(10), Some(20)), Some(20));
        assert_eq!(foreground_for_popup(false, None, None), None);
    }
}
