//! 桌面钉图窗口：截图钉图、钉剪贴板（F3）、拖动与缩放、翻转旋转、右键菜单（翻转、旋转、透明度、
//! 锁定、收藏、复制、关闭，#64；#106 起改由与主窗口同样式的菜单窗口承载，见 [`super::menu`]），
//! 以及重新打开后的恢复（#63）。
//!
//! 钉图画在钉图层里（#193）：每台有钉图的显示器一个无边框、置顶、透明、不进任务栏的窗口（页面
//! `?view=pin-layer`），铺满显示器（[`layer_window`]），建好后不再移动；全部钉图都是层里的页面
//! 元素，层的窗口区域是各钉图区域（连同四周阴影那一圈，#239）的并集，把显示和点击限定在钉图
//! 本身。缩放、贴边滑动、拖动与翻转
//! 只在页面里移动内容并改区域：窗口原点一动，WebView2 就要晚 1～2 帧才跟上，画面先抽搐再被裁掉
//! （#193）。跨两台显示器的钉图两个层都画，各露自己那一半；拖到另一台显示器就是在拖动中交给那台的
//! 层。收起且没滑出的钉图放在同一台显示器上另一个让点击穿过的层里（其他钉图照常接点击），滑出时
//! 交回普通层；交接时新层画好它以后旧层才放手（[`pin_ready`]）。层里没有钉图了就销毁。
//! 几何的每次变化都经 [`show`] 给钉图所在的每个层发一帧（[`PinFrame`]）。
//! 层窗口先隐藏建好，层里第一个钉图画好后才显示。
//! 钉图状态在 [`PinStore`]（`pins.json`）里：画师关闭的钉图从中删除；退出程序时层窗口也会销毁，
//! 但这时不删，下次启动照原样恢复。
//!
//! 资料库钉图（#65）：从查看器钉整图或框出的局部（原图像素）。图经参考视角读取，走自定义协议
//! `capture` 的 `pin/<钉图 id>/full|fit-<像素>`——只给已钉住的图，不按任意 id 给。安全模式开启时
//! 被封印的图（以及资料库没打开、核对不了的图）原位遮蔽，画师确认后显示这一张；
//! 安全模式关掉后不再遮蔽，再开启时重新遮蔽。
//!
//! 拖动和缩放都由页面的 pointer 事件驱动、由程序移动窗口（笔与鼠标同一套处理；Windows Ink 下
//! 没有系统拖动需要的鼠标事件，#7）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Condvar, LazyLock, Mutex};
use std::time::Instant;

use image::RgbaImage;
use kinshoko_core::desktop::{
    CaptureEntry, CaptureSurface, MotionBegan, OpenInKinshoko, PinContent, PinFrame, PinMenu,
    PinMotion, Placement, Region, SavedPin, ScreenRect, Screenshot, Turn, initial_scale,
    layer_region, layer_window, layers_for, pin_area, place_new_pin, widen,
};
use kinshoko_core::reference_groups::ReferenceSource;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

use super::{history_changed, lock, request_collection, request_open, state};
use crate::data_dirs::SharedWebview as _;
use kinshoko_core::diagnostics::{LogEvent, PinSource, WindowKind};

mod commands;
pub use commands::*;
mod layers;
pub(super) use layers::*;
mod menu_actions;
pub use menu_actions::*;
mod motion;
pub use motion::*;
mod native;
mod opening;
pub use opening::*;

/// 新钉图相对原位置错开的距离，逻辑像素（按显示器缩放换算成物理像素）。
const OFFSET: f64 = 16.0;
/// 钉图层窗口的 label 前缀（`capabilities/desktop.json` 按 `pin-*` 放行）。
const LAYER_PREFIX: &str = "pin-layer-";
const NOTICE_EVENT: &str = "pin-notice";
const FRAME_EVENT: &str = "pin-frame";
/// 钉图离开了这个层（关闭、拖到别的显示器、交给另一个层）。
const GONE_EVENT: &str = "pin-gone";
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
    /// 区域（屏幕坐标）：在层里显示、接点击的范围。动画、拖动或翻转中盖住旧区域与新内容
    /// （[`widen`]），页面画完后缩回内容。
    region: ScreenRect,
    /// 页面已画好、区域已缩回内容：不在动画或拖动中。
    settled: bool,
    /// 最新一帧的编号。
    generation: u32,
    /// 最新一帧怎样到达，以及这段动画的起点与开始时刻：中途接手的层接着画同一段动画。
    motion: PinMotion,
    began: (ScreenRect, Instant),
    /// 让点击穿过（收起且没滑出时），画在让点击穿过的层里。
    click_through: bool,
    /// 钉图之间的上下次序：大的在上。
    z: u32,
    /// 画着它的钉图层（窗口 label）。
    layers: Vec<String>,
    /// 交接中：还没画好它的新层。
    entering: Vec<String>,
    /// 交接中：新层都画好它以后要放手的旧层。
    leaving: Vec<String>,
    /// 至少一个层已经画好它（[`wait_shown`]）。
    shown: bool,
    /// 原生钉图（[`native`]）：不进钉图层，窗口与绘制都在那边。
    native: bool,
}

/// 一个钉图层：铺在哪台显示器上，是否让点击穿过，窗口显示了没有。
pub struct Layer {
    monitor: ScreenRect,
    /// 层的窗口：显示器让出最下面一行（[`layer_window`]）。
    window: ScreenRect,
    through: bool,
    shown: bool,
}

/// 此刻的钉图层（窗口 label → 层）。
#[derive(Default)]
pub struct Layers {
    by_label: HashMap<String, Layer>,
    next: u32,
}

/// 一次换层（[`arrange`]）到改完窗口区域（[`finish`]）之间不让别的钉图插进来：否则一个线程刚选中
/// 某个层，另一个线程可能因为它暂时没有钉图而把它销毁。
static ARRANGING: Mutex<()> = Mutex::new(());

/// 下一个到最上面的次序。
static NEXT_Z: AtomicU32 = AtomicU32::new(1);

fn next_z() -> u32 {
    NEXT_Z.fetch_add(1, Ordering::Relaxed)
}

/// 钉图 → 画着它的层。[`label`] 只拿得到钉图 id（菜单窗口用它把焦点交回钉图），所以另记一份。
static PIN_LAYER: LazyLock<Mutex<HashMap<String, Vec<String>>>> = LazyLock::new(Mutex::default);

/// 最近打开右键菜单的钉图与打开它的层：跨屏的钉图有两个层，焦点要交回画师点的那个
/// （那个层的 `PinKeys` 记着光标下和最近按过的钉图）。
static MENU_LAYER: Mutex<Option<(String, String)>> = Mutex::new(None);

/// 打开钉图菜单的层；钉图已不在那个层里时是画着它的第一个层；不在任何层里时是一个不存在的 label。
/// 菜单窗口（[`super::menu`]）关掉时按它把焦点交回钉图。
pub fn label(pin: &str) -> String {
    let layers = lock(&PIN_LAYER);
    let layers = layers.get(pin).map(Vec::as_slice).unwrap_or_default();
    let menu = lock(&MENU_LAYER);
    menu.as_ref()
        .filter(|(p, l)| p == pin && layers.contains(l))
        .map(|(_, l)| l)
        .or(layers.first())
        .cloned()
        .unwrap_or_else(|| format!("{LAYER_PREFIX}none"))
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
/// 同一个层里压在它上面的钉图按区域算遮挡；别的窗口由 [`super::capture`] 按 Z 序另算。
/// 跨两台显示器的钉图每个层各算一份，只含这个层画着的那一半（选区要整个落在其中一半里）。
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
        let pins = lock(&state(app).pins);
        let layers = lock(&state(app).layers);
        let Some(r) = pins.get(&pin.id) else {
            continue;
        };
        if r.click_through || !r.settled {
            continue;
        }
        for (label, layer) in r
            .layers
            .iter()
            .filter_map(|l| Some((l, layers.by_label.get(l)?)))
        {
            let Some(visible) = r.content.intersect(&layer.window) else {
                continue;
            };
            let covered = pins
                .iter()
                .filter(|(id, o)| *id != &pin.id && o.z > r.z && o.layers.contains(label))
                .filter_map(|(_, o)| o.region.intersect(&layer.window))
                .collect();
            surfaces.push(super::capture::ReferenceSurface {
                window: label.clone(),
                selection: CaptureSurface {
                    pin: pin.clone(),
                    shown: r.content,
                    visible,
                    covered,
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
    open_pin(app, &pin).map(|()| pin.id)
}

/// 正在等第一帧的新钉图（id → 已显示）。只登记有人等的钉图，[`pin_ready`] 唤醒。
#[derive(Default)]
pub struct ShownWaiters {
    pins: Mutex<HashMap<String, bool>>,
    changed: Condvar,
}

/// 等新钉图的第一帧画好、显示出来（[`pin_ready`]），最多 `timeout`。钉图已关、层建失败时立即返回。
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

/// 钉图内容到 `content`，收起且没滑出时 `click_through`。
///
/// 层的窗口不动。钉图的区域现在扩到盖住旧区域与新内容，页面画完（动画结束、手势结束）后调用
/// `settle_pin` 再缩回内容，所以页面晚画的一两帧不会被裁掉（#7、#64、#193）。内容碰到别的显示器、
/// 或改为让点击穿过时换层（[`arrange`]）。
///
/// 要用的层建不起来时钉图留在原处（这里什么都不改），返回错误。钉图已关闭时什么都不做。
pub fn show(
    app: &AppHandle,
    pin: &str,
    content: ScreenRect,
    motion: PinMotion,
    click_through: bool,
) -> Result<(), String> {
    // 原生钉图的窗口由编排自己管（贴边、菜单动作等迁过去之前什么都不做，#285）。
    if lock(&state(app).pins).get(pin).is_some_and(|r| r.native) {
        return Ok(());
    }
    let _arranging = lock(&ARRANGING);
    let before = {
        let mut pins = lock(&state(app).pins);
        let Some(r) = pins.get_mut(pin) else {
            return Ok(());
        };
        let before = Motion::of(r);
        r.generation = r.generation.wrapping_add(1);
        r.began = (r.content, Instant::now());
        r.content = content;
        r.region = widen(r.region, content);
        r.settled = motion == PinMotion::Jump && r.region == content;
        r.motion = motion;
        r.click_through = click_through;
        before
    };
    let touched = match arrange(app, pin) {
        Ok(touched) => touched,
        Err(e) => {
            // arrange 只会在改钉图的层之前出错。
            if let Some(r) = lock(&state(app).pins).get_mut(pin) {
                before.restore(r);
            }
            return Err(format!("钉图层建不起来：{e}"));
        }
    };
    // 先发帧再改区域：区域只会扩大，页面晚画也不会被裁掉。
    emit_frames(app, pin, motion);
    finish(app, &touched);
    Ok(())
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
    // 在这条线程上读一次开关（会等应用壳设置装好），之后主线程上问也不用等锁。
    native::enabled(app);
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
        if let Err(e) = open_pin(app, pin) {
            crate::run_log::error("恢复钉图失败", e);
        }
    }
}
