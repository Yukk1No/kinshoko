//! 推给原生钉图的帧、提示与关闭。

use super::*;

/// 推给原生钉图（[`native`]）的一帧：钉图状态、内容要到哪、外观。会查资料库，不要持有锁调用。
/// `geometry`：应用壳改了几何（[`show`]）；为假时只刷新外观（[`refresh`]）。
pub(super) fn native_frame(
    app: &AppHandle,
    pin: &str,
    motion: PinMotion,
    geometry: bool,
) -> Option<native::Frame> {
    let saved = lock(&state(app).store).get(pin).cloned()?;
    let look = look(app, &saved);
    let pins = lock(&state(app).pins);
    let r = pins.get(pin)?;
    Some(native::Frame {
        pin: saved,
        content: r.content,
        motion,
        click_through: r.click_through,
        geometry,
        look,
    })
}

/// 钉图的外观（遮蔽、不能显示的原因、增强边缘）。会查资料库，不要持有锁调用。
pub(super) fn look(app: &AppHandle, pin: &SavedPin) -> native::Look {
    let (veiled, unavailable) = appearance(app, pin);
    native::Look {
        veiled,
        unavailable,
        edge_contrast: edge_contrast(app),
        dark: dark_theme(app),
    }
}

/// 系统是深色主题（页面的 `prefers-color-scheme` 跟着它）；读不到时按浅色。
fn dark_theme(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.theme().ok())
        .is_some_and(|t| t == tauri::Theme::Dark)
}

/// 在钉图底部显示一条提示。
pub(super) fn notify(app: &AppHandle, pin: &str, text: &str) {
    native::notice(app, pin, text);
}

/// 改了透明度、锁定或遮蔽之后：重画这个钉图。
pub(super) fn refresh(app: &AppHandle, pin: &str) {
    if let Some(frame) = native_frame(app, pin, PinMotion::Jump, false) {
        native::frame(app, frame);
    }
}

/// 资料库变了（分级、切换后的事件）：资料库钉图重新核对要不要遮蔽。在别的线程上调用。
pub fn references_changed(app: &AppHandle) {
    let ids: Vec<String> = lock(&state(app).pins)
        .iter()
        .filter(|(_, r)| r.capture_id.is_none())
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        refresh(app, &id);
    }
}

/// 设置里的“增强钉图边缘”（#239）；读不到设置时按关闭处理。
fn edge_contrast(app: &AppHandle) -> bool {
    app.try_state::<crate::shell::ShellState>()
        .and_then(|shell| shell.0.lock().ok().map(|s| s.settings.pin_edge_contrast()))
        .unwrap_or(false)
}

/// 应用设置变了（“增强钉图边缘”开关、恢复设置备份）：全部钉图立即重画，资料库钉图也重新核对
/// 要不要遮蔽。不要持有设置的锁调用。
pub fn refresh_all(app: &AppHandle) {
    let ids: Vec<String> = lock(&state(app).pins).keys().cloned().collect();
    for id in ids {
        refresh(app, &id);
    }
}

/// 安全模式（应用设置）开关了或范围（#223）调整了：不论有没有打开资料库，资料库钉图都重新
/// 核对；重新开启或收紧范围时之前确认显示的也重新遮蔽。在别的线程上调用。
pub fn safe_mode_changed(app: &AppHandle, _on: bool) {
    // Delivery can be delayed or reordered. The committed setting is the authority;
    // the command has already revoked old reveals synchronously under this same gate.
    crate::library::with_visibility_commit(app, |_| {
        let safe = crate::library::safe_mode_on(app);
        let mut veils = lock(&state(app).veils);
        veils.set_safe_mode(safe);
        veils.set_scope(crate::library::safe_mode_scope(app));
    });
    references_changed(app);
}

/// 钉图内容此刻（或动画结束时）在屏幕上的位置。
pub(super) fn content_of(app: &AppHandle, pin: &str) -> Option<ScreenRect> {
    lock(&state(app).pins).get(pin).map(|r| r.content)
}

pub(super) fn mark_closing(app: &AppHandle, pin: &str) {
    if let Some(record) = lock(&state(app).pins).get_mut(pin) {
        record.closing = true;
    }
}

/// 关闭钉图（Esc、菜单、Alt+F4）：窗口关掉，不再恢复，截图不再被它钉住。在别的线程上调用。
pub(super) fn close(app: &AppHandle, pin: &str) {
    crate::library::with_visibility_commit(app, |_| mark_closing(app, pin));
    native::close(app, pin);
    stop_waiting(app, pin);
    closed(app, pin);
}

/// 钉图没了。画师关闭的：不再恢复，截图不再被它钉住，按截图历史的规则丢弃。
/// 没建起来的：状态留着，下次启动恢复。
pub(super) fn closed(app: &AppHandle, pin: &str) {
    let history_updated = crate::library::with_visibility_commit(app, |_| {
        let Some(record) = lock(&state(app).pins).remove(pin) else {
            return false;
        };
        lock(&state(app).veils).forget(pin);
        lock(&state(app).edge).release(pin);
        if !record.closing {
            return false;
        }
        {
            let mut store = lock(&state(app).store);
            store.remove(pin);
            let _ = store.save();
        }
        if let Some(capture) = &record.capture_id {
            lock(&state(app).history).unpin(capture);
            true
        } else {
            false
        }
    });
    if history_updated {
        history_changed(app);
    }
}
