//! 桌面钉图窗口：截图钉图、钉剪贴板（F3）、拖动与缩放、翻转旋转、右键菜单（翻转、旋转、透明度、
//! 锁定、收藏、复制、关闭，#64；#106 起改由与主窗口同样式的菜单窗口承载，见 [`super::menu`]），
//! 以及重新打开后的恢复（#63）。
//!
//! 每个钉图一个无边框、置顶、不进任务栏的窗口。窗口静止时就是钉图所在显示器那么大
//! （[`pin_surface`](kinshoko_core::desktop::pin_surface)，物理像素），用窗口区域把显示和点击限定在
//! 钉图本身（[`SavedPin::rect`]）；缩放、贴边滑动、拖动与翻转只在页面里移动内容并改窗口区域，
//! 原生窗口不动（#193：窗口原点一动，WebView2 就要晚 1～2 帧才跟上，
//! 画面先抽搐再被裁掉）。几何的每次变化都经 [`show`] 发一帧（[`PinFrame`]）给页面。
//! 窗口先隐藏建好、定好位置，页面画完第一帧后调用 `pin_ready` 才显示。
//! 钉图状态在 [`PinStore`]（`pins.json`）里：画师关闭的钉图从中删除；退出程序时窗口也会销毁，
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
use std::sync::atomic::Ordering;
use std::sync::{Condvar, Mutex};

use image::RgbaImage;
use kinshoko_core::desktop::{
    CaptureEntry, CaptureSurface, Change, OpenInKinshoko, PinContent, PinFrame, PinMenu, PinMotion,
    Placement, Region, SavedPin, ScreenRect, Screenshot, Turn, initial_scale, place_new_pin,
    settle, stage,
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
const LABEL_PREFIX: &str = "pin-";
const NOTICE_EVENT: &str = "pin-notice";
const FRAME_EVENT: &str = "pin-frame";
const CLOSED: &str = "钉图已关闭";
const LOCKED: &str = "钉图已锁定";

/// 本次运行中打开着的钉图窗口。
pub struct PinRecord {
    /// 钉住的截图；资料库钉图为 `None`。
    capture_id: Option<String>,
    /// 画师正在关闭它（菜单或 Alt+F4）。窗口销毁时据此区分“关闭钉图”和“退出程序”。
    closing: bool,
    /// 原生窗口此刻的矩形：静止时是显示器（[`pin_surface`](kinshoko_core::desktop::pin_surface)）。
    window: ScreenRect,
    /// 钉图内容要到（或已在）的位置。收起、滑出时不同于原位。
    content: ScreenRect,
    /// 窗口区域（屏幕坐标）。`None` 时什么都不显示、不接点击。
    region: Option<ScreenRect>,
    /// 页面已画好、区域已缩回内容：不在动画或拖动中。
    settled: bool,
    /// 最新一帧的编号。
    generation: u32,
    /// 窗口让点击穿过（收起且没滑出时）。
    click_through: bool,
}

pub fn label(pin: &str) -> String {
    format!("{LABEL_PREFIX}{pin}")
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

/// F1 冻结前记录可见的资料库钉图。遮蔽、不可用和动画中的内容不作原图裁切。
pub(super) fn capture_surfaces(app: &AppHandle) -> Vec<super::capture::ReferenceSurface> {
    open_pins(app)
        .into_iter()
        .filter_map(|pin| {
            if !matches!(pin.content, PinContent::Reference { .. }) {
                return None;
            }
            let frame = current_frame(app, &pin.id)?;
            if frame.veiled || frame.unavailable.is_some() {
                return None;
            }
            let record = lock(&state(app).pins);
            let r = record.get(&pin.id)?;
            if r.click_through || !r.settled {
                return None;
            }
            Some(super::capture::ReferenceSurface {
                window: label(&pin.id),
                selection: CaptureSurface {
                    pin,
                    shown: r.content,
                    visible: r.content.intersect(&r.window)?,
                    covered: Vec::new(),
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
    open_window(app, &pin).map(|()| pin.id)
}

/// 正在等第一帧的新钉图（id → 已显示）。只登记有人等的钉图，[`pin_ready`] 唤醒。
#[derive(Default)]
pub struct ShownWaiters {
    pins: Mutex<HashMap<String, bool>>,
    changed: Condvar,
}

/// 等新钉图的第一帧画好、窗口显示出来（[`pin_ready`]），最多 `timeout`。窗口已关、建失败或等待中被销毁时立即返回。
/// 只在后台线程调用；不轮询窗口状态，免得和建窗口抢主线程。
pub(super) fn wait_shown(app: &AppHandle, pin: &str, timeout: std::time::Duration) {
    let waiters = &state(app).pin_shown;
    lock(&waiters.pins).insert(pin.to_owned(), false);
    // 登记之前就已显示（或窗口已不在）时不必等。
    let pending = app
        .get_webview_window(&label(pin))
        .is_some_and(|window| !window.is_visible().unwrap_or(false));
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
    open_window(app, &pin).map(|()| pin.id)
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
    open_window(app, &pin)
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

/// 为一个钉图建窗口（新钉的，或启动时恢复的）。截图历史此前已经记下它被钉住。
pub fn open_window(app: &AppHandle, pin: &SavedPin) -> Result<(), String> {
    super::timing("pin.window.begin");
    let rect = pin.rect();
    let (window_rect, region) = settle(rect, rect, &surface_monitors());
    lock(&state(app).pins).insert(
        pin.id.clone(),
        PinRecord {
            capture_id: pin.capture_id().map(str::to_owned),
            closing: false,
            window: window_rect,
            content: rect,
            region,
            settled: true,
            generation: 0,
            click_through: false,
        },
    );
    let built = WebviewWindowBuilder::new(
        app,
        label(&pin.id),
        WebviewUrl::App(format!("index.html?view=pin&pin={}", pin.id).into()),
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
            if let Some(record) = lock(&state(app).pins).get_mut(&pin.id) {
                record.closing = true;
            }
            // A final capture commit may already hold the visibility gate. Cleanup must
            // never re-enter it or block native window construction on the main thread.
            let (app, pin) = (app.clone(), pin.id.clone());
            std::thread::spawn(move || closed(&app, &pin));
            return Err(format!("无法打开钉图窗口：{e}"));
        }
    };
    let app_for_events = app.clone();
    let pin_id = pin.id.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { .. } => mark_closing(&app_for_events, &pin_id),
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => keep_window(&app_for_events, &pin_id),
        WindowEvent::Destroyed => {
            // 没画出第一帧就没了：别让框选一直等到超时。
            stop_waiting(&app_for_events, &pin_id);
            // 主线程上：截图历史的清理放到别的线程。
            let (app, pin) = (app_for_events.clone(), pin_id.clone());
            std::thread::spawn(move || closed(&app, &pin));
        }
        _ => {}
    });
    place(&window, window_rect)?;
    set_region(&window, window_rect, region);
    Ok(())
}

/// 钉图窗口铺得到的显示器（[`pin_surface`](kinshoko_core::desktop::pin_surface)）。只有 Windows
/// 能用窗口区域把点击限定在钉图上；别的平台不给显示器，窗口就是钉图本身。
fn surface_monitors() -> Vec<ScreenRect> {
    if cfg!(windows) {
        monitors()
    } else {
        Vec::new()
    }
}

/// 设窗口区域（屏幕坐标，`at` 是窗口此刻的矩形；`None` 时什么都不显示、不接点击，#193）。
fn set_region(window: &tauri::WebviewWindow, at: ScreenRect, region: Option<ScreenRect>) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        super::win32::set_window_region(
            hwnd.0 as isize,
            region.map(|r| kinshoko_core::desktop::region_in_window(at, r)),
        );
    }
    #[cfg(not(windows))]
    let _ = (window, at, region);
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
/// 原生窗口只在内容碰到新的显示器时才改（拖动时当场改，其余时候只扩不缩，[`stage`]）。窗口区域
/// 现在扩到盖住旧区域与新内容，页面画完（动画结束、手势结束）后调用 `settle_pin` 再缩回内容，
/// 所以页面晚画的一两帧不会被裁掉（#7、#64、#193）。
pub fn show(
    app: &AppHandle,
    pin: &str,
    content: ScreenRect,
    motion: PinMotion,
    click_through: bool,
) {
    let Some(saved) = lock(&state(app).store).get(pin).cloned() else {
        return;
    };
    let (veiled, unavailable) = appearance(app, &saved);
    let monitors = surface_monitors();
    let change = match motion {
        PinMotion::Drag => Change::Drag,
        _ => Change::Stay,
    };
    let (frame, moved, region_changed, region, through_changed) = {
        let mut pins = lock(&state(app).pins);
        let Some(r) = pins.get_mut(pin) else {
            return;
        };
        let to = stage(r.window, r.region, content, change, &monitors);
        let moved = r.window != to.window;
        let region_changed = r.region != to.during;
        let through_changed = r.click_through != click_through;
        r.generation = r.generation.wrapping_add(1);
        r.window = to.window;
        r.content = content;
        r.region = to.during;
        r.settled = motion == PinMotion::Jump && to.during == content.intersect(&to.window);
        r.click_through = click_through;
        let frame = PinFrame {
            pin: saved,
            window: to.window,
            content,
            motion,
            veiled,
            unavailable,
            generation: r.generation,
            settle: !r.settled,
        };
        (frame, moved, region_changed, to.during, through_changed)
    };
    let Some(window) = app.get_webview_window(&label(pin)) else {
        return;
    };
    // 先发帧再改窗口：两者尽量落在同一次合成里。区域只会扩大，页面晚画也不会被裁掉。
    let _ = app.emit_to(label(pin), FRAME_EVENT, &frame);
    if moved {
        let _ = place(&window, frame.window);
    }
    if moved || region_changed {
        set_region(&window, frame.window, region);
    }
    if through_changed {
        let _ = window.set_ignore_cursor_events(click_through);
    }
}

/// 当前这一帧（不改窗口），例如改了透明度或锁定之后。
fn current_frame(app: &AppHandle, pin: &str) -> Option<PinFrame> {
    let saved = lock(&state(app).store).get(pin).cloned()?;
    let (veiled, unavailable) = appearance(app, &saved);
    let pins = lock(&state(app).pins);
    let r = pins.get(pin)?;
    Some(PinFrame {
        pin: saved,
        window: r.window,
        content: r.content,
        motion: PinMotion::Jump,
        veiled,
        unavailable,
        generation: r.generation,
        settle: !r.settled,
    })
}

fn refresh(app: &AppHandle, pin: &str) {
    if let Some(frame) = current_frame(app, pin) {
        let _ = app.emit_to(label(pin), FRAME_EVENT, &frame);
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

/// 拖到缩放比例不同的显示器上时系统会按新比例改窗口的位置和尺寸：改回记下的物理像素矩形，
/// 免得 canvas 被重新采样、窗口区域对不上内容。
fn keep_window(app: &AppHandle, pin: &str) {
    let Some(want) = lock(&state(app).pins).get(pin).map(|r| r.window) else {
        return;
    };
    let Some(window) = app.get_webview_window(&label(pin)) else {
        return;
    };
    let (Ok(at), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    if (at.x, at.y, size.width, size.height) != (want.x, want.y, want.width, want.height) {
        let _ = place(&window, want);
    }
}

/// 钉图窗口销毁了。画师关闭的：不再恢复，截图不再被它钉住，按截图历史的规则丢弃。
/// 退出程序时销毁的：状态留着，下次启动恢复。
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
        if let Err(e) = open_window(app, pin) {
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

/// 钉图窗口要画的内容、窗口与内容的位置。钉图已关闭时为 `None`。
#[tauri::command]
pub async fn pin_frame(app: AppHandle, pin: String) -> Option<PinFrame> {
    current_frame(&app, &pin)
}

/// Esc 只关闭收到按键的钉图，后续沿用窗口销毁时的持久状态与截图历史清理。
#[tauri::command]
pub async fn close_pin(
    app: AppHandle,
    window: tauri::WebviewWindow,
    pin: String,
) -> Result<(), String> {
    if window.label() != label(&pin) {
        return Err("只能关闭当前钉图".to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::library::with_visibility_commit(&app, |_| {
            mark_closing(&app, &pin);
            window.destroy().map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 第一帧已画好：显示钉图。
#[tauri::command]
pub async fn pin_ready(app: AppHandle, pin: String) {
    super::timing("pin.ready");
    if let Some(window) = app.get_webview_window(&label(&pin)) {
        let _ = window.show();
    }
    stop_waiting(&app, &pin);
}

/// 唤醒 [`wait_shown`]：钉图已显示，或窗口已不在。
fn stop_waiting(app: &AppHandle, pin: &str) {
    let waiters = &state(app).pin_shown;
    if let Some(shown) = lock(&waiters.pins).get_mut(pin) {
        *shown = true;
        waiters.changed.notify_all();
    }
}

/// 动画或手势结束、页面已画好：`generation` 仍是最新一帧时，窗口区域缩回内容；窗口能缩回所在
/// 显示器且原点不动时也缩回（[`settle`]）。
#[tauri::command]
pub async fn settle_pin(app: AppHandle, pin: String, generation: u32) {
    let Some(saved) = lock(&state(&app).store).get(&pin).cloned() else {
        return;
    };
    let (veiled, unavailable) = appearance(&app, &saved);
    let monitors = surface_monitors();
    let (frame, moved, region) = {
        let mut pins = lock(&state(&app).pins);
        let Some(r) = pins.get_mut(&pin) else {
            return;
        };
        if r.generation != generation || r.settled {
            return;
        }
        let (window, region) = settle(r.window, r.content, &monitors);
        let moved = window != r.window;
        let unchanged = !moved && region == r.region;
        r.window = window;
        r.region = region;
        r.settled = true;
        if unchanged {
            return;
        }
        let frame = PinFrame {
            pin: saved,
            window,
            content: r.content,
            motion: PinMotion::Jump,
            veiled,
            unavailable,
            generation,
            settle: false,
        };
        (frame, moved, region)
    };
    if let Some(window) = app.get_webview_window(&label(&pin)) {
        if moved {
            let _ = app.emit_to(label(&pin), FRAME_EVENT, &frame);
            let _ = place(&window, frame.window);
        }
        set_region(&window, frame.window, region);
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
    show(&app, &pin, rect, PinMotion::Drag, false);
    Ok(())
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
    show(app, pin, rect, PinMotion::Zoom, false);
    Ok(())
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
    show(app, pin, rect, PinMotion::Jump, false);
    Ok(())
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
pub async fn pin_menu(app: AppHandle, pin: String) -> Result<(), String> {
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
            crate::library::with_visibility_commit(&app, |_| {
                mark_closing(&app, &pin);
                if let Some(window) = app.get_webview_window(&label(&pin)) {
                    let _ = window.destroy();
                }
            });
            return;
        }
        if let Some(notice) = menu_action(&app, &pin, &action) {
            let _ = app.emit_to(label(&pin), NOTICE_EVENT, notice);
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
