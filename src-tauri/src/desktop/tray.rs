//! 托盘图标与托盘菜单。

use super::*;

pub(super) const MENU_OPEN: &str = "open-main-window";
pub(super) const MENU_CAPTURE: &str = "capture";
pub(super) const MENU_PIN_CLIPBOARD: &str = "pin-clipboard";
pub(super) const MENU_EDGE_HIDE: &str = "edge-hide";
pub(super) const MENU_QUIT: &str = "quit";

/// 常驻托盘：单击图标或菜单“打开 Kinshoko”回到主窗口，“退出”结束常驻进程。
pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, MENU_OPEN, "打开 Kinshoko", true, None::<&str>)?,
            &MenuItem::with_id(app, MENU_CAPTURE, "截图", true, None::<&str>)?,
            &MenuItem::with_id(app, MENU_PIN_CLIPBOARD, "钉剪贴板", true, None::<&str>)?,
            &MenuItem::with_id(
                app,
                MENU_EDGE_HIDE,
                "贴边隐藏／显示钉图",
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Kinshoko")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => shell::open_main_window(app),
            MENU_CAPTURE => capture::start(app),
            MENU_PIN_CLIPBOARD => pins::pin_clipboard_in_background(app),
            MENU_EDGE_HIDE => edge::toggle_in_background(app),
            // 今天还没备份时先备份再退出（#69）。
            MENU_QUIT => crate::backup::quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                shell::open_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// 托盘图标上的订阅新图数量（#368）；为 0 时恢复原图标。
pub fn set_tray_badge(app: &AppHandle, count: u32) {
    let (Some(tray), Some(icon)) = (app.tray_by_id("main"), app.default_window_icon()) else {
        return;
    };
    let _ = tray.set_icon(Some(crate::subscription::badge(icon, count)));
    let tooltip = match count {
        0 => "Kinshoko".to_owned(),
        n => format!("Kinshoko ({n})"),
    };
    let _ = tray.set_tooltip(Some(tooltip));
}
