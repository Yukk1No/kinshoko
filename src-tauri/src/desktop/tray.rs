//! 托盘图标与托盘菜单。

use super::*;
use crate::ui_text::{Text, text};

pub(super) const MENU_OPEN: &str = "open-main-window";
pub(super) const MENU_CAPTURE: &str = "capture";
pub(super) const MENU_PIN_CLIPBOARD: &str = "pin-clipboard";
pub(super) const MENU_EDGE_HIDE: &str = "edge-hide";
pub(super) const MENU_QUIT: &str = "quit";
/// 参考组改成桌面（#593）：`desk-group:<参考组 id>` 切换过去，`desk-new` 换到空桌。
const MENU_DESK_GROUP: &str = "desk-group:";
const MENU_DESK_NEW: &str = "desk-new";

/// 托盘菜单，文字按当前界面语言。
fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, label: Text| MenuItem::with_id(app, id, text(label), true, None::<&str>);
    let menu = Menu::with_items(
        app,
        &[
            &item(MENU_OPEN, Text::TrayOpen)?,
            &item(MENU_CAPTURE, Text::TrayCapture)?,
            &item(MENU_PIN_CLIPBOARD, Text::TrayPinClipboard)?,
            &item(MENU_EDGE_HIDE, Text::TrayEdgeHide)?,
        ],
    )?;
    // 参考组那一段（#593）：切换列表里最近的几个，桌面上的那个打勾。
    if let Some(groups) = desk_commands::tray_groups(app) {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        for (id, label, on_desk) in groups {
            let entry = tauri::menu::CheckMenuItem::with_id(
                app,
                format!("{MENU_DESK_GROUP}{id}"),
                label,
                true,
                on_desk,
                None::<&str>,
            )?;
            menu.append(&entry)?;
        }
        menu.append(&item(MENU_DESK_NEW, Text::NewGroup)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&item(MENU_QUIT, Text::TrayQuit)?)?;
    Ok(menu)
}

/// 界面语言换了：托盘菜单换成新语言的文字。
pub fn relabel_tray(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("main") else {
        return;
    };
    match tray_menu(app) {
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                crate::run_log::warn("无法更新托盘菜单", e);
            }
        }
        Err(e) => crate::run_log::warn("无法更新托盘菜单", e),
    }
}

/// 常驻托盘：单击图标或菜单“打开 Kinshoko”回到主窗口，“退出”结束常驻进程。
pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = tray_menu(app)?;
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
            MENU_DESK_NEW => desk_commands::switch_from_tray(app, None),
            id => {
                if let Some(group) = id.strip_prefix(MENU_DESK_GROUP) {
                    desk_commands::switch_from_tray(app, Some(group.to_owned()));
                }
            }
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
