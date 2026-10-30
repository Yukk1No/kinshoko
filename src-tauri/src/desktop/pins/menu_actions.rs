//! 钉图右键菜单的动作。

use super::*;
use kinshoko_core::CommandError;
use kinshoko_core::command_error::ErrorKind;

pub(super) const ACTION_FLIP_H: &str = "flipH";
pub(super) const ACTION_FLIP_V: &str = "flipV";
pub(super) const ACTION_ROTATE_CW: &str = "rotateCw";
pub(super) const ACTION_ROTATE_CCW: &str = "rotateCcw";
pub(super) const ACTION_OPACITY: &str = "opacity:";
pub(super) const ACTION_LOCK: &str = "lock";
pub(super) const ACTION_ACTUAL_SIZE: &str = "actualSize";
pub(super) const ACTION_COLLECT: &str = "collect";
pub(super) const ACTION_COPY: &str = "copy";
pub(super) const ACTION_CLOSE: &str = "close";
pub(super) const ACTION_REVEAL: &str = "reveal";
pub(super) const ACTION_SAVE_GROUP: &str = "saveGroup";
/// #106 新增：在 Kinshoko 中打开、加入参考组（`group:<参考组 id>`）、贴边隐藏。
pub(super) const ACTION_OPEN: &str = "openInKinshoko";
pub(super) const ACTION_GROUP: &str = "group:";
pub(super) const ACTION_EDGE_HIDE: &str = "edgeHide";

/// 钉图的右键菜单（#64；#106 起与主窗口同样式）：翻转、旋转、原始大小、透明度、锁定，截图钉图的
/// 收藏与复制，资料库钉图（#65）被遮蔽时的“显示这张图”与来自参考组时的“存回参考组”，再加上
/// 在 Kinshoko 中打开、加入参考组、贴边隐藏与关闭钉图。菜单项在页面里（`src/desktop/PinMenu.tsx`）。
/// 鼠标右键、笔的侧键或笔与触摸按住不动时打开（[`native_menu`]）；菜单弹在光标（笔尖）处。
///
/// `confirm_reveal`：只问“显示这张图？”（点了遮蔽钉图上的小圆锁）。
fn popup_menu(app: &AppHandle, pin: &str, confirm_reveal: bool) -> Result<(), CommandError> {
    let saved = lock(&state(app).store)
        .get(pin)
        .cloned()
        .ok_or_else(pin_closed)?;
    let (veiled, _) = appearance(app, &saved);
    let has_library = !crate::library::registered(app)?.is_empty();
    let group = saved
        .member
        .as_ref()
        .and_then(|m| super::super::groups::group_name(app, &m.group_id));
    let menu = PinMenu {
        confirm_reveal,
        ..PinMenu::new(&saved, veiled, has_library, group)
    };
    super::super::menu::popup(app, menu)
}

/// 钉图要开菜单（右键、笔侧键、按住；编排已停止键盘钩子拦键），或点了小圆锁要确认显示
/// （`confirm_reveal`）：在别的线程上弹出。弹不出来时键盘钩子恢复拦键。
pub(super) fn native_menu(app: &AppHandle, pin: &str, confirm_reveal: bool) {
    let (app, pin) = (app.clone(), pin.to_owned());
    std::thread::spawn(move || {
        if let Err(e) = popup_menu(&app, &pin, confirm_reveal) {
            native::menu_closed(&app);
            crate::run_log::warn("打不开钉图菜单", e);
        }
    });
}

/// 菜单关掉了：键盘钩子恢复拦键；菜单拿着焦点时焦点交回原来的程序（钉图不拿焦点）。
pub fn menu_closed(app: &AppHandle, focused: bool) {
    native::menu_closed(app);
    if focused {
        super::super::edge::hand_back_focus();
    }
}

/// 选了钉图菜单里的一项：先收起菜单窗口（焦点交回钉图），再在别的线程上做这件事。
/// 不是此刻打开着的那一次菜单（已经关掉、又开了新的）时不做。
#[tauri::command]
pub async fn pin_menu_action(
    app: AppHandle,
    pin: String,
    action: String,
    generation: u32,
) -> Result<(), CommandError> {
    if super::super::menu::close(&app, generation).as_deref() != Some(pin.as_str()) {
        return Ok(());
    }
    std::thread::spawn(move || {
        if action == ACTION_CLOSE {
            close(&app, &pin);
            return;
        }
        if let Some(notice) = menu_action(&app, &pin, &action) {
            notify(&app, &pin, &notice);
        }
    });
    Ok(())
}

/// 做菜单里的一项；返回要在钉图上提示的话。
pub(super) fn menu_action(app: &AppHandle, pin: &str, action: &str) -> Option<String> {
    let turn = match action {
        ACTION_FLIP_H => Some(Turn::FlipHorizontal),
        ACTION_FLIP_V => Some(Turn::FlipVertical),
        ACTION_ROTATE_CW => Some(Turn::RotateClockwise),
        ACTION_ROTATE_CCW => Some(Turn::RotateCounterClockwise),
        _ => None,
    };
    if let Some(turn) = turn {
        return turn_here(app, pin, turn).err().map(|e| e.to_string());
    }
    if let Some(group_id) = action.strip_prefix(ACTION_GROUP) {
        return Some(add_to_group(app, pin, group_id));
    }
    if let Some(percent) = action.strip_prefix(ACTION_OPACITY) {
        let percent: f64 = percent.parse().ok()?;
        edit(app, pin, |p| p.set_opacity(percent / 100.0))?;
        refresh(app, pin);
        return None;
    }
    match action {
        ACTION_LOCK => {
            let locked = edit(app, pin, |p| {
                p.locked = !p.locked;
                p.locked
            })?;
            refresh(app, pin);
            Some(if locked { "已锁定" } else { "已解锁" }.to_owned())
        }
        ACTION_ACTUAL_SIZE => zoom(app, pin, 1.0).err().map(|e| e.to_string()),
        ACTION_REVEAL => reveal_here(app, pin).err().map(|e| e.to_string()),
        ACTION_OPEN => {
            let saved = lock(&state(app).store).get(pin).cloned()?;
            request_open(app, OpenInKinshoko::of(&saved));
            None
        }
        ACTION_EDGE_HIDE => {
            super::super::edge::toggle_in_background(app);
            None
        }
        ACTION_SAVE_GROUP => {
            let group_id = lock(&state(app).store).get(pin)?.member.clone()?.group_id;
            Some(match super::super::groups::save_back(app, &group_id) {
                Ok(group) => format!("已存回参考组「{}」", group.name),
                Err(e) => e.to_string(),
            })
        }
        ACTION_COLLECT => {
            let capture_id = lock(&state(app).pins)
                .get(pin)
                .and_then(|r| r.capture_id.clone())?;
            request_collection(app, &capture_id);
            Some("请在主窗口选择保存位置".into())
        }
        ACTION_COPY => {
            let capture_id = lock(&state(app).pins)
                .get(pin)
                .and_then(|r| r.capture_id.clone());
            let copied = match capture_id {
                Some(capture_id) => copy_capture_image(app, &capture_id),
                None => copy_reference_pin(app, pin),
            };
            Some(match copied {
                Ok(()) => "已复制".to_owned(),
                Err(e) => e.to_string(),
            })
        }
        _ => None,
    }
}

/// 把截图历史中的一张截图复制到剪贴板（钉图菜单与截图历史条目菜单的“复制”）。会读文件。
pub(in crate::desktop) fn copy_capture_image(
    app: &AppHandle,
    capture_id: &str,
) -> Result<(), CommandError> {
    let file = lock(&state(app).history)
        .file(capture_id)
        .ok_or_else(|| CommandError::new(ErrorKind::CaptureUnknown, "截图已不在截图历史中"))?;
    let image = image::open(file).map_err(CommandError::from)?.to_rgba8();
    copy_to_clipboard(app, &image)
}

/// 复制资料库钉图（#289）：钉图显示的那一块原图像素（局部钉图只取局部，不带翻转旋转）。经浏览视角：
/// 被封印、原文件不在时报错，剪贴板保持原样。会读文件。
fn copy_reference_pin(app: &AppHandle, pin: &str) -> Result<(), CommandError> {
    let saved = lock(&state(app).store)
        .get(pin)
        .cloned()
        .ok_or_else(pin_closed)?;
    let PinContent::Reference {
        library_id,
        image_id,
        ..
    } = &saved.content
    else {
        return Err(pin_closed());
    };
    if appearance(app, &saved).0 {
        return Err(CommandError::new(
            ErrorKind::CopySealed,
            "安全模式下已遮蔽，不能复制",
        ));
    }
    let pixels = crate::library::visible_source(app, library_id, image_id)?
        .clipboard_pixels(image_id)
        .map_err(CommandError::from)?;
    let pixels = match saved.crop {
        Some(c) => image::imageops::crop_imm(&pixels, c.x, c.y, c.width, c.height).to_image(),
        None => pixels,
    };
    let prepared = super::super::clipboard::PreparedImage::prepare(&pixels)?;
    // 解码期间安全模式或分级可能变了：在可见性提交里重新核对后才写剪贴板。
    crate::library::with_visibility_commit(app, |_| {
        crate::library::visible_source(app, library_id, image_id)?;
        prepared.commit(app)
    })
}

/// 把这一个资料库钉图加进参考组 `group_id`（钉图菜单“加入参考组 ▸”）：保留它此刻的局部与摆放，
/// 参考组的其他成员不变。截图钉图要先收藏进图库。返回要在钉图上提示的话。
pub(super) fn add_to_group(app: &AppHandle, pin: &str, group_id: &str) -> String {
    let Some(saved) = lock(&state(app).store).get(pin).cloned() else {
        return CLOSED.to_owned();
    };
    if saved.capture_id().is_some() {
        return "截图要先收藏进图库，才能加入参考组".to_owned();
    }
    let mut one = [saved];
    let result = lock(&state(app).groups).save_pins(group_id, &mut one);
    match result {
        Ok(group) => {
            remember_group_members(app, &one);
            super::super::reference_groups_changed(app);
            format!("已加入参考组「{}」", group.name)
        }
        Err(e) => e.to_string(),
    }
}
