// PROTOTYPE for #7 (desktop pin probe, round 2). Throwaway: no tests, minimal error handling.
//
// Round 2 follows the artist's feedback: pins come from screen captures (Snipaste-style),
// a global key slides every pin to the nearest screen edge and hands focus back,
// and pins get flip / rotate / opacity / animated zoom. Click-through and 1:1 are gone.
//
// Rule of thumb: never hold the state lock while calling a window API. Window calls dispatch
// to the main thread, and window events lock the state on the main thread.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use image::{codecs::png::PngEncoder, ImageEncoder, RgbaImage};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const STATE_FILE: &str = "PROTOTYPE-state-wipe-me.json";
const LOG_FILE: &str = "PROTOTYPE-pin-events.log";
const CAPTURE_DIR: &str = "PROTOTYPE-captures";
const LIBRARY_DIR: &str = "PROTOTYPE-library";
const TMP_SCREEN: &str = "PROTOTYPE-screen.png";
const HISTORY_MAX: usize = 10;
/// Visible strip of a pin hidden at a screen edge, in physical pixels.
const SLIVER: i32 = 6;
const DEFAULT_KEYS: &[(&str, &str)] = &[("capture", "F1"), ("pinClipboard", "F3"), ("hide", "F4")];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Pin {
    id: String,
    /// Absolute file path, or a bundled sample URL ("/samples/x.png").
    src: String,
    /// History item this pin came from, if any (for the favourite button).
    capture_id: Option<String>,
    /// Source image size in pixels (unrotated).
    w: u32,
    h: u32,
    /// Image pixels -> physical screen pixels. 1.0 = the size it was captured at.
    scale: f64,
    /// Home position (outer, physical). Hiding never changes it.
    x: i32,
    y: i32,
    on_top: bool,
    locked: bool,
    flip_h: bool,
    flip_v: bool,
    /// Quarter turns clockwise, 0..=3.
    rotation: u8,
    opacity: f64,
    #[serde(skip)]
    hidden: Option<Hidden>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Hidden {
    edge: &'static str,
    /// Where the pin sits while hidden (only a sliver on screen).
    at: (i32, i32),
    /// Where it slides to when the mouse touches the sliver: fully visible against the edge.
    peek: (i32, i32),
    peeking: bool,
}

impl Pin {
    fn size(&self) -> PhysicalSize<u32> {
        let (w, h) = if self.rotation % 2 == 1 { (self.h, self.w) } else { (self.w, self.h) };
        PhysicalSize::new(
            ((w as f64) * self.scale).round().max(12.0) as u32,
            ((h as f64) * self.scale).round().max(12.0) as u32,
        )
    }
    fn label(&self) -> String {
        format!("pin-{}", self.id)
    }
    /// Where the window should currently be.
    fn current_pos(&self) -> (i32, i32) {
        match &self.hidden {
            Some(h) if h.peeking => h.peek,
            Some(h) => h.at,
            None => (self.x, self.y),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct HistoryItem {
    id: String,
    file: String,
    w: u32,
    h: u32,
    created: u128,
    /// Copy in the prototype library once favourited.
    library_file: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    pins: Vec<Pin>,
    history: Vec<HistoryItem>,
    /// The usage-log switch survives restarts, so a trial only has to turn it on once.
    #[serde(default)]
    log_to_file: bool,
}

struct PendingCapture {
    image: RgbaImage,
    mon_x: i32,
    mon_y: i32,
}

#[derive(Default)]
struct Inner {
    pins: Vec<Pin>,
    history: Vec<HistoryItem>,
    keys: HashMap<String, Shortcut>,
    key_labels: HashMap<String, String>,
    key_errors: HashMap<String, String>,
    capture: Option<PendingCapture>,
    /// Per-pin animation generation; a newer animation cancels the older one.
    anim_gen: HashMap<String, u64>,
    animating: HashMap<String, u64>,
    all_hidden: bool,
    /// Last foreground window that is not ours, to hand focus back when hiding.
    last_external_hwnd: isize,
    events: Vec<String>,
    log_to_file: bool,
}

struct AppState(Mutex<Inner>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    pins: Vec<Pin>,
    history: Vec<HistoryItem>,
    library: Vec<String>,
    keys: HashMap<String, String>,
    key_errors: HashMap<String, String>,
    all_hidden: bool,
    events: Vec<String>,
    log_to_file: bool,
    data_dir: String,
}

fn st(app: &AppHandle) -> std::sync::MutexGuard<'_, Inner> {
    app.state::<AppState>().inner().0.lock().unwrap()
}

fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().expect("app data dir");
    let _ = fs::create_dir_all(dir.join(CAPTURE_DIR));
    let _ = fs::create_dir_all(dir.join(LIBRARY_DIR));
    dir
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

fn new_id() -> String {
    static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{:x}{:02x}", now_ms() % 0xffffffff, n % 256)
}

fn log_event(app: &AppHandle, msg: impl Into<String>) {
    let line = format!("{} {}", now_ms(), msg.into());
    eprintln!("{line}");
    let to_file = {
        let mut s = st(app);
        s.events.push(line.clone());
        if s.events.len() > 80 {
            s.events.remove(0);
        }
        s.log_to_file
    };
    if to_file {
        if let Ok(mut f) =
            fs::OpenOptions::new().create(true).append(true).open(data_dir(app).join(LOG_FILE))
        {
            let _ = writeln!(f, "{line}");
        }
    }
}

fn save(app: &AppHandle) {
    let saved = {
        let s = st(app);
        Saved { pins: s.pins.clone(), history: s.history.clone(), log_to_file: s.log_to_file }
    };
    let _ = fs::write(data_dir(app).join(STATE_FILE), serde_json::to_string_pretty(&saved).unwrap());
}

fn list_library(app: &AppHandle) -> Vec<String> {
    let mut files: Vec<(SystemTime, String)> = fs::read_dir(data_dir(app).join(LIBRARY_DIR))
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let t = e.metadata().ok()?.modified().ok()?;
                    Some((t, e.path().display().to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.into_iter().map(|f| f.1).collect()
}

fn snapshot(app: &AppHandle) -> Snapshot {
    let s = st(app);
    let snap = Snapshot {
        pins: s.pins.clone(),
        history: s.history.clone(),
        library: vec![],
        keys: s.key_labels.clone(),
        key_errors: s.key_errors.clone(),
        all_hidden: s.all_hidden,
        events: s.events.clone(),
        log_to_file: s.log_to_file,
        data_dir: String::new(),
    };
    drop(s);
    Snapshot { library: list_library(app), data_dir: data_dir(app).display().to_string(), ..snap }
}

fn broadcast(app: &AppHandle) {
    let _ = app.emit("state-changed", snapshot(app));
}

fn find_pin(app: &AppHandle, id: &str) -> Option<Pin> {
    st(app).pins.iter().find(|p| p.id == id).cloned()
}

fn update_pin(app: &AppHandle, id: &str, f: impl FnOnce(&mut Pin)) -> Option<Pin> {
    let mut s = st(app);
    let pin = s.pins.iter_mut().find(|p| p.id == id)?;
    f(pin);
    Some(pin.clone())
}

fn open_window(app: &AppHandle, pin: &Pin) -> tauri::Result<()> {
    let w = WebviewWindowBuilder::new(
        app,
        pin.label(),
        WebviewUrl::App(format!("index.html?pin={}", pin.id).into()),
    )
    .title("钉图")
    .decorations(false)
    .transparent(true)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .shadow(false)
    .skip_taskbar(true)
    .always_on_top(pin.on_top)
    .visible(false)
    .build()?;
    w.set_size(pin.size())?;
    let (x, y) = pin.current_pos();
    w.set_position(PhysicalPosition::new(x, y))?;
    w.show()?;
    Ok(())
}

/// Moves/resizes a pin window to its current target over `ms`, ease-out. Superseded by newer calls.
fn animate_to(app: &AppHandle, id: &str, ms: u64) {
    let Some(pin) = find_pin(app, id) else { return };
    let Some(w) = app.get_webview_window(&pin.label()) else { return };
    let (tx, ty) = pin.current_pos();
    let ts = pin.size();
    let (Ok(p0), Ok(s0)) = (w.outer_position(), w.inner_size()) else { return };
    let gen = {
        let mut s = st(app);
        let g = s.anim_gen.entry(id.to_string()).or_insert(0);
        *g += 1;
        let g = *g;
        s.animating.insert(id.to_string(), g);
        g
    };
    let app = app.clone();
    let id = id.to_string();
    thread::spawn(move || {
        let start = Instant::now();
        loop {
            let t = (start.elapsed().as_millis() as f64 / ms.max(1) as f64).min(1.0);
            let e = 1.0 - (1.0 - t).powi(3);
            let lerp = |a: f64, b: f64| (a + (b - a) * e).round();
            if st(&app).anim_gen.get(&id) != Some(&gen) {
                return;
            }
            let _ = w.set_size(PhysicalSize::new(
                lerp(s0.width as f64, ts.width as f64) as u32,
                lerp(s0.height as f64, ts.height as f64) as u32,
            ));
            let _ = w.set_position(PhysicalPosition::new(
                lerp(p0.x as f64, tx as f64) as i32,
                lerp(p0.y as f64, ty as f64) as i32,
            ));
            if t >= 1.0 {
                break;
            }
            thread::sleep(Duration::from_millis(12));
        }
        let mut s = st(&app);
        if s.animating.get(&id) == Some(&gen) {
            s.animating.remove(&id);
        }
    });
}

fn monitor_rect_for(app: &AppHandle, x: i32, y: i32, w: u32, h: u32) -> Option<(i32, i32, i32, i32)> {
    let cx = x + w as i32 / 2;
    let cy = y + h as i32 / 2;
    let monitors = app.available_monitors().ok()?;
    let rect = |m: &tauri::Monitor| {
        let p = m.position();
        let s = m.size();
        (p.x, p.y, p.x + s.width as i32, p.y + s.height as i32)
    };
    monitors
        .iter()
        .map(rect)
        .find(|r| cx >= r.0 && cx < r.2 && cy >= r.1 && cy < r.3)
        .or_else(|| monitors.first().map(rect))
}

fn hide_target(app: &AppHandle, pin: &Pin) -> Option<Hidden> {
    let s = pin.size();
    let (w, h) = (s.width as i32, s.height as i32);
    let (l, t, r, b) = monitor_rect_for(app, pin.x, pin.y, s.width, s.height)?;
    let dist = [
        ("left", pin.x - l),
        ("right", r - (pin.x + w)),
        ("top", pin.y - t),
        ("bottom", b - (pin.y + h)),
    ];
    let (edge, _) = *dist.iter().min_by_key(|d| d.1).unwrap();
    let cy = pin.y.clamp(t, b - h);
    let cx = pin.x.clamp(l, r - w);
    Some(match edge {
        "left" => Hidden { edge, at: (l - w + SLIVER, cy), peek: (l, cy), peeking: false },
        "right" => Hidden { edge, at: (r - SLIVER, cy), peek: (r - w, cy), peeking: false },
        "top" => Hidden { edge, at: (cx, t - h + SLIVER), peek: (cx, t), peeking: false },
        _ => Hidden { edge, at: (cx, b - SLIVER), peek: (cx, b - h), peeking: false },
    })
}

fn our_pid() -> u32 {
    unsafe { windows_sys::Win32::System::Threading::GetCurrentProcessId() }
}

fn foreground_is_ours() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    unsafe {
        let fg = GetForegroundWindow();
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, &mut pid);
        pid == our_pid()
    }
}

fn toggle_hide_all(app: &AppHandle, source: &str) {
    let hide = !st(app).all_hidden;
    let ids: Vec<String> = st(app).pins.iter().map(|p| p.id.clone()).collect();
    for id in &ids {
        let Some(pin) = find_pin(app, id) else { continue };
        let hidden = if hide { hide_target(app, &pin) } else { None };
        update_pin(app, id, |p| p.hidden = hidden);
        animate_to(app, id, 180);
    }
    let external = {
        let mut s = st(app);
        s.all_hidden = hide;
        s.last_external_hwnd
    };
    if hide && foreground_is_ours() && external != 0 {
        // Give the keyboard back to the painting app the artist was using.
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow(external as _);
        }
    }
    log_event(app, format!("{source}: {} {} pins", if hide { "hide" } else { "show" }, ids.len()));
    broadcast(app);
}

/// Remembers the last foreground window of another process, and slides hidden pins out
/// while the cursor is over them (polling the cursor is more reliable than webview hover
/// events on a 6 px sliver).
fn watch_foreground(app: AppHandle) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    thread::spawn(move || loop {
        unsafe {
            let fg = GetForegroundWindow();
            let mut pid = 0u32;
            GetWindowThreadProcessId(fg, &mut pid);
            if !fg.is_null() && pid != our_pid() {
                st(&app).last_external_hwnd = fg as isize;
            }
        }
        let (cx, cy) = cursor_pos();
        let changes: Vec<(String, bool)> = st(&app)
            .pins
            .iter()
            .filter_map(|p| {
                let h = p.hidden.as_ref()?;
                let s = p.size();
                let (x, y) = if h.peeking { h.peek } else { h.at };
                let m = if h.peeking { 12 } else { 0 }; // a little slack before sliding back
                let inside = cx >= x - m && cx < x + s.width as i32 + m && cy >= y - m && cy < y + s.height as i32 + m;
                (inside != h.peeking).then(|| (p.id.clone(), inside))
            })
            .collect();
        for (id, on) in changes {
            log_event(&app, format!("pin {id} peek={on} cursor {cx},{cy}"));
            update_pin(&app, &id, |p| {
                if let Some(h) = p.hidden.as_mut() {
                    h.peeking = on;
                }
            });
            animate_to(&app, &id, 140);
            broadcast(&app);
        }
        thread::sleep(Duration::from_millis(60));
    });
}

fn cursor_pos() -> (i32, i32) {
    let mut p = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
    unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut p) };
    (p.x, p.y)
}

fn write_png(path: &Path, img: &RgbaImage) -> Result<(), String> {
    let f = fs::File::create(path).map_err(|e| e.to_string())?;
    PngEncoder::new_with_quality(
        std::io::BufWriter::new(f),
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::Adaptive,
    )
    .write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgba8)
    .map_err(|e| e.to_string())
}

/// Adds an image to the rolling history (newest first, max HISTORY_MAX).
fn add_history(app: &AppHandle, img: &RgbaImage) -> Result<HistoryItem, String> {
    let id = new_id();
    let file = data_dir(app).join(CAPTURE_DIR).join(format!("{id}.png"));
    write_png(&file, img)?;
    let item = HistoryItem {
        id,
        file: file.display().to_string(),
        w: img.width(),
        h: img.height(),
        created: now_ms(),
        library_file: None,
    };
    let dropped: Vec<HistoryItem> = {
        let mut s = st(app);
        s.history.insert(0, item.clone());
        let keep = s.history.len().min(HISTORY_MAX);
        let dropped = s.history.split_off(keep);
        // Keep the file while a pin still shows it.
        dropped.into_iter().filter(|d| !s.pins.iter().any(|p| p.src == d.file)).collect()
    };
    for d in dropped {
        let _ = fs::remove_file(&d.file);
    }
    Ok(item)
}

fn new_pin(app: &AppHandle, src: String, capture_id: Option<String>, w: u32, h: u32, x: i32, y: i32) -> Result<String, String> {
    let pin = Pin {
        id: new_id(),
        src,
        capture_id,
        w,
        h,
        scale: 1.0,
        x,
        y,
        on_top: true,
        locked: false,
        flip_h: false,
        flip_v: false,
        rotation: 0,
        opacity: 1.0,
        hidden: None,
    };
    st(app).pins.push(pin.clone());
    open_window(app, &pin).map_err(|e| e.to_string())?;
    log_event(app, format!("pin {} created {}x{} at {x},{y}", pin.id, w, h));
    save(app);
    broadcast(app);
    Ok(pin.id)
}

/// Default place for pins that do not come from a screen region: near the cursor, on screen.
fn place_near_cursor(app: &AppHandle, w: u32, h: u32) -> (i32, i32) {
    let (cx, cy) = cursor_pos();
    match monitor_rect_for(app, cx, cy, 0, 0) {
        Some((l, t, r, b)) => ((cx + 16).clamp(l, (r - w as i32).max(l)), (cy + 16).clamp(t, (b - h as i32).max(t))),
        None => (cx, cy),
    }
}

// ---------- capture ----------

fn start_capture(app: &AppHandle) {
    if app.get_webview_window("capture").is_some() || st(app).capture.is_some() {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        let t0 = Instant::now();
        let (cx, cy) = cursor_pos();
        let result = (|| -> Result<(), String> {
            let mon = xcap::Monitor::from_point(cx, cy).map_err(|e| e.to_string())?;
            let (mx, my) = (mon.x().map_err(|e| e.to_string())?, mon.y().map_err(|e| e.to_string())?);
            let image = mon.capture_image().map_err(|e| e.to_string())?;
            let (w, h) = (image.width(), image.height());
            let t_cap = t0.elapsed().as_millis();
            write_png(&data_dir(&app).join(TMP_SCREEN), &image)?;
            st(&app).capture = Some(PendingCapture { image, mon_x: mx, mon_y: my });
            log_event(&app, format!("capture {w}x{h} at {mx},{my}: grab {t_cap} ms, png {} ms", t0.elapsed().as_millis()));
            let win = WebviewWindowBuilder::new(&app, "capture", WebviewUrl::App("index.html?capture=1".into()))
                .title("截图")
                .decorations(false)
                .resizable(false)
                .shadow(false)
                .skip_taskbar(true)
                .always_on_top(true)
                .visible(false)
                .build()
                .map_err(|e| e.to_string())?;
            win.set_position(PhysicalPosition::new(mx, my)).map_err(|e| e.to_string())?;
            win.set_size(PhysicalSize::new(w, h)).map_err(|e| e.to_string())?;
            Ok(())
        })();
        if let Err(e) = result {
            st(&app).capture = None;
            log_event(&app, format!("capture failed: {e}"));
            broadcast(&app);
        }
    });
}

fn close_capture(app: &AppHandle) {
    st(app).capture = None;
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.destroy();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureInfo {
    file: String,
    w: u32,
    h: u32,
}

#[tauri::command]
fn capture_info(app: AppHandle) -> Option<CaptureInfo> {
    let s = st(&app);
    let c = s.capture.as_ref()?;
    Some(CaptureInfo {
        file: data_dir(&app).join(TMP_SCREEN).display().to_string(),
        w: c.image.width(),
        h: c.image.height(),
    })
}

/// Exact physical cursor position relative to the captured monitor. Browser mouse
/// coordinates snap to whole CSS pixels, which is up to ±1 physical px off at 110%.
#[tauri::command]
fn capture_cursor(app: AppHandle) -> Option<(i32, i32)> {
    let s = st(&app);
    let c = s.capture.as_ref()?;
    let (x, y) = cursor_pos();
    Some((x - c.mon_x, y - c.mon_y))
}

#[tauri::command]
async fn capture_ready(app: AppHandle) {
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// `action`: "pin" or "copy". Region in physical pixels relative to the captured monitor.
#[tauri::command]
async fn capture_finish(app: AppHandle, x: u32, y: u32, w: u32, h: u32, action: String) -> Result<(), String> {
    let (crop, mx, my) = {
        let s = st(&app);
        let c = s.capture.as_ref().ok_or("no capture")?;
        let x = x.min(c.image.width() - 1);
        let y = y.min(c.image.height() - 1);
        let w = w.min(c.image.width() - x).max(1);
        let h = h.min(c.image.height() - y).max(1);
        (image::imageops::crop_imm(&c.image, x, y, w, h).to_image(), c.mon_x + x as i32, c.mon_y + y as i32)
    };
    close_capture(&app);
    log_event(&app, format!("capture region {x},{y} {w}x{h} -> screen {mx},{my}"));
    let item = add_history(&app, &crop)?;
    if action == "copy" {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        cb.set_image(arboard::ImageData {
            width: crop.width() as usize,
            height: crop.height() as usize,
            bytes: crop.as_raw().into(),
        })
        .map_err(|e| e.to_string())?;
        log_event(&app, format!("capture copied {}x{}", crop.width(), crop.height()));
        save(&app);
        broadcast(&app);
    } else {
        // Snipaste behaviour: the pin appears exactly where the region was on screen.
        new_pin(&app, item.file.clone(), Some(item.id.clone()), item.w, item.h, mx, my)?;
    }
    Ok(())
}

#[tauri::command]
async fn capture_cancel(app: AppHandle) {
    close_capture(&app);
    log_event(&app, "capture cancelled");
}

fn pin_clipboard(app: &AppHandle) {
    let result = (|| -> Result<(), String> {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        let data = cb.get_image().map_err(|_| "剪贴板里没有图片".to_string())?;
        let img = RgbaImage::from_raw(data.width as u32, data.height as u32, data.bytes.into_owned())
            .ok_or("剪贴板图片格式无法识别")?;
        let item = add_history(app, &img)?;
        let (x, y) = place_near_cursor(app, item.w, item.h);
        new_pin(app, item.file.clone(), Some(item.id.clone()), item.w, item.h, x, y)?;
        Ok(())
    })();
    if let Err(e) = result {
        log_event(app, format!("pin clipboard: {e}"));
        broadcast(app);
    }
}

// ---------- shortcuts ----------

fn register_key(app: &AppHandle, action: &str, accel: &str) {
    let gs = app.global_shortcut();
    let old = st(app).keys.remove(action);
    if let Some(old) = old {
        let _ = gs.unregister(old);
    }
    let result = accel
        .parse::<Shortcut>()
        .map_err(|e| e.to_string())
        .and_then(|sc| gs.register(sc).map(|_| sc).map_err(|e| e.to_string()));
    let mut s = st(app);
    match result {
        Ok(sc) => {
            s.keys.insert(action.into(), sc);
            s.key_labels.insert(action.into(), accel.into());
            s.key_errors.remove(action);
        }
        Err(e) => {
            s.key_labels.remove(action);
            s.key_errors.insert(action.into(), format!("{accel}: {e}"));
        }
    }
}

fn on_shortcut(app: &AppHandle, sc: &Shortcut) {
    let action = st(app).keys.iter().find(|(_, v)| *v == sc).map(|(k, _)| k.clone());
    match action.as_deref() {
        Some("capture") => start_capture(app),
        Some("pinClipboard") => {
            let app = app.clone();
            thread::spawn(move || pin_clipboard(&app));
        }
        Some("hide") => toggle_hide_all(app, "global key"),
        _ => {}
    }
}

// ---------- commands ----------

#[tauri::command]
fn get_state(app: AppHandle) -> Snapshot {
    snapshot(&app)
}

#[tauri::command]
async fn pin_file(app: AppHandle, path: String, capture_id: Option<String>) -> Result<String, String> {
    let (w, h) = image::image_dimensions(&path).map_err(|e| e.to_string())?;
    // Large files start at most 60% of the monitor.
    let (x, y) = place_near_cursor(&app, w.min(900), h.min(700));
    let id = new_pin(&app, path, capture_id, w, h, x, y)?;
    if let Some((l, t, r, b)) = monitor_rect_for(&app, x, y, 0, 0) {
        let fit = (((r - l) as f64 * 0.6) / w as f64).min(((b - t) as f64 * 0.6) / h as f64);
        if fit < 1.0 {
            update_pin(&app, &id, |p| p.scale = fit);
            animate_to(&app, &id, 0);
            save(&app);
        }
    }
    Ok(id)
}

#[tauri::command]
async fn start_capture_cmd(app: AppHandle) {
    // Let the control window get out of the way first.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }
    thread::sleep(Duration::from_millis(250));
    start_capture(&app);
}

#[tauri::command]
async fn pin_clipboard_cmd(app: AppHandle) {
    pin_clipboard(&app);
}

#[tauri::command]
async fn toggle_hide(app: AppHandle) {
    toggle_hide_all(&app, "control window");
}

#[tauri::command]
async fn favorite(app: AppHandle, capture_id: String) -> Result<(), String> {
    let item = st(&app).history.iter().find(|h| h.id == capture_id).cloned().ok_or("截图已不在历史中")?;
    if item.library_file.is_some() {
        return Ok(());
    }
    let dest = data_dir(&app).join(LIBRARY_DIR).join(format!("capture-{}.png", item.id));
    fs::copy(&item.file, &dest).map_err(|e| e.to_string())?;
    let dest = dest.display().to_string();
    if let Some(h) = st(&app).history.iter_mut().find(|h| h.id == capture_id) {
        h.library_file = Some(dest.clone());
    }
    log_event(&app, format!("favourited {capture_id} -> {dest}"));
    save(&app);
    broadcast(&app);
    Ok(())
}

#[tauri::command]
async fn set_flag(app: AppHandle, id: String, flag: String, value: bool) -> Result<(), String> {
    let pin = update_pin(&app, &id, |p| match flag.as_str() {
        "onTop" => p.on_top = value,
        "locked" => p.locked = value,
        "flipH" => p.flip_h = value,
        "flipV" => p.flip_v = value,
        _ => {}
    })
    .ok_or("pin not found")?;
    if flag == "onTop" {
        if let Some(w) = app.get_webview_window(&pin.label()) {
            w.set_always_on_top(value).map_err(|e| e.to_string())?;
        }
    }
    log_event(&app, format!("pin {id} {flag}={value}"));
    save(&app);
    broadcast(&app);
    Ok(())
}

#[tauri::command]
async fn rotate(app: AppHandle, id: String) -> Result<(), String> {
    let before = find_pin(&app, &id).ok_or("pin not found")?;
    let old = before.size();
    let cx = before.x + old.width as i32 / 2;
    let cy = before.y + old.height as i32 / 2;
    update_pin(&app, &id, |p| {
        p.rotation = (p.rotation + 1) % 4;
        let s = p.size();
        p.x = cx - s.width as i32 / 2;
        p.y = cy - s.height as i32 / 2;
    });
    animate_to(&app, &id, 140);
    save(&app);
    broadcast(&app);
    Ok(())
}

/// Absolute scale, animated, around (ax, ay) in window-relative fractions (0..1).
#[tauri::command]
async fn set_scale(app: AppHandle, id: String, scale: f64, ax: f64, ay: f64) -> Result<(), String> {
    let before = find_pin(&app, &id).ok_or("pin not found")?;
    if before.locked || before.hidden.is_some() {
        return Ok(());
    }
    let old = before.size();
    let px = before.x as f64 + old.width as f64 * ax;
    let py = before.y as f64 + old.height as f64 * ay;
    update_pin(&app, &id, |p| {
        p.scale = scale.clamp(0.05, 10.0);
        let s = p.size();
        p.x = (px - s.width as f64 * ax).round() as i32;
        p.y = (py - s.height as f64 * ay).round() as i32;
    });
    animate_to(&app, &id, 110);
    save(&app);
    broadcast(&app);
    Ok(())
}

#[tauri::command]
async fn set_opacity(app: AppHandle, id: String, opacity: f64) -> Result<(), String> {
    update_pin(&app, &id, |p| p.opacity = opacity.clamp(0.1, 1.0)).ok_or("pin not found")?;
    save(&app);
    broadcast(&app);
    Ok(())
}

#[tauri::command]
async fn close_pin(app: AppHandle, id: String) -> Result<(), String> {
    let pin = find_pin(&app, &id).ok_or("pin not found")?;
    st(&app).pins.retain(|p| p.id != id);
    if let Some(w) = app.get_webview_window(&pin.label()) {
        let _ = w.destroy();
    }
    log_event(&app, format!("pin {id} closed"));
    save(&app);
    broadcast(&app);
    Ok(())
}

#[tauri::command]
async fn change_key(app: AppHandle, action: String, accelerator: String) -> Snapshot {
    register_key(&app, &action, &accelerator);
    log_event(&app, format!("key {action} -> {accelerator}"));
    broadcast(&app);
    snapshot(&app)
}

#[tauri::command]
fn set_logging(app: AppHandle, on: bool) {
    st(&app).log_to_file = on;
    log_event(&app, format!("usage log to file = {on}"));
    save(&app);
    broadcast(&app);
}

// ---------- window events ----------

fn on_pin_window_event(window: &tauri::Window, event: &WindowEvent) {
    let Some(id) = window.label().strip_prefix("pin-") else { return };
    let app = window.app_handle();
    if st(app).animating.contains_key(id) {
        return;
    }
    let Some(pin) = find_pin(app, id) else { return };
    match event {
        WindowEvent::Moved(pos) => {
            let (cx, cy) = pin.current_pos();
            if (cx, cy) == (pos.x, pos.y) {
                return;
            }
            if pin.locked || pin.hidden.is_some() {
                // Locked/hidden: undo moves from Win+arrows, snapping, dragging the sliver.
                let _ = window.set_position(PhysicalPosition::new(cx, cy));
            } else {
                update_pin(app, id, |p| {
                    p.x = pos.x;
                    p.y = pos.y;
                });
                save(app);
                broadcast(app);
            }
        }
        WindowEvent::Resized(size) => {
            let want = pin.size();
            if *size != want && size.width > 0 {
                let _ = window.set_size(want);
            }
        }
        WindowEvent::ScaleFactorChanged { .. } => {
            let _ = window.set_size(pin.size());
        }
        _ => {}
    }
}

fn main() {
    tauri::Builder::default()
        .manage(AppState(Mutex::new(Inner::default())))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, sc, event| {
                    if event.state() == ShortcutState::Pressed {
                        on_shortcut(app, sc);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            for (action, key) in DEFAULT_KEYS {
                register_key(&handle, action, key);
            }
            watch_foreground(handle.clone());

            let capture = MenuItem::with_id(app, "capture", "截图钉住", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "隐藏／显示全部钉图", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "显示控制窗口", true, None::<&str>)?;
            let close_all = MenuItem::with_id(app, "close_all", "关闭全部钉图", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出原型", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&capture, &hide, &show, &close_all, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Kinshoko 钉图原型")
                .menu(&menu)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "capture" => start_capture(app),
                    "hide" => toggle_hide_all(app, "tray"),
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "close_all" => {
                        let labels: Vec<String> = {
                            let mut s = st(app);
                            let l = s.pins.iter().map(|p| p.label()).collect();
                            s.pins.clear();
                            s.all_hidden = false;
                            l
                        };
                        for l in labels {
                            if let Some(w) = app.get_webview_window(&l) {
                                let _ = w.destroy();
                            }
                        }
                        save(app);
                        broadcast(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Reopen: pins come back at their home position, shown (not hidden).
            let saved: Saved = fs::read_to_string(data_dir(&handle).join(STATE_FILE))
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            st(&handle).history = saved.history;
            st(&handle).log_to_file = saved.log_to_file;
            for mut pin in saved.pins {
                let s = pin.size();
                if let Some((l, t, r, b)) = monitor_rect_for(&handle, pin.x, pin.y, s.width, s.height) {
                    pin.x = pin.x.clamp(l - s.width as i32 + 64, r - 64);
                    pin.y = pin.y.clamp(t, b - 32);
                }
                st(&handle).pins.push(pin.clone());
                if let Err(e) = open_window(&handle, &pin) {
                    log_event(&handle, format!("restore pin {} failed: {e}", pin.id));
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { .. } = event {
                    window.app_handle().exit(0);
                }
                return;
            }
            on_pin_window_event(window, event);
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            pin_file,
            start_capture_cmd,
            pin_clipboard_cmd,
            toggle_hide,
            favorite,
            set_flag,
            rotate,
            set_scale,
            set_opacity,
            close_pin,
            change_key,
            set_logging,
            capture_info,
            capture_cursor,
            capture_ready,
            capture_finish,
            capture_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
