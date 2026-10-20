//! 桌面钉图窗口：截图钉图、钉剪贴板（F3）、拖动与缩放、翻转旋转、右键菜单（翻转、旋转、透明度、
//! 锁定、收藏、复制、关闭，#64；#106 起改由与主窗口同样式的菜单窗口承载，见 [`super::menu`]），
//! 以及重新打开后的恢复（#63）。
//!
//! 钉图画在钉图层里（#193）：每台有钉图的显示器一个无边框、置顶、透明、不进任务栏的窗口（页面
//! `?view=pin-layer`），铺满显示器（[`layer_window`]），建好后不再移动；全部钉图都是层里的页面
//! 元素，层的窗口区域是各钉图区域的并集，把显示和点击限定在钉图本身。缩放、贴边滑动、拖动与翻转
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
    layer_region, layer_window, layers_for, place_new_pin, widen,
};
use kinshoko_core::reference_groups::ReferenceSource;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

use super::{history_changed, lock, request_collection, request_open, state};
use crate::data_dirs::SharedWebview as _;

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
/// 跨两台显示器的钉图只算内容中心所在的那一半。
pub(super) fn capture_surfaces(app: &AppHandle) -> Vec<super::capture::ReferenceSurface> {
    open_pins(app)
        .into_iter()
        .filter_map(|pin| {
            if !matches!(pin.content, PinContent::Reference { .. }) {
                return None;
            }
            let (veiled, unavailable) = appearance(app, &pin);
            if veiled || unavailable.is_some() {
                return None;
            }
            let pins = lock(&state(app).pins);
            let layers = lock(&state(app).layers);
            let r = pins.get(&pin.id)?;
            if r.click_through || !r.settled {
                return None;
            }
            let centre = ScreenRect {
                x: r.content.x + (r.content.width / 2) as i32,
                y: r.content.y + (r.content.height / 2) as i32,
                width: 1,
                height: 1,
            };
            let (label, layer) = r
                .layers
                .iter()
                .filter_map(|l| Some((l, layers.by_label.get(l)?)))
                .find(|(_, l)| l.window.contains(&centre))?;
            let covered = pins
                .iter()
                .filter(|(id, o)| *id != &pin.id && o.z > r.z && o.layers.contains(label))
                .filter_map(|(_, o)| o.region.intersect(&layer.window))
                .collect();
            Some(super::capture::ReferenceSurface {
                window: label.clone(),
                selection: CaptureSurface {
                    pin,
                    shown: r.content,
                    visible: r.content.intersect(&layer.window)?,
                    covered,
                },
            })
        })
        .collect()
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

/// 改一个钉图的状态并安排保存。钉图不在时为 `None`。
fn edit<T>(app: &AppHandle, pin: &str, f: impl FnOnce(&mut SavedPin) -> T) -> Option<T> {
    let out = lock(&state(app).store).edit(pin, f);
    if out.is_some() {
        state(app).dirty.store(true, Ordering::Relaxed);
    }
    out
}

/// 把截图历史中的一张截图钉到桌面，返回新钉图的 id。`at` 是图片原本在屏幕上的位置（物理像素）；
/// 新钉图略微偏离它，并避开已有钉图（[`place_new_pin`]）。
pub fn open(app: &AppHandle, capture: &CaptureEntry, at: ScreenRect) -> Result<String, String> {
    let center = (at.x + (at.width / 2) as i32, at.y + (at.height / 2) as i32);
    let (monitor, scale) = monitor_at(center.0, center.1)
        .or_else(|| monitor_at(at.x, at.y))
        .unwrap_or((at, 1.0));
    let step = (OFFSET * scale).round() as i32;
    let others: Vec<ScreenRect> = open_pins(app).iter().map(SavedPin::rect).collect();
    let (x, y) = place_new_pin(at, monitor, &others, step);

    let pin = SavedPin {
        id: uuid::Uuid::new_v4().simple().to_string(),
        content: PinContent::Capture {
            capture_id: capture.id.clone(),
        },
        crop: None,
        width: capture.width,
        height: capture.height,
        placement: Placement {
            x,
            y,
            ..Placement::default()
        },
        opacity: 1.0,
        locked: false,
        member: None,
    };
    lock(&state(app).history).pin(&capture.id);
    {
        let mut store = lock(&state(app).store);
        store.put(pin.clone());
        let _ = store.save();
    }
    history_changed(app);
    open_pin(app, &pin).map(|()| pin.id)
}

/// 从查看器把资料库中的一张参考图钉到桌面：整图（`crop` 为 `None`）或局部（原图像素）。
/// `shown` 是这块在查看器里此刻的位置（物理像素，相对查看器窗口客户区）；新钉图以它为中心、
/// 略微错开，放不下时缩到显示器的五分之三。只钉浏览视角下看得见的图。
fn pin_reference_here(
    app: &AppHandle,
    window: &tauri::Window,
    library_id: &str,
    image_id: &str,
    crop: Option<Region>,
    shown: ScreenRect,
) -> Result<(), String> {
    crate::library::visible_source(app, library_id, image_id)?
        .image(image_id)
        .map_err(|e| e.to_string())?;
    let image = crate::library::with_references(app, |refs| refs.image(library_id, image_id))
        .map_err(|e| e.to_string())?;
    let origin = window.inner_position().map_err(|e| e.to_string())?;
    let centre = (
        origin.x + shown.x + (shown.width / 2) as i32,
        origin.y + shown.y + (shown.height / 2) as i32,
    );
    let (monitor, dpi) = monitor_at(centre.0, centre.1).unwrap_or((
        ScreenRect {
            x: centre.0,
            y: centre.1,
            width: shown.width.max(1),
            height: shown.height.max(1),
        },
        1.0,
    ));
    let mut pin = SavedPin::reference(
        &uuid::Uuid::new_v4().simple().to_string(),
        library_id,
        &image,
        crop,
        Placement::default(),
    )
    .map_err(|e| e.to_string())?;
    pin.placement.scale = initial_scale(pin.width, pin.height, monitor);
    let (width, height) = pin.window_size();
    let at = ScreenRect {
        x: centre.0 - (width / 2) as i32,
        y: centre.1 - (height / 2) as i32,
        width,
        height,
    };
    let others: Vec<ScreenRect> = open_pins(app).iter().map(SavedPin::rect).collect();
    let (x, y) = place_new_pin(at, monitor, &others, (OFFSET * dpi).round() as i32);
    pin.placement.x = x;
    pin.placement.y = y;
    {
        let mut store = lock(&state(app).store);
        store.put(pin.clone());
        let _ = store.save();
    }
    open_pin(app, &pin)
}

/// 钉图此刻要不要原位遮蔽（见 [`PinFrame::veiled`]、[`kinshoko_core::desktop::PinVeils`]），以及暂时
/// 不能显示的原因（[`PinFrame::unavailable`]）。资料库钉图经参考视角核对：活动资料库现取句柄，
/// 未激活的已登记资料库只读打开（#66）。会查资料库，不要持有桌面状态的锁调用。
fn appearance(app: &AppHandle, pin: &SavedPin) -> (bool, Option<String>) {
    // 核对不了（资料库没登记、不可用、图已不在）时 sealed 为 None，安全模式开启时按被封印处理。
    let (sealed, unavailable) = match &pin.content {
        PinContent::Reference {
            library_id,
            image_id,
            ..
        } => match crate::library::with_references(app, |refs| refs.image(library_id, image_id)) {
            Ok(image) => (Some(image.sealed), None),
            Err(reason) => (None, Some(reason.to_string())),
        },
        PinContent::Capture { .. } => (Some(false), None),
    };
    (lock(&state(app).veils).veiled(pin, sealed), unavailable)
}

/// 资料库钉图要显示的文件（`capture` 协议的 `pin/<钉图 id>/full|fit-<像素>`）。经参考视角读取；
/// 资料库没有激活时只读打开它（不切换活动库，#66）。会读文件，不要在主线程上调用。
pub fn reference_file(app: &AppHandle, pin: &str, size: &str) -> Option<std::path::PathBuf> {
    let saved = lock(&state(app).store).get(pin).cloned()?;
    let PinContent::Reference {
        library_id,
        image_id,
        ..
    } = &saved.content
    else {
        return None;
    };
    let lens = crate::library::with_references(app, |refs| refs.lens(library_id)).ok()?;
    let file = if size == "full" {
        lens.display(image_id)
    } else {
        lens.display_scaled(image_id, size.strip_prefix("fit-")?.parse().ok()?)
    };
    file.ok().map(|f| f.path)
}

/// 把一个钉图（新钉的、启动时恢复的、参考组里打开的）放进它所在显示器的钉图层。
/// 截图历史此前已经记下它被钉住。
pub fn open_pin(app: &AppHandle, pin: &SavedPin) -> Result<(), String> {
    super::timing("pin.window.begin");
    let rect = pin.rect();
    lock(&state(app).pins).insert(
        pin.id.clone(),
        PinRecord {
            capture_id: pin.capture_id().map(str::to_owned),
            closing: false,
            content: rect,
            region: rect,
            settled: true,
            generation: 0,
            motion: PinMotion::Jump,
            began: (rect, Instant::now()),
            click_through: false,
            z: next_z(),
            layers: Vec::new(),
            entering: Vec::new(),
            leaving: Vec::new(),
            shown: false,
        },
    );
    let _arranging = lock(&ARRANGING);
    match arrange(app, &pin.id) {
        Ok(touched) => {
            emit_frames(app, &pin.id, PinMotion::Jump);
            finish(app, &touched);
            // 新钉图要在最上面：它进的层可能已被别的程序盖住（以前每个钉图是新窗口，自然在上面）。
            for layer in &touched.layers {
                if let Some(window) = app.get_webview_window(layer) {
                    raise(&window);
                }
            }
            Ok(())
        }
        Err(e) => {
            if let Some(record) = lock(&state(app).pins).get_mut(&pin.id) {
                record.closing = true;
            }
            // A final capture commit may already hold the visibility gate. Cleanup must
            // never re-enter it or block native window construction on the main thread.
            let (app, pin) = (app.clone(), pin.id.clone());
            std::thread::spawn(move || closed(&app, &pin));
            Err(format!("无法打开钉图窗口：{e}"))
        }
    }
}

/// 一次 [`arrange`] 动过的层：要重设窗口区域的，以及钉图刚离开、要通知页面的。
#[derive(Default)]
struct Touched {
    layers: Vec<String>,
    gone: Vec<(String, String)>,
}

/// 按钉图此刻的区域与是否让点击穿过，决定哪些层画它：区域碰到的每台显示器上那一种层，没有就建。
/// 收起、滑出一开始就换层，点击马上照新状态穿过或不穿过；新层接着画同一段动画（[`MotionBegan`]）。
/// 新进的层都画好它之前，离开的层先留着（交接，[`pin_ready`]）；没有等着的新层时立即放手。
fn arrange(app: &AppHandle, pin: &str) -> Result<Touched, String> {
    let monitors = monitors();
    let Some((region, through)) = lock(&state(app).pins)
        .get(pin)
        .map(|r| (r.region, r.click_through))
    else {
        return Ok(Touched::default());
    };
    let mut wanted = Vec::new();
    for monitor in layers_for(region, &monitors) {
        wanted.push(layer_on(app, monitor, through)?);
    }
    let mut pins = lock(&state(app).pins);
    let Some(r) = pins.get_mut(pin) else {
        return Ok(Touched::default());
    };
    let entering: Vec<String> = wanted
        .iter()
        .filter(|l| !r.layers.contains(l))
        .cloned()
        .collect();
    let dropped: Vec<String> = r
        .layers
        .iter()
        .filter(|l| !wanted.contains(l))
        .cloned()
        .collect();
    r.leaving.retain(|l| !wanted.contains(l));
    r.entering.retain(|l| wanted.contains(l));
    r.entering.extend(entering.iter().cloned());
    r.layers.extend(entering);
    let mut touched = Touched {
        layers: r.layers.clone(),
        gone: Vec::new(),
    };
    if r.entering.is_empty() {
        r.layers.retain(|l| !dropped.contains(l));
        r.leaving.clear();
        touched.gone = dropped.into_iter().map(|l| (l, pin.to_owned())).collect();
    } else {
        for l in dropped {
            if !r.leaving.contains(&l) {
                r.leaving.push(l);
            }
        }
    }
    remember_layers(pin, &r.layers);
    Ok(touched)
}

fn remember_layers(pin: &str, layers: &[String]) {
    let mut map = lock(&PIN_LAYER);
    if layers.is_empty() {
        map.remove(pin);
    } else {
        map.insert(pin.to_owned(), layers.to_vec());
    }
}

/// 显示器 `monitor` 上（让点击穿过的或普通的）钉图层；还没有时建一个（先隐藏）。不要持有锁调用。
fn layer_on(app: &AppHandle, monitor: ScreenRect, through: bool) -> Result<String, String> {
    let (label, window_rect) = {
        let mut layers = lock(&state(app).layers);
        if let Some((label, _)) = layers
            .by_label
            .iter()
            .find(|(_, l)| l.monitor == monitor && l.through == through)
        {
            return Ok(label.clone());
        }
        layers.next += 1;
        let label = format!("{LAYER_PREFIX}{}", layers.next);
        let window = layer_window(monitor);
        layers.by_label.insert(
            label.clone(),
            Layer {
                monitor,
                window,
                through,
                shown: false,
            },
        );
        (label, window)
    };
    let built = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App("index.html?view=pin-layer".into()),
    )
    .title("Kinshoko 钉图")
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
    .build();
    let window = match built {
        Ok(w) => w,
        Err(e) => {
            lock(&state(app).layers).by_label.remove(&label);
            return Err(e.to_string());
        }
    };
    let handle = app.clone();
    let layer = label.clone();
    window.on_window_event(move |event| match event {
        // Alt+F4 关掉层里最上面的钉图，不关整个层。
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let (app, layer) = (handle.clone(), layer.clone());
            std::thread::spawn(move || {
                if let Some(pin) = top_pin(&app, &layer) {
                    close(&app, &pin);
                }
            });
        }
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => keep_layer(&handle, &layer),
        WindowEvent::Destroyed => forget_layer(&handle, &layer),
        _ => {}
    });
    place(&window, window_rect)?;
    set_region(&window, &[]);
    if through {
        let _ = window.set_ignore_cursor_events(true);
    }
    Ok(label)
}

/// 层里最上面的钉图。
fn top_pin(app: &AppHandle, layer: &str) -> Option<String> {
    lock(&state(app).pins)
        .iter()
        .filter(|(_, r)| r.layers.iter().any(|l| l == layer))
        .max_by_key(|(_, r)| r.z)
        .map(|(id, _)| id.clone())
}

/// 给钉图离开的层发通知，重设动过的层的窗口区域，销毁没有钉图了的层。不要持有锁调用。
fn finish(app: &AppHandle, touched: &Touched) {
    for (layer, pin) in &touched.gone {
        let _ = app.emit_to(layer.as_str(), GONE_EVENT, pin);
    }
    let mut labels: Vec<&String> = touched.layers.iter().collect();
    labels.extend(touched.gone.iter().map(|(l, _)| l));
    labels.sort();
    labels.dedup();
    let mut empty = Vec::new();
    let regions: Vec<(String, Vec<Rect>)> = {
        let pins = lock(&state(app).pins);
        let layers = lock(&state(app).layers);
        labels
            .into_iter()
            .filter_map(|label| {
                let layer = layers.by_label.get(label)?;
                let mut inside = pins
                    .values()
                    .filter(|r| r.layers.contains(label))
                    .map(|r| r.region)
                    .peekable();
                if inside.peek().is_none() {
                    empty.push(label.clone());
                }
                let regions: Vec<ScreenRect> = inside.collect();
                Some((label.clone(), layer_region(layer.window, &regions)))
            })
            .collect()
    };
    for (label, rects) in regions {
        if let Some(window) = app.get_webview_window(&label) {
            set_region(&window, &rects);
        }
    }
    for label in empty {
        lock(&state(app).layers).by_label.remove(&label);
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
    }
}

/// 层窗口没了（销毁、退出程序）：钉图不再算画在它里面。
fn forget_layer(app: &AppHandle, layer: &str) {
    lock(&state(app).layers).by_label.remove(layer);
    let mut pins = lock(&state(app).pins);
    for (id, r) in pins.iter_mut() {
        if r.layers.iter().any(|l| l == layer) {
            r.layers.retain(|l| l != layer);
            r.entering.retain(|l| l != layer);
            r.leaving.retain(|l| l != layer);
            remember_layers(id, &r.layers);
        }
    }
}

/// 拖到缩放比例不同的显示器上时系统会按新比例改窗口的位置和尺寸：改回层的物理像素矩形，
/// 免得 canvas 被重新采样、窗口区域对不上内容。
fn keep_layer(app: &AppHandle, layer: &str) {
    let Some(want) = lock(&state(app).layers)
        .by_label
        .get(layer)
        .map(|l| l.window)
    else {
        return;
    };
    let Some(window) = app.get_webview_window(layer) else {
        return;
    };
    let (Ok(at), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    if (at.x, at.y, size.width, size.height) != (want.x, want.y, want.width, want.height) {
        let _ = place(&window, want);
    }
}

/// 把层窗口提到置顶窗口的最上面，不激活。
fn raise(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        super::win32::raise_topmost(hwnd.0 as isize);
    }
    #[cfg(not(windows))]
    let _ = window.set_always_on_top(true);
}

/// 相对窗口左上角的左、上、右、下（`SetWindowRgn` 要的）。
type Rect = (i32, i32, i32, i32);

/// 设层的窗口区域（相对窗口左上角的矩形；空时什么都不显示、不接点击，#193）。
fn set_region(window: &tauri::WebviewWindow, rects: &[Rect]) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        super::win32::set_window_region(hwnd.0 as isize, rects);
    }
    #[cfg(not(windows))]
    let _ = (window, rects);
}

/// 一次调用同时改窗口的位置与尺寸（Windows 上），免得合成出只改了一半的一帧。
/// 菜单窗口（[`super::menu`]）也用它铺到指针所在的显示器上。
pub(super) fn place(window: &tauri::WebviewWindow, rect: ScreenRect) -> Result<(), String> {
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
        .map_err(|e| e.to_string())
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

/// [`show`] 改之前的几何，层建不起来时改回去。
struct Motion {
    generation: u32,
    content: ScreenRect,
    region: ScreenRect,
    settled: bool,
    motion: PinMotion,
    began: (ScreenRect, Instant),
    click_through: bool,
}

impl Motion {
    fn of(r: &PinRecord) -> Self {
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

    fn restore(self, r: &mut PinRecord) {
        r.generation = self.generation;
        r.content = self.content;
        r.region = self.region;
        r.settled = self.settled;
        r.motion = self.motion;
        r.began = self.began;
        r.click_through = self.click_through;
    }
}

/// 给画着钉图的每个层发一帧（各层的 `window` 不同）。会查资料库，不要持有锁调用。
fn emit_frames(app: &AppHandle, pin: &str, motion: PinMotion) {
    for (layer, frame) in frames(app, pin, Some(motion)) {
        let _ = app.emit_to(layer.as_str(), FRAME_EVENT, &frame);
    }
}

/// `motion` 为 `None`（层的页面中途来取）时：动画中按最新一帧的到达方式，静止时 `Jump`。
fn frames(app: &AppHandle, pin: &str, motion: Option<PinMotion>) -> Vec<(String, PinFrame)> {
    let Some(saved) = lock(&state(app).store).get(pin).cloned() else {
        return Vec::new();
    };
    let (veiled, unavailable) = appearance(app, &saved);
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
                },
            ))
        })
        .collect()
}

/// 给画着钉图的每个层发一条提示。
fn notify(app: &AppHandle, pin: &str, text: &str) {
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

/// 当前这一帧（不改窗口），以钉图的第一个层为准；钉图不在任何层里时为 `None`。
fn current_frame(app: &AppHandle, pin: &str) -> Option<PinFrame> {
    frames(app, pin, Some(PinMotion::Jump))
        .into_iter()
        .next()
        .map(|(_, f)| f)
}

/// 改了透明度、锁定、遮蔽或上下次序之后：各层重画这个钉图。
fn refresh(app: &AppHandle, pin: &str) {
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

/// 安全模式（应用设置）开关了：不论有没有打开资料库，资料库钉图都重新核对；
/// 重新开启时之前确认显示的也重新遮蔽。在别的线程上调用。
pub fn safe_mode_changed(app: &AppHandle, _on: bool) {
    // Delivery can be delayed or reordered. The committed setting is the authority;
    // the command has already revoked old reveals synchronously under this same gate.
    crate::library::with_visibility_commit(app, |_| {
        let safe = crate::library::safe_mode_on(app);
        lock(&state(app).veils).set_safe_mode(safe);
    });
    references_changed(app);
}

/// 钉图内容此刻（或动画结束时）在屏幕上的位置。
fn content_of(app: &AppHandle, pin: &str) -> Option<ScreenRect> {
    lock(&state(app).pins).get(pin).map(|r| r.content)
}

fn mark_closing(app: &AppHandle, pin: &str) {
    if let Some(record) = lock(&state(app).pins).get_mut(pin) {
        record.closing = true;
    }
}

/// 关闭钉图（Esc、菜单、Alt+F4）：各层放手，不再恢复，截图不再被它钉住。在别的线程上调用。
fn close(app: &AppHandle, pin: &str) {
    crate::library::with_visibility_commit(app, |_| mark_closing(app, pin));
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
fn closed(app: &AppHandle, pin: &str) {
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
        lock(&state(app).veils).set_safe_mode(safe);
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
        eprintln!("恢复资料库钉图时无法打开资料库：{e}");
    }
    for pin in &pins {
        if let Err(e) = open_pin(app, pin) {
            eprintln!("恢复钉图失败：{e}");
        }
    }
}

/// 光标处的一个点，作为钉剪贴板和从历史钉住时的“原位置”。
fn at_cursor(app: &AppHandle, width: u32, height: u32) -> Result<ScreenRect, String> {
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    Ok(ScreenRect {
        x: cursor.x.floor() as i32,
        y: cursor.y.floor() as i32,
        width,
        height,
    })
}

/// 把剪贴板里的图片存进截图历史并钉在光标旁。
fn pin_from_clipboard(app: &AppHandle) -> Result<(), String> {
    let image = arboard::Clipboard::new()
        .and_then(|mut c| c.get_image())
        .map_err(|_| "剪贴板里没有图片".to_owned())?;
    let image = RgbaImage::from_raw(
        image.width as u32,
        image.height as u32,
        image.bytes.into_owned(),
    )
    .ok_or("剪贴板里的图片无法识别")?;
    // 剪贴板图片不带显示器配置文件，按 sRGB 解释。
    let prepared =
        kinshoko_core::desktop::CaptureHistory::prepare(&Screenshot { image, icc: None })
            .map_err(|e| e.to_string())?;
    let entry = lock(&state(app).history)
        .add_prepared(prepared)
        .map_err(|e| e.to_string())?;
    history_changed(app);
    open(app, &entry, at_cursor(app, entry.width, entry.height)?).map(|_| ())
}

/// F3：在别的线程上读剪贴板并钉住。
pub fn pin_clipboard_in_background(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = pin_from_clipboard(&app) {
            eprintln!("钉剪贴板失败：{e}");
        }
    });
}

pub fn copy_to_clipboard(app: &AppHandle, image: &RgbaImage) -> Result<(), String> {
    super::clipboard::PreparedImage::prepare(image)?.commit(app)
}

#[tauri::command]
pub async fn pin_clipboard(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pin_from_clipboard(&app))
        .await
        .map_err(|e| e.to_string())?
}

/// 从截图历史钉住一张截图，放在光标旁。
#[tauri::command]
pub async fn pin_capture(app: AppHandle, id: String) -> Result<(), String> {
    let entry = lock(&state(&app).history)
        .entries()
        .into_iter()
        .find(|e| e.id == id)
        .ok_or("截图已不在截图历史中")?;
    let at = at_cursor(&app, entry.width, entry.height)?;
    open(&app, &entry, at).map(|_| ())
}

/// 从查看器钉整图或局部（见 [`pin_reference_here`]）。
#[tauri::command]
pub async fn pin_reference(
    app: AppHandle,
    window: tauri::Window,
    library_id: String,
    image_id: String,
    crop: Option<Region>,
    shown: ScreenRect,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        pin_reference_here(&app, &window, &library_id, &image_id, crop, shown)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 画师确认显示这一张被遮蔽的参考图：遮蔽淡出，直到安全模式再次开启或钉图关闭。
#[tauri::command]
pub async fn reveal_pin(app: AppHandle, pin: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || reveal_here(&app, &pin))
        .await
        .map_err(|e| e.to_string())?
}

fn reveal_here(app: &AppHandle, pin: &str) -> Result<(), String> {
    crate::library::with_visibility_commit(app, |_| {
        if !capture_source_open(app, pin) {
            return Err(CLOSED.to_owned());
        }
        let safe = crate::library::safe_mode_on(app);
        let mut veils = lock(&state(app).veils);
        veils.set_safe_mode(safe);
        veils.reveal(pin);
        Ok(())
    })?;
    refresh(app, pin);
    Ok(())
}

/// 钉图层（调用的窗口）要画的这个钉图、层窗口与内容的位置。钉图已关闭或不在这个层里时为 `None`。
#[tauri::command]
pub async fn pin_frame(
    app: AppHandle,
    window: tauri::WebviewWindow,
    pin: String,
) -> Option<PinFrame> {
    frames(&app, &pin, None)
        .into_iter()
        .find(|(layer, _)| layer == window.label())
        .map(|(_, f)| f)
}

/// 钉图层（调用的窗口）此刻画着的钉图。层的页面加载好时取一次，之后按帧与 `pin-gone` 更新。
#[tauri::command]
pub async fn pin_layer_pins(app: AppHandle, window: tauri::WebviewWindow) -> Vec<String> {
    lock(&state(&app).pins)
        .iter()
        .filter(|(_, r)| r.layers.iter().any(|l| l == window.label()))
        .map(|(id, _)| id.clone())
        .collect()
}

/// 按下了这个钉图：它到最上面。
#[tauri::command]
pub async fn raise_pin(app: AppHandle, pin: String) {
    let top = {
        let mut pins = lock(&state(&app).pins);
        let max = pins.values().map(|r| r.z).max().unwrap_or(0);
        match pins.get_mut(&pin) {
            Some(r) if r.z < max => {
                r.z = next_z();
                true
            }
            _ => false,
        }
    };
    if top {
        refresh(&app, &pin);
    }
}

/// Esc 只关闭光标下（或最近按过）的那个钉图，后续沿用关闭时的持久状态与截图历史清理。
#[tauri::command]
pub async fn close_pin(
    app: AppHandle,
    window: tauri::WebviewWindow,
    pin: String,
) -> Result<(), String> {
    let here = lock(&state(&app).pins)
        .get(&pin)
        .is_some_and(|r| r.layers.iter().any(|l| l == window.label()));
    if !here {
        return Err("只能关闭当前钉图".to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || close(&app, &pin))
        .await
        .map_err(|e| e.to_string())
}

/// 钉图层（调用的窗口）画好了这个钉图的第一帧：层还隐藏着时显示它；交接中的钉图等新层都画好了，
/// 旧层才放手。
#[tauri::command]
pub async fn pin_ready(app: AppHandle, window: tauri::WebviewWindow, pin: String) {
    super::timing("pin.ready");
    let layer = window.label().to_owned();
    let show_window = lock(&state(&app).layers)
        .by_label
        .get_mut(&layer)
        .is_some_and(|l| !std::mem::replace(&mut l.shown, true));
    if show_window {
        let _ = window.show();
    }
    let arranging = lock(&ARRANGING);
    let handed = {
        let mut pins = lock(&state(&app).pins);
        match pins.get_mut(&pin) {
            Some(r) => {
                r.shown = true;
                r.entering.retain(|l| *l != layer);
                if r.entering.is_empty() && !r.leaving.is_empty() {
                    let leaving = std::mem::take(&mut r.leaving);
                    r.layers.retain(|l| !leaving.contains(l));
                    remember_layers(&pin, &r.layers);
                    leaving
                } else {
                    Vec::new()
                }
            }
            None => Vec::new(),
        }
    };
    if !handed.is_empty() {
        finish(
            &app,
            &Touched {
                layers: Vec::new(),
                gone: handed.into_iter().map(|l| (l, pin.clone())).collect(),
            },
        );
    }
    drop(arranging);
    stop_waiting(&app, &pin);
}

/// 唤醒 [`wait_shown`]：钉图已显示，或已不在。
fn stop_waiting(app: &AppHandle, pin: &str) {
    let waiters = &state(app).pin_shown;
    if let Some(shown) = lock(&waiters.pins).get_mut(pin) {
        *shown = true;
        waiters.changed.notify_all();
    }
}

/// 动画或手势结束、页面已画好：`generation` 仍是最新一帧时，钉图的区域缩回内容；离开了的层放手。
#[tauri::command]
pub async fn settle_pin(app: AppHandle, pin: String, generation: u32) {
    {
        let mut pins = lock(&state(&app).pins);
        let Some(r) = pins.get_mut(&pin) else {
            return;
        };
        if r.generation != generation || r.settled {
            return;
        }
        r.region = r.content;
        r.settled = true;
    }
    let _arranging = lock(&ARRANGING);
    match arrange(&app, &pin) {
        Ok(touched) => finish(&app, &touched),
        Err(e) => eprintln!("钉图层建不起来：{e}"),
    }
}

/// 拖动钉图：移到屏幕物理像素 (x, y)，这里成为它的新原位。收起着的钉图被拖出后不再算收起。
/// 锁定的钉图不动。
#[tauri::command]
pub async fn move_pin(app: AppHandle, pin: String, x: i32, y: i32) -> Result<(), String> {
    let rect = edit(&app, &pin, |p| p.move_to(x, y).then(|| p.rect()))
        .ok_or(CLOSED)?
        .ok_or(LOCKED)?;
    lock(&state(&app).edge).release(&pin);
    show(&app, &pin, rect, PinMotion::Drag, false)
}

/// 从钉图此刻的位置出发改它：滑出中的钉图改完就留在这里，不再算收起。
/// `f` 返回 `None`（锁定）时什么都不改。
fn change_here(
    app: &AppHandle,
    pin: &str,
    f: impl FnOnce(&mut SavedPin) -> bool,
) -> Result<ScreenRect, String> {
    let at = content_of(app, pin).ok_or(CLOSED)?;
    let rect = edit(app, pin, |p| {
        let before = p.placement;
        p.placement.x = at.x;
        p.placement.y = at.y;
        if f(p) {
            Some(p.rect())
        } else {
            p.placement = before;
            None
        }
    })
    .ok_or(CLOSED)?
    .ok_or(LOCKED)?;
    lock(&state(app).edge).release(pin);
    Ok(rect)
}

/// 缩放钉图到 `scale`，屏幕上的 (`anchor_x`, `anchor_y`)（物理像素，例如光标或按住的角）
/// 保持不动。锁定的钉图不缩放。窗口里的内容以动画到达。
#[tauri::command]
pub async fn zoom_pin(
    app: AppHandle,
    pin: String,
    scale: f64,
    anchor_x: f64,
    anchor_y: f64,
) -> Result<(), String> {
    zoom(&app, &pin, scale, Some((anchor_x, anchor_y)))
}

/// `anchor` 为 `None` 时以钉图中心为锚点。
fn zoom(app: &AppHandle, pin: &str, scale: f64, anchor: Option<(f64, f64)>) -> Result<(), String> {
    let rect = change_here(app, pin, |p| {
        let r = p.rect();
        let centre = (
            f64::from(r.x) + f64::from(r.width) / 2.0,
            f64::from(r.y) + f64::from(r.height) / 2.0,
        );
        p.zoom(scale, anchor.unwrap_or(centre))
    })?;
    show(app, pin, rect, PinMotion::Zoom, false)
}

/// 翻转或旋转钉图（中心不动）。快捷键与右键菜单共用。
#[tauri::command]
pub async fn turn_pin(app: AppHandle, pin: String, turn: Turn) -> Result<(), String> {
    turn_here(&app, &pin, turn)
}

fn turn_here(app: &AppHandle, pin: &str, turn: Turn) -> Result<(), String> {
    let rect = change_here(app, pin, |p| {
        p.turn(turn);
        true
    })?;
    show(app, pin, rect, PinMotion::Jump, false)
}

/// 透明度（10%～100%）。Ctrl+滚轮与右键菜单共用。
#[tauri::command]
pub async fn set_pin_opacity(app: AppHandle, pin: String, opacity: f64) -> Result<(), String> {
    edit(&app, &pin, |p| p.set_opacity(opacity)).ok_or(CLOSED)?;
    refresh(&app, &pin);
    Ok(())
}

/// 锁定后钉图不响应拖动与缩放。
#[tauri::command]
pub async fn set_pin_locked(app: AppHandle, pin: String, locked: bool) -> Result<(), String> {
    edit(&app, &pin, |p| p.locked = locked).ok_or(CLOSED)?;
    refresh(&app, &pin);
    Ok(())
}

const ACTION_FLIP_H: &str = "flipH";
const ACTION_FLIP_V: &str = "flipV";
const ACTION_ROTATE_CW: &str = "rotateCw";
const ACTION_ROTATE_CCW: &str = "rotateCcw";
const ACTION_OPACITY: &str = "opacity:";
const ACTION_LOCK: &str = "lock";
const ACTION_ACTUAL_SIZE: &str = "actualSize";
const ACTION_COLLECT: &str = "collect";
const ACTION_COPY: &str = "copy";
const ACTION_CLOSE: &str = "close";
const ACTION_REVEAL: &str = "reveal";
const ACTION_SAVE_GROUP: &str = "saveGroup";
/// #106 新增：在 Kinshoko 中打开、加入参考组（`group:<参考组 id>`）、贴边隐藏。
const ACTION_OPEN: &str = "openInKinshoko";
const ACTION_GROUP: &str = "group:";
const ACTION_EDGE_HIDE: &str = "edgeHide";

/// 钉图的右键菜单（#64；#106 起与主窗口同样式）：翻转、旋转、原始大小、透明度、锁定，截图钉图的
/// 收藏与复制，资料库钉图（#65）被遮蔽时的“显示这张图”与来自参考组时的“存回参考组”，再加上
/// 在 Kinshoko 中打开、加入参考组、贴边隐藏与关闭钉图。菜单项在页面里（`src/desktop/PinMenu.tsx`）。
/// 页面在鼠标右键、笔的侧键或笔与触摸按住不动时调用；菜单弹在光标（笔尖）处。
#[tauri::command]
pub async fn pin_menu(
    app: AppHandle,
    window: tauri::WebviewWindow,
    pin: String,
) -> Result<(), String> {
    *lock(&MENU_LAYER) = Some((pin.clone(), window.label().to_owned()));
    tauri::async_runtime::spawn_blocking(move || {
        let frame = current_frame(&app, &pin).ok_or(CLOSED)?;
        let has_library = !crate::library::registered(&app)?.is_empty();
        let group = frame
            .pin
            .member
            .as_ref()
            .and_then(|m| super::groups::group_name(&app, &m.group_id));
        super::menu::popup(
            &app,
            PinMenu::new(&frame.pin, frame.veiled, has_library, group),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 选了钉图菜单里的一项：先收起菜单窗口（焦点交回钉图），再在别的线程上做这件事。
/// 不是此刻打开着的那一次菜单（已经关掉、又开了新的）时不做。
#[tauri::command]
pub async fn pin_menu_action(
    app: AppHandle,
    pin: String,
    action: String,
    generation: u32,
) -> Result<(), String> {
    if super::menu::close(&app, generation).as_deref() != Some(pin.as_str()) {
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
fn menu_action(app: &AppHandle, pin: &str, action: &str) -> Option<String> {
    let turn = match action {
        ACTION_FLIP_H => Some(Turn::FlipHorizontal),
        ACTION_FLIP_V => Some(Turn::FlipVertical),
        ACTION_ROTATE_CW => Some(Turn::RotateClockwise),
        ACTION_ROTATE_CCW => Some(Turn::RotateCounterClockwise),
        _ => None,
    };
    if let Some(turn) = turn {
        return turn_here(app, pin, turn).err();
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
        ACTION_ACTUAL_SIZE => zoom(app, pin, 1.0, None).err(),
        ACTION_REVEAL => reveal_here(app, pin).err(),
        ACTION_OPEN => {
            let saved = lock(&state(app).store).get(pin).cloned()?;
            request_open(app, OpenInKinshoko::of(&saved));
            None
        }
        ACTION_EDGE_HIDE => {
            super::edge::toggle_in_background(app);
            None
        }
        ACTION_SAVE_GROUP => {
            let group_id = lock(&state(app).store).get(pin)?.member.clone()?.group_id;
            Some(match super::groups::save_back(app, &group_id) {
                Ok(group) => format!("已存回参考组「{}」", group.name),
                Err(e) => e,
            })
        }
        ACTION_COLLECT | ACTION_COPY => {
            let capture_id = lock(&state(app).pins)
                .get(pin)
                .and_then(|r| r.capture_id.clone())?;
            Some(if action == ACTION_COLLECT {
                {
                    request_collection(app, &capture_id);
                    "请在主窗口选择保存位置".into()
                }
            } else {
                match copy_capture_image(app, &capture_id) {
                    Ok(()) => "已复制".to_owned(),
                    Err(e) => e,
                }
            })
        }
        _ => None,
    }
}

/// 把截图历史中的一张截图复制到剪贴板（钉图菜单与截图历史条目菜单的“复制”）。会读文件。
pub(super) fn copy_capture_image(app: &AppHandle, capture_id: &str) -> Result<(), String> {
    let file = lock(&state(app).history)
        .file(capture_id)
        .ok_or("截图已不在截图历史中")?;
    let image = image::open(file).map_err(|e| e.to_string())?.to_rgba8();
    copy_to_clipboard(app, &image)
}

/// 把这一个资料库钉图加进参考组 `group_id`（钉图菜单“加入参考组 ▸”）：保留它此刻的局部与摆放，
/// 参考组的其他成员不变。截图钉图要先收藏进图库。返回要在钉图上提示的话。
fn add_to_group(app: &AppHandle, pin: &str, group_id: &str) -> String {
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
            super::reference_groups_changed(app);
            format!("已加入参考组「{}」", group.name)
        }
        Err(e) => e.to_string(),
    }
}
