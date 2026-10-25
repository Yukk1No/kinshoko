//! 钉图的帧、通知与关闭。

use super::*;

/// [`show`] 改之前的几何，层建不起来时改回去。
pub(super) struct Motion {
    generation: u32,
    content: ScreenRect,
    region: ScreenRect,
    settled: bool,
    motion: PinMotion,
    began: (ScreenRect, Instant),
    click_through: bool,
}

impl Motion {
    pub(super) fn of(r: &PinRecord) -> Self {
        Self {
            generation: r.generation,
            content: r.content,
            region: r.region,
            settled: r.settled,
            motion: r.motion,
            began: r.began,
            click_through: r.click_through,
        }
    }

    pub(super) fn restore(self, r: &mut PinRecord) {
        r.generation = self.generation;
        r.content = self.content;
        r.region = self.region;
        r.settled = self.settled;
        r.motion = self.motion;
        r.began = self.began;
        r.click_through = self.click_through;
    }
}

/// 给画着钉图的每个层发一帧（各层的 `window` 不同）；原生钉图推给它的编排。会查资料库，不要持有锁
/// 调用。
pub(super) fn emit_frames(app: &AppHandle, pin: &str, motion: PinMotion) {
    if is_native(app, pin) {
        if let Some(frame) = native_frame(app, pin, motion, false) {
            native::frame(app, frame);
        }
        return;
    }
    for (layer, frame) in frames(app, pin, Some(motion)) {
        let _ = app.emit_to(layer.as_str(), FRAME_EVENT, &frame);
    }
}

/// `motion` 为 `None`（层的页面中途来取）时：动画中按最新一帧的到达方式，静止时 `Jump`。
pub(super) fn frames(
    app: &AppHandle,
    pin: &str,
    motion: Option<PinMotion>,
) -> Vec<(String, PinFrame)> {
    let Some(saved) = lock(&state(app).store).get(pin).cloned() else {
        return Vec::new();
    };
    let (veiled, unavailable) = appearance(app, &saved);
    let edge_contrast = edge_contrast(app);
    let pins = lock(&state(app).pins);
    let layers = lock(&state(app).layers);
    let Some(r) = pins.get(pin) else {
        return Vec::new();
    };
    let motion = motion.unwrap_or(if r.settled { PinMotion::Jump } else { r.motion });
    let began = (!r.settled).then(|| MotionBegan {
        from: r.began.0,
        elapsed_ms: u32::try_from(r.began.1.elapsed().as_millis()).unwrap_or(u32::MAX),
    });
    r.layers
        .iter()
        .filter_map(|label| {
            let layer = layers.by_label.get(label)?;
            Some((
                label.clone(),
                PinFrame {
                    pin: saved.clone(),
                    window: layer.window,
                    content: r.content,
                    motion,
                    veiled,
                    unavailable: unavailable.clone(),
                    generation: r.generation,
                    settle: !r.settled,
                    z: r.z,
                    began,
                    edge_contrast,
                },
            ))
        })
        .collect()
}

fn is_native(app: &AppHandle, pin: &str) -> bool {
    lock(&state(app).pins).get(pin).is_some_and(|r| r.native)
}

/// 原生钉图（[`native`]）的一帧：钉图状态、内容要到哪、外观。会查资料库，不要持有锁调用。
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
    }
}

/// 给画着钉图的每个层发一条提示。
pub(super) fn notify(app: &AppHandle, pin: &str, text: &str) {
    let layers = lock(&state(app).pins)
        .get(pin)
        .map(|r| r.layers.clone())
        .unwrap_or_default();
    for layer in layers {
        let _ = app.emit_to(
            layer.as_str(),
            NOTICE_EVENT,
            serde_json::json!({ "pin": pin, "text": text }),
        );
    }
}

/// 当前这一帧（不改窗口），以钉图的第一个层为准；钉图不在任何层里时为 `None`。原生钉图没有层，
/// 窗口按内容算。
pub(super) fn current_frame(app: &AppHandle, pin: &str) -> Option<PinFrame> {
    if is_native(app, pin) {
        let f = native_frame(app, pin, PinMotion::Jump, false)?;
        let z = lock(&state(app).pins).get(pin).map_or(0, |r| r.z);
        return Some(PinFrame {
            pin: f.pin,
            window: f.content,
            content: f.content,
            motion: f.motion,
            veiled: f.look.veiled,
            unavailable: f.look.unavailable,
            generation: 0,
            settle: false,
            z,
            began: None,
            edge_contrast: f.look.edge_contrast,
        });
    }
    frames(app, pin, Some(PinMotion::Jump))
        .into_iter()
        .next()
        .map(|(_, f)| f)
}

/// 改了透明度、锁定、遮蔽或上下次序之后：各层重画这个钉图。
pub(super) fn refresh(app: &AppHandle, pin: &str) {
    emit_frames(app, pin, PinMotion::Jump);
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

/// 关闭钉图（Esc、菜单、Alt+F4）：各层放手，不再恢复，截图不再被它钉住。在别的线程上调用。
pub(super) fn close(app: &AppHandle, pin: &str) {
    crate::library::with_visibility_commit(app, |_| mark_closing(app, pin));
    if lock(&state(app).pins).get(pin).is_some_and(|r| r.native) {
        native::close(app, pin);
    }
    let arranging = lock(&ARRANGING);
    let layers = lock(&state(app).pins)
        .get_mut(pin)
        .map(|r| {
            r.entering.clear();
            r.leaving.clear();
            std::mem::take(&mut r.layers)
        })
        .unwrap_or_default();
    remember_layers(pin, &[]);
    finish(
        app,
        &Touched {
            layers: Vec::new(),
            gone: layers.into_iter().map(|l| (l, pin.to_owned())).collect(),
        },
    );
    drop(arranging);
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
