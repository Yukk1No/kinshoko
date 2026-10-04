// PROTOTYPE for #7 (desktop pin probe). Throwaway: no tests, minimal error handling.
//
// Rule of thumb in this file: never hold the state lock while calling a window API.
// Window calls dispatch to the main thread, and window events (Moved, ScaleFactorChanged)
// lock the state on the main thread, so holding the lock across a window call can deadlock.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Tried in order until one registers. Global registration takes the key away from every
/// other app (including the painting app), so the chosen key is shown to the artist.
const EXIT_SHORTCUT_CANDIDATES: &[&str] = &["Ctrl+Alt+T", "Ctrl+Alt+Shift+T", "Ctrl+Alt+F9"];
const DATA_FILE: &str = "PROTOTYPE-pins-wipe-me.json";
const LOG_FILE: &str = "PROTOTYPE-pin-events.log";

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Crop {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Pin {
    id: String,
    /// Either a bundled sample URL ("/samples/x.png") or an absolute file path.
    src: String,
    /// Crop in oriented source pixels. Fixed once pinned: nothing in the pin window edits it.
    crop: Crop,
    /// Source pixels -> physical screen pixels. 1.0 means 1:1.
    scale: f64,
    /// Outer position in physical pixels.
    x: i32,
    y: i32,
    on_top: bool,
    locked: bool,
    /// Never restored from disk: a reopened pin always starts interactive.
    #[serde(skip)]
    passthrough: bool,
}

impl Pin {
    fn physical_size(&self) -> PhysicalSize<u32> {
        PhysicalSize::new(
            ((self.crop.w as f64) * self.scale).round().max(16.0) as u32,
            ((self.crop.h as f64) * self.scale).round().max(16.0) as u32,
        )
    }
    fn label(&self) -> String {
        format!("pin-{}", self.id)
    }
}

#[derive(Default)]
struct Inner {
    pins: Vec<Pin>,
    exit_shortcut: Option<String>,
    shortcut_error: Option<String>,
    /// Pins that were click-through when the global key last switched them off.
    remembered_passthrough: Vec<String>,
    events: Vec<String>,
    log_to_file: bool,
}

struct AppState(Mutex<Inner>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WindowInfo {
    id: String,
    scale_factor: f64,
    inner_w: u32,
    inner_h: u32,
    outer_x: i32,
    outer_y: i32,
    monitor: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    pins: Vec<Pin>,
    passthrough: Vec<String>,
    windows: Vec<WindowInfo>,
    exit_shortcut: Option<String>,
    shortcut_error: Option<String>,
    events: Vec<String>,
    log_to_file: bool,
    data_file: String,
}

fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().expect("app data dir");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

fn log_event(app: &AppHandle, msg: impl Into<String>) {
    let line = format!("{} {}", now_ms(), msg.into());
    let to_file = {
        let state = app.state::<AppState>();
        let mut s = state.0.lock().unwrap();
        s.events.push(line.clone());
        if s.events.len() > 60 {
            s.events.remove(0);
        }
        s.log_to_file
    };
    if to_file {
        if let Ok(mut f) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(data_dir(app).join(LOG_FILE))
        {
            let _ = writeln!(f, "{line}");
        }
    }
}

fn save(app: &AppHandle) {
    let pins = app.state::<AppState>().0.lock().unwrap().pins.clone();
    let _ = fs::write(
        data_dir(app).join(DATA_FILE),
        serde_json::to_string_pretty(&pins).unwrap(),
    );
}

fn snapshot(app: &AppHandle) -> Snapshot {
    let (pins, exit_shortcut, shortcut_error, events, log_to_file) = {
        let state = app.state::<AppState>();
        let s = state.0.lock().unwrap();
        (
            s.pins.clone(),
            s.exit_shortcut.clone(),
            s.shortcut_error.clone(),
            s.events.clone(),
            s.log_to_file,
        )
    };
    let windows = pins
        .iter()
        .filter_map(|p| {
            let w = app.get_webview_window(&p.label())?;
            let inner = w.inner_size().ok()?;
            let outer = w.outer_position().ok()?;
            Some(WindowInfo {
                id: p.id.clone(),
                scale_factor: w.scale_factor().ok()?,
                inner_w: inner.width,
                inner_h: inner.height,
                outer_x: outer.x,
                outer_y: outer.y,
                monitor: w.current_monitor().ok().flatten().and_then(|m| m.name().cloned()),
            })
        })
        .collect();
    Snapshot {
        passthrough: pins.iter().filter(|p| p.passthrough).map(|p| p.id.clone()).collect(),
        pins,
        windows,
        exit_shortcut,
        shortcut_error,
        events,
        log_to_file,
        data_file: data_dir(app).join(DATA_FILE).display().to_string(),
    }
}

fn broadcast(app: &AppHandle) {
    let snap = snapshot(app);
    let _ = app.emit("pins-changed", snap);
}

fn find_pin(app: &AppHandle, id: &str) -> Option<Pin> {
    app.state::<AppState>()
        .0
        .lock()
        .unwrap()
        .pins
        .iter()
        .find(|p| p.id == id)
        .cloned()
}

fn update_pin(app: &AppHandle, id: &str, f: impl FnOnce(&mut Pin)) -> Option<Pin> {
    let state = app.state::<AppState>();
    let mut s = state.0.lock().unwrap();
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
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .shadow(false)
    .skip_taskbar(true)
    .always_on_top(pin.on_top)
    .visible(false)
    .build()?;
    // Builder sizes are logical; the pin is defined in physical pixels.
    w.set_size(pin.physical_size())?;
    w.set_position(PhysicalPosition::new(pin.x, pin.y))?;
    w.show()?;
    Ok(())
}

/// Puts a restored pin back on a visible monitor if its saved position is off-screen.
fn clamp_to_monitors(app: &AppHandle, pin: &mut Pin) {
    let Ok(monitors) = app.available_monitors() else { return };
    let size = pin.physical_size();
    let visible = monitors.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        pin.x + 64 > p.x
            && pin.y + 32 > p.y
            && pin.x < p.x + s.width as i32 - 64
            && pin.y < p.y + s.height as i32 - 32
    });
    if !visible {
        if let Some(m) = app.primary_monitor().ok().flatten() {
            pin.x = m.position().x + (m.size().width as i32 - size.width as i32) / 2;
            pin.y = m.position().y + (m.size().height as i32 - size.height as i32) / 2;
        }
    }
}

fn set_passthrough(app: &AppHandle, id: &str, on: bool) -> Result<(), String> {
    if on && app.state::<AppState>().0.lock().unwrap().exit_shortcut.is_none() {
        return Err("没有可用的全局退出快捷键，不能开启穿透".into());
    }
    let pin = find_pin(app, id).ok_or("pin not found")?;
    let w = app.get_webview_window(&pin.label()).ok_or("window not found")?;
    w.set_ignore_cursor_events(on).map_err(|e| e.to_string())?;
    update_pin(app, id, |p| p.passthrough = on);
    Ok(())
}

/// Global key: any pin click-through -> all interactive; otherwise restore the last set.
fn toggle_passthrough_all(app: &AppHandle, source: &str) {
    let (active, remembered, all): (Vec<String>, Vec<String>, Vec<String>) = {
        let state = app.state::<AppState>();
        let s = state.0.lock().unwrap();
        (
            s.pins.iter().filter(|p| p.passthrough).map(|p| p.id.clone()).collect(),
            s.remembered_passthrough.clone(),
            s.pins.iter().map(|p| p.id.clone()).collect(),
        )
    };
    if !active.is_empty() {
        for id in &active {
            let _ = set_passthrough(app, id, false);
        }
        app.state::<AppState>().0.lock().unwrap().remembered_passthrough = active.clone();
        log_event(app, format!("{source}: exit passthrough {active:?}"));
    } else {
        let targets: Vec<String> = remembered.into_iter().filter(|id| all.contains(id)).collect();
        let targets = if targets.is_empty() { all } else { targets };
        for id in &targets {
            let _ = set_passthrough(app, id, true);
        }
        log_event(app, format!("{source}: enter passthrough {targets:?}"));
    }
    broadcast(app);
}

fn register_exit_shortcut(app: &AppHandle, candidates: &[&str]) {
    let gs = app.global_shortcut();
    let previous = app.state::<AppState>().0.lock().unwrap().exit_shortcut.take();
    if let Some(prev) = previous {
        let _ = gs.unregister(prev.as_str());
    }
    let mut errors = vec![];
    for c in candidates {
        match gs.register(*c) {
            Ok(()) => {
                let state = app.state::<AppState>();
                let mut s = state.0.lock().unwrap();
                s.exit_shortcut = Some(c.to_string());
                s.shortcut_error = if errors.is_empty() { None } else { Some(errors.join("; ")) };
                drop(s);
                log_event(app, format!("exit shortcut registered: {c}"));
                return;
            }
            Err(e) => errors.push(format!("{c}: {e}")),
        }
    }
    let msg = errors.join("; ");
    app.state::<AppState>().0.lock().unwrap().shortcut_error = Some(msg.clone());
    log_event(app, format!("exit shortcut FAILED: {msg}"));
}

// ---------- commands ----------

#[tauri::command]
fn get_state(app: AppHandle) -> Snapshot {
    snapshot(&app)
}

#[tauri::command]
async fn create_pin(app: AppHandle, src: String, crop: Crop) -> Result<String, String> {
    let id = format!("{:x}", now_ms() % 0xffffffff);
    let mut pin = Pin {
        id: id.clone(),
        src,
        crop,
        scale: 1.0,
        x: 0,
        y: 0,
        on_top: true,
        locked: false,
        passthrough: false,
    };
    // Start at 1:1, shrunk only if it would not fit the primary monitor.
    if let Some(m) = app.primary_monitor().ok().flatten() {
        let fit = ((m.size().width as f64 * 0.6) / pin.crop.w as f64)
            .min((m.size().height as f64 * 0.6) / pin.crop.h as f64);
        if fit < 1.0 {
            pin.scale = fit;
        }
        let n = app.state::<AppState>().0.lock().unwrap().pins.len() as i32;
        let size = pin.physical_size();
        pin.x = m.position().x + m.size().width as i32 - size.width as i32 - 80 - n * 40;
        pin.y = m.position().y + 80 + n * 40;
    }
    app.state::<AppState>().0.lock().unwrap().pins.push(pin.clone());
    open_window(&app, &pin).map_err(|e| e.to_string())?;
    log_event(&app, format!("pin {id} created crop={:?} scale={:.3}", pin.crop, pin.scale));
    save(&app);
    broadcast(&app);
    Ok(id)
}

#[tauri::command]
async fn set_flag(app: AppHandle, id: String, flag: String, value: bool) -> Result<(), String> {
    match flag.as_str() {
        "onTop" => {
            let pin = update_pin(&app, &id, |p| p.on_top = value).ok_or("pin not found")?;
            if let Some(w) = app.get_webview_window(&pin.label()) {
                w.set_always_on_top(value).map_err(|e| e.to_string())?;
            }
        }
        "locked" => {
            update_pin(&app, &id, |p| p.locked = value).ok_or("pin not found")?;
        }
        "passthrough" => set_passthrough(&app, &id, value)?,
        _ => return Err(format!("unknown flag {flag}")),
    }
    log_event(&app, format!("pin {id} {flag}={value}"));
    save(&app);
    broadcast(&app);
    Ok(())
}

/// `scale`: absolute source->physical factor. Keeps the window centre fixed.
#[tauri::command]
async fn set_scale(app: AppHandle, id: String, scale: f64) -> Result<(), String> {
    let before = find_pin(&app, &id).ok_or("pin not found")?;
    if before.locked {
        return Ok(());
    }
    let old = before.physical_size();
    let cx = before.x + old.width as i32 / 2;
    let cy = before.y + old.height as i32 / 2;
    let pin = update_pin(&app, &id, |p| {
        p.scale = scale.clamp(0.05, 8.0);
        let s = p.physical_size();
        p.x = cx - s.width as i32 / 2;
        p.y = cy - s.height as i32 / 2;
    })
    .unwrap();
    if let Some(w) = app.get_webview_window(&pin.label()) {
        w.set_size(pin.physical_size()).map_err(|e| e.to_string())?;
        w.set_position(PhysicalPosition::new(pin.x, pin.y)).map_err(|e| e.to_string())?;
    }
    save(&app);
    broadcast(&app);
    Ok(())
}

#[tauri::command]
async fn close_pin(app: AppHandle, id: String) -> Result<(), String> {
    let pin = find_pin(&app, &id).ok_or("pin not found")?;
    app.state::<AppState>().0.lock().unwrap().pins.retain(|p| p.id != id);
    if let Some(w) = app.get_webview_window(&pin.label()) {
        let _ = w.destroy();
    }
    log_event(&app, format!("pin {id} closed"));
    save(&app);
    broadcast(&app);
    Ok(())
}

#[tauri::command]
async fn toggle_all(app: AppHandle) {
    toggle_passthrough_all(&app, "control window");
}

#[tauri::command]
async fn change_exit_shortcut(app: AppHandle, accelerator: String) -> Snapshot {
    register_exit_shortcut(&app, &[accelerator.as_str()]);
    broadcast(&app);
    snapshot(&app)
}

#[tauri::command]
fn set_logging(app: AppHandle, on: bool) {
    app.state::<AppState>().0.lock().unwrap().log_to_file = on;
    log_event(&app, format!("usage log to file = {on}"));
    broadcast(&app);
}

// ---------- window events ----------

fn on_pin_window_event(window: &tauri::Window, event: &WindowEvent) {
    let Some(id) = window.label().strip_prefix("pin-") else { return };
    let app = window.app_handle();
    match event {
        WindowEvent::Moved(pos) => {
            let Some(pin) = find_pin(app, id) else { return };
            if pin.x == pos.x && pin.y == pos.y {
                return;
            }
            if pin.locked {
                // Locked is an app rule, not an OS flag: undo moves from Win+arrows, snapping, etc.
                let _ = window.set_position(PhysicalPosition::new(pin.x, pin.y));
                log_event(app, format!("pin {id} locked: reverted move to {},{}", pos.x, pos.y));
            } else {
                update_pin(app, id, |p| {
                    p.x = pos.x;
                    p.y = pos.y;
                });
                save(app);
            }
            broadcast(app);
        }
        WindowEvent::Resized(size) => {
            let Some(pin) = find_pin(app, id) else { return };
            let want = pin.physical_size();
            if *size != want && size.width > 0 {
                // Anything other than our own scale command must not change what the pin shows.
                let _ = window.set_size(want);
                log_event(app, format!("pin {id}: reverted resize {}x{}", size.width, size.height));
                broadcast(app);
            }
        }
        WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
            // Keep the physical size: 1:1 stays 1:1 on a monitor with a different scale.
            if let Some(pin) = find_pin(app, id) {
                let _ = window.set_size(pin.physical_size());
                log_event(app, format!("pin {id}: scale factor -> {scale_factor}"));
                broadcast(app);
            }
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
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_passthrough_all(app, "global shortcut");
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            register_exit_shortcut(&handle, EXIT_SHORTCUT_CANDIDATES);

            let restore = MenuItem::with_id(app, "restore", "恢复交互（退出全部穿透）", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "显示控制窗口", true, None::<&str>)?;
            let close_all = MenuItem::with_id(app, "close_all", "关闭全部钉图", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出原型", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&restore, &show, &close_all, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Kinshoko 钉图原型")
                .menu(&menu)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "restore" => {
                        let ids: Vec<String> = app.state::<AppState>().0.lock().unwrap()
                            .pins.iter().filter(|p| p.passthrough).map(|p| p.id.clone()).collect();
                        for id in &ids {
                            let _ = set_passthrough(app, id, false);
                        }
                        log_event(app, format!("tray: exit passthrough {ids:?}"));
                        broadcast(app);
                    }
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "close_all" => {
                        let labels: Vec<String> = {
                            let state = app.state::<AppState>();
                            let mut s = state.0.lock().unwrap();
                            let l = s.pins.iter().map(|p| p.label()).collect();
                            s.pins.clear();
                            l
                        };
                        for l in labels {
                            if let Some(w) = app.get_webview_window(&l) {
                                let _ = w.destroy();
                            }
                        }
                        log_event(app, "tray: closed all pins");
                        save(app);
                        broadcast(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Reopen: restore position, crop, scale, on-top and lock. Passthrough always starts off.
            let saved: Vec<Pin> = fs::read_to_string(data_dir(&handle).join(DATA_FILE))
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            for mut pin in saved {
                clamp_to_monitors(&handle, &mut pin);
                handle.state::<AppState>().0.lock().unwrap().pins.push(pin.clone());
                if let Err(e) = open_window(&handle, &pin) {
                    log_event(&handle, format!("restore pin {} failed: {e}", pin.id));
                } else {
                    log_event(&handle, format!("restored pin {} at {},{}", pin.id, pin.x, pin.y));
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
            create_pin,
            set_flag,
            set_scale,
            close_pin,
            toggle_all,
            change_exit_shortcut,
            set_logging
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
