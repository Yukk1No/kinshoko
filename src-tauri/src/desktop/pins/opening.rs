//! 打开钉图：从截图历史、参考图或选区开出钉图，以及钉图的外观。

use super::*;

/// 改一个钉图的状态并安排保存。钉图不在时为 `None`。
pub(super) fn edit<T>(app: &AppHandle, pin: &str, f: impl FnOnce(&mut SavedPin) -> T) -> Option<T> {
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
    open_pin(app, &pin);
    Ok(pin.id)
}

/// 从查看器把资料库中的一张参考图钉到桌面：整图（`crop` 为 `None`）或局部（原图像素）。
/// `shown` 是这块在查看器里此刻的位置（物理像素，相对查看器窗口客户区）；新钉图以它为中心、
/// 略微错开，放不下时缩到显示器的五分之三。只钉浏览视角下看得见的图。
pub(super) fn pin_reference_here(
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
    open_pin(app, &pin);
    Ok(())
}

/// 钉图此刻要不要原位遮蔽（模糊并显示小圆锁，见 [`kinshoko_core::desktop::PinVeils`]），以及暂时
/// 不能显示的原因（资料库没登记、不可用、图已删除、原图缺失，#66）。资料库钉图经参考视角核对：活动资料库现取句柄，
/// 未激活的已登记资料库只读打开（#66）。会查资料库，不要持有桌面状态的锁调用。
pub(super) fn appearance(app: &AppHandle, pin: &SavedPin) -> (bool, Option<String>) {
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

/// 资料库钉图要显示的文件：`size` 为 `full`（1:1）或 `fit-<像素>`（整张缩到的宽度）。经参考视角读取；
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

/// 打开一个钉图（新钉的、启动时恢复的、参考组里打开的）：交给原生钉图（[`native`]），窗口建好之前
/// 就返回；打不开时原生钉图写运行日志并收掉本次运行的记录，状态留到下次启动。
/// 截图历史此前已经记下它被钉住。
pub fn open_pin(app: &AppHandle, pin: &SavedPin) {
    super::super::timing("pin.window.begin");
    lock(&state(app).pins).insert(
        pin.id.clone(),
        PinRecord {
            capture_id: pin.capture_id().map(str::to_owned),
            closing: false,
            content: pin.rect(),
            click_through: false,
            shown: false,
        },
    );
    native::open(app, native::Frame::at_home(pin.clone(), look(app, pin)));
}
