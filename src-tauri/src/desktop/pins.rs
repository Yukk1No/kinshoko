//! 桌面钉图窗口：截图钉图、钉剪贴板（F3）、拖动与缩放、翻转旋转、右键菜单（翻转、旋转、透明度、
//! 锁定、收藏、复制、关闭，#64；#106 起改由与主窗口同样式的菜单窗口承载，见 [`super::menu`]），
//! 以及重新打开后的恢复（#63）。
//!
//! 每张钉图是一个原生窗口，用 wgpu 绘制（[`native`]，ADR 0013）：窗口、输入、动画与绘制都在那边，
//! 这里管钉图状态、截图历史与资料库的核对，几何或外观每次变化都经 [`show`]／[`refresh`] 推给它一帧。
//! 钉图状态在 [`PinStore`]（`pins.json`）里：画师关闭的钉图从中删除；退出程序时钉图窗口也会销毁，
//! 但这时不删，下次启动照原样恢复。
//!
//! 资料库钉图（#65）：从查看器钉整图或框出的局部（原图像素）。图经参考视角读取（[`reference_file`]），
//! 只给已钉住的图，不按任意 id 给。安全模式开启时
//! 被封印的图（以及资料库没打开、核对不了的图）原位遮蔽，画师确认后显示这一张；
//! 安全模式关掉后不再遮蔽，再开启时重新遮蔽。
//!
//! 拖动和缩放由原生钉图自己的指针输入驱动（笔与鼠标同一套处理；Windows Ink 下没有系统拖动需要的
//! 鼠标事件，#7）。

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Condvar, Mutex};
use std::time::Instant;

use image::RgbaImage;
use kinshoko_core::desktop::{
    CaptureEntry, CaptureSurface, OpenInKinshoko, PinContent, PinMenu, PinMotion, Placement,
    Region, SavedPin, ScreenRect, Screenshot, Turn, initial_scale, place_new_pin,
};
use kinshoko_core::reference_groups::ReferenceSource;
use tauri::{AppHandle, Manager};

use super::{history_changed, lock, request_collection, request_open, state};
use kinshoko_core::diagnostics::{LogEvent, PinSource};

mod commands;
pub use commands::*;
mod menu_actions;
pub use menu_actions::*;
mod motion;
pub use motion::*;
mod native;
mod opening;
pub use opening::*;

/// 新钉图相对原位置错开的距离，逻辑像素（按显示器缩放换算成物理像素）。
const OFFSET: f64 = 16.0;
/// F1 登记原生钉图时用的“窗口”名：原生钉图没有 WebView 窗口，遮挡按窗口句柄查。
const NATIVE_SURFACE: &str = "native-pin";
const CLOSED: &str = "钉图已关闭";
const LOCKED: &str = "钉图已锁定";

/// 本次运行中打开着的钉图。
pub struct PinRecord {
    /// 钉住的截图；资料库钉图为 `None`。
    capture_id: Option<String>,
    /// 画师正在关闭它（菜单、Esc 或 Alt+F4）。
    closing: bool,
    /// 钉图内容要到（或已在）的位置。收起、滑出时不同于原位。
    content: ScreenRect,
    /// 让点击穿过（收起且没滑出时）。
    click_through: bool,
    /// 第一帧已经显示出来（[`wait_shown`]）。
    shown: bool,
}

/// 显示器的矩形与缩放比例。
pub fn monitor_at(x: i32, y: i32) -> Option<(ScreenRect, f64)> {
    let m = xcap::Monitor::from_point(x, y).ok()?;
    Some((
        ScreenRect {
            x: m.x().ok()?,
            y: m.y().ok()?,
            width: m.width().ok()?,
            height: m.height().ok()?,
        },
        f64::from(m.scale_factor().ok()?),
    ))
}

/// 全部显示器的矩形。
pub fn monitors() -> Vec<ScreenRect> {
    xcap::Monitor::all()
        .unwrap_or_default()
        .iter()
        .filter_map(|m| {
            Some(ScreenRect {
                x: m.x().ok()?,
                y: m.y().ok()?,
                width: m.width().ok()?,
                height: m.height().ok()?,
            })
        })
        .collect()
}

/// 已打开钉图的状态（按 [`PinStore`] 的先后）。
pub fn open_pins(app: &AppHandle) -> Vec<SavedPin> {
    let open: Vec<String> = lock(&state(app).pins).keys().cloned().collect();
    lock(&state(app).store)
        .pins()
        .iter()
        .filter(|p| open.contains(&p.id))
        .cloned()
        .collect()
}

/// 入组后记下成员关系；已收藏的截图钉图改连参考图，保持当前几何和窗口状态。
pub fn remember_group_members(app: &AppHandle, saved: &[SavedPin]) {
    let mut converted = Vec::new();
    {
        let mut store = lock(&state(app).store);
        for pin in saved {
            store.edit(&pin.id, |p| {
                p.member = pin.member.clone();
                if p.capture_id().is_some() && matches!(pin.content, PinContent::Reference { .. }) {
                    p.content = pin.content.clone();
                    converted.push(pin.id.clone());
                }
            });
        }
        let _ = store.save();
    }
    for id in &converted {
        let capture = lock(&state(app).pins)
            .get_mut(id)
            .and_then(|r| r.capture_id.take());
        if let Some(capture) = capture {
            lock(&state(app).history).unpin(&capture);
        }
        refresh(app, id);
    }
    if !converted.is_empty() {
        history_changed(app);
    }
}

/// F1 冻结前记录可见的资料库钉图。遮蔽、不可用、收起和动画中的内容不作原图裁切。
/// 按钉图此刻显示的位置（滑出的也算）；动画、手势中与占位时不算。别的窗口（包括别的钉图）
/// 盖在上面的部分由 [`super::capture`] 按 Z 序另算。
pub(super) fn capture_surfaces(app: &AppHandle) -> Vec<super::capture::ReferenceSurface> {
    let mut surfaces = Vec::new();
    for pin in open_pins(app) {
        if !matches!(pin.content, PinContent::Reference { .. }) {
            continue;
        }
        let (veiled, unavailable) = appearance(app, &pin);
        if veiled || unavailable.is_some() {
            continue;
        }
        // 看得见的只是窗口里那部分：盖满显示器时让出的那一行是桌面。
        if let Some(seen) = native::seen(&pin.id)
            && seen.still
            && !seen.click_through
            && let Some(visible) = seen.content.intersect(&seen.window)
        {
            surfaces.push(super::capture::ReferenceSurface {
                window: NATIVE_SURFACE.into(),
                hwnd: Some(seen.hwnd),
                selection: CaptureSurface {
                    pin: pin.clone(),
                    shown: seen.content,
                    visible,
                    covered: Vec::new(),
                },
            });
        }
    }
    surfaces
}

/// 从 F1 的参考视图裁切建立新钉图，仍连接原库与原图，不进入截图历史。
pub(super) fn open_reference_selection(
    app: &AppHandle,
    mut pin: SavedPin,
    at: ScreenRect,
) -> Result<String, String> {
    let (monitor, dpi) = monitor_at(at.x, at.y).unwrap_or((at, 1.0));
    pin.placement.scale = initial_scale(pin.width, pin.height, monitor);
    let (width, height) = pin.window_size();
    let origin = ScreenRect {
        x: at.x,
        y: at.y,
        width,
        height,
    };
    let others: Vec<_> = open_pins(app).iter().map(SavedPin::rect).collect();
    let (x, y) = place_new_pin(origin, monitor, &others, (OFFSET * dpi).round() as i32);
    pin.placement.x = x;
    pin.placement.y = y;
    {
        let mut store = lock(&state(app).store);
        store.put(pin.clone());
        let _ = store.save();
    }
    open_pin(app, &pin);
    Ok(pin.id)
}

/// 正在等第一帧的新钉图（id → 已显示）。只登记有人等的钉图，原生钉图显示出第一帧时唤醒
/// （[`stop_waiting`]）。
#[derive(Default)]
pub struct ShownWaiters {
    pins: Mutex<HashMap<String, bool>>,
    changed: Condvar,
}

/// 钉图放到最上面。
pub(super) fn raise(app: &AppHandle, pin: &str) {
    native::raise(app, pin);
}

/// 等新钉图的第一帧画好、显示出来，最多 `timeout`。钉图已关、打不开时立即返回。
/// 只在后台线程调用；不轮询窗口状态，免得和建窗口抢主线程。
pub(super) fn wait_shown(app: &AppHandle, pin: &str, timeout: std::time::Duration) {
    let waiters = &state(app).pin_shown;
    lock(&waiters.pins).insert(pin.to_owned(), false);
    // 登记之前就已显示（或钉图已不在）时不必等。
    let pending = lock(&state(app).pins).get(pin).is_some_and(|r| !r.shown);
    let mut pins = lock(&waiters.pins);
    if pending {
        pins = waiters
            .changed
            .wait_timeout_while(pins, timeout, |pins| pins.get(pin) == Some(&false))
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
    pins.remove(pin);
}

/// 钉图内容到 `content`，收起且没滑出时 `click_through`：记下内容要到哪，把一帧推给原生钉图，
/// 它按 `motion` 动画或直接到（#285）。钉图已关闭时什么都不做。
pub fn show(
    app: &AppHandle,
    pin: &str,
    content: ScreenRect,
    motion: PinMotion,
    click_through: bool,
) {
    {
        let mut pins = lock(&state(app).pins);
        let Some(r) = pins.get_mut(pin) else {
            return;
        };
        r.content = content;
        r.click_through = click_through;
    }
    if let Some(frame) = native_frame(app, pin, motion, true) {
        native::frame(app, frame);
    }
}

/// Called at the final commit while holding visibility authority. Physical Destroyed
/// notifications remain asynchronous; a closing or removed record cannot authorize a crop.
pub(super) fn capture_source_open(app: &AppHandle, pin: &str) -> bool {
    lock(&state(app).pins)
        .get(pin)
        .is_some_and(|record| !record.closing)
}

/// 启动时恢复上次的钉图（位置、裁切、缩放、翻转与旋转）。在别的线程上调用。
pub fn restore(app: &AppHandle) {
    // 设置在桌面插件装配之后才可读：恢复前按保存的安全模式核对一次。
    crate::library::with_visibility_commit(app, |_| {
        let safe = crate::library::safe_mode_on(app);
        let mut veils = lock(&state(app).veils);
        veils.set_safe_mode(safe);
        veils.set_scope(crate::library::safe_mode_scope(app));
    });
    let monitors = monitors();
    let pins = {
        let mut history = lock(&state(app).history);
        let mut store = lock(&state(app).store);
        let pins = store.restore(&mut history, &monitors);
        let _ = store.save();
        pins
    };
    if pins.is_empty() {
        return;
    }
    history_changed(app);
    // 资料库钉图要经参考视角读图、核对遮蔽：先打开本设备上次打开的资料库。
    if pins.iter().any(|p| p.capture_id().is_none())
        && let Err(e) = crate::library::current_or_last(app)
    {
        crate::run_log::error("恢复资料库钉图时无法打开资料库", e);
    }
    for pin in &pins {
        open_pin(app, pin);
    }
}
