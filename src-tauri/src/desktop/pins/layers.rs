//! 钉图层：按显示器分层承载钉图，排列、叠放与点击区域。

use super::*;

/// 一次 [`arrange`] 动过的层：要重设窗口区域的，以及钉图刚离开、要通知页面的。
#[derive(Default)]
pub(super) struct Touched {
    pub(super) layers: Vec<String>,
    pub(super) gone: Vec<(String, String)>,
}

/// 按钉图此刻的区域与是否让点击穿过，决定哪些层画它：区域碰到的每台显示器上那一种层，没有就建。
/// 收起、滑出一开始就换层，点击马上照新状态穿过或不穿过；新层接着画同一段动画（[`MotionBegan`]）。
/// 新进的层都画好它之前，离开的层先留着（交接，[`pin_ready`]）；没有等着的新层时立即放手。
pub(super) fn arrange(app: &AppHandle, pin: &str) -> Result<Touched, String> {
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

pub(super) fn remember_layers(pin: &str, layers: &[String]) {
    let mut map = lock(&PIN_LAYER);
    if layers.is_empty() {
        map.remove(pin);
    } else {
        map.insert(pin.to_owned(), layers.to_vec());
    }
}

/// 显示器 `monitor` 上（让点击穿过的或普通的）钉图层；还没有时建一个（先隐藏）。不要持有锁调用。
pub(super) fn layer_on(
    app: &AppHandle,
    monitor: ScreenRect,
    through: bool,
) -> Result<String, String> {
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
pub(super) fn top_pin(app: &AppHandle, layer: &str) -> Option<String> {
    lock(&state(app).pins)
        .iter()
        .filter(|(_, r)| r.layers.iter().any(|l| l == layer))
        .max_by_key(|(_, r)| r.z)
        .map(|(id, _)| id.clone())
}

/// 给钉图离开的层发通知，重设动过的层的窗口区域，销毁没有钉图了的层。不要持有锁调用。
pub(super) fn finish(app: &AppHandle, touched: &Touched) {
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
pub(super) fn forget_layer(app: &AppHandle, layer: &str) {
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
pub(super) fn keep_layer(app: &AppHandle, layer: &str) {
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
pub(super) fn raise(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        super::super::win32::raise_topmost(hwnd.0 as isize);
    }
    #[cfg(not(windows))]
    let _ = window.set_always_on_top(true);
}

/// 相对窗口左上角的左、上、右、下（`SetWindowRgn` 要的）。
pub(super) type Rect = (i32, i32, i32, i32);

/// 设层的窗口区域（相对窗口左上角的矩形；空时什么都不显示、不接点击，#193）。
pub(super) fn set_region(window: &tauri::WebviewWindow, rects: &[Rect]) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        super::super::win32::set_window_region(hwnd.0 as isize, rects);
    }
    #[cfg(not(windows))]
    let _ = (window, rects);
}

/// 一次调用同时改窗口的位置与尺寸（Windows 上），免得合成出只改了一半的一帧。
/// 菜单窗口（[`super::super::menu`]）也用它铺到指针所在的显示器上。
pub(in crate::desktop) fn place(
    window: &tauri::WebviewWindow,
    rect: ScreenRect,
) -> Result<(), String> {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd()
        && super::super::win32::set_window_rect(
            hwnd.0 as isize,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
        )
    {
        return Ok(());
    }
    // 先移到目标显示器再定尺寸：跨越缩放比例不同的显示器时，移动会先按新比例改一次尺寸。
    window
        .set_position(PhysicalPosition::new(rect.x, rect.y))
        .and_then(|_| window.set_size(PhysicalSize::new(rect.width, rect.height)))
        .map_err(|e| e.to_string())
}
