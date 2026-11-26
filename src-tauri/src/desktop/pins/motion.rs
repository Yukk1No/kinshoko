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

/// 钉图内容此刻（或动画结束时）在屏幕上的位置。
pub(super) fn content_of(app: &AppHandle, pin: &str) -> Option<ScreenRect> {
    lock(&state(app).pins).get(pin).map(|r| r.content)
}

pub(super) fn mark_closing(app: &AppHandle, pin: &str) {
    if let Some(record) = lock(&state(app).pins).get_mut(pin) {
        record.closing = true;
    }
}

/// 关闭钉图（Esc、菜单、Alt+F4）：先把关闭意图写进桌面上的参考组，窗口动作交给对齐模块。
/// 在别的线程上调用。
pub(super) fn close(app: &AppHandle, pin: &str) {
    let history_updated = crate::library::with_visibility_commit(app, |_| {
        mark_closing(app, pin);
        let updated = lock(&state(app).store).close(pin, &mut lock(&state(app).history));
        state(app).dirty.store(true, Ordering::Relaxed);
        updated
    });
    if history_updated {
        history_changed(app);
    }
    super::alignment::submit(app, super::alignment::AlignIntent::Close);
}

/// 收掉本次运行的钉图记录（窗口可能已经关了，也可能关闭还在路上）。
fn retire(app: &AppHandle, pin: &str) {
    crate::library::with_visibility_commit(app, |_| {
        lock(&state(app).pins).remove(pin);
        lock(&state(app).veils).forget(pin);
        lock(&state(app).edge).release(pin);
    });
    stop_waiting(app, pin);
}

/// 对齐模块决定关掉这张窗口：收掉本次运行的记录并通知原生钉图，钉图状态不动（调用方已改好）。
/// 在别的线程上调用。
pub(in crate::desktop) fn dismiss(app: &AppHandle, pin: &str) {
    retire(app, pin);
    native::close(app, pin);
}

/// 钉图没了，但没有关闭动作要做（打开失败，或原生窗口已经关上）。状态留着，下次启动恢复。
pub(super) fn closed(app: &AppHandle, pin: &str) {
    retire(app, pin);
}
