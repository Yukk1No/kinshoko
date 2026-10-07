//! 贴边隐藏（F4）与交还焦点（#63）。位置规则在 `kinshoko_core::desktop::EdgeHide`。
//!
//! 一个后台线程每 [`TICK`] 做三件事（#7 原型验证过的做法）：
//! - 记下最近一个不属于本进程的前台窗口，贴边隐藏时把焦点交还给它（数位笔马上能画）；
//! - 有收起的钉图时轮询光标：WebView 在 6 像素细边上的 mouseenter 不可靠；
//! - 钉图状态有改动时写回 `pins.json`（拖动时不必每一步都写）。

use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::Duration;

use kinshoko_core::desktop::{DeskPin, PinMotion, PinMove, SavedPin, ScreenRect};
use tauri::{AppHandle, Manager};

use super::pins::{monitor_at, open_pins, show};
use super::{lock, state};

const TICK: Duration = Duration::from_millis(60);

/// 最近一个不属于本进程的前台窗口（句柄按整数存）。0 表示还没有。
static LAST_EXTERNAL: AtomicIsize = AtomicIsize::new(0);

/// 启动后台线程。
pub fn start(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("kinshoko-edge".into())
        .spawn(move || {
            loop {
                std::thread::sleep(TICK);
                tick(&app);
            }
        });
}

fn tick(app: &AppHandle) {
    remember_external_foreground();
    let hovering = lock(&state(app).edge).any_hidden();
    if hovering && let Some(cursor) = cursor_position() {
        let moves = lock(&state(app).edge).hover(cursor);
        apply(app, &moves);
    }
    flush(app);
}

/// 钉图状态有改动时写回文件。退出前也调用一次。
pub fn flush(app: &AppHandle) {
    let Some(desktop) = app.try_state::<super::DesktopState>() else {
        return;
    };
    if desktop.dirty.swap(false, Ordering::Relaxed)
        && let Err(e) = lock(&desktop.store).save()
    {
        eprintln!("保存钉图状态失败：{e}");
        desktop.dirty.store(true, Ordering::Relaxed);
    }
}

/// 按一次贴边隐藏键：在别的线程上做，快捷键回调不阻塞。
pub fn toggle_in_background(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || toggle(&app));
}

fn toggle(app: &AppHandle) {
    let pins: Vec<DeskPin> = open_pins(app).iter().map(desk_pin).collect();
    let toggle = lock(&state(app).edge).toggle(&pins);
    apply(app, &toggle.moves);
    if toggle.hidden {
        hand_back_focus();
    }
}

fn desk_pin(pin: &SavedPin) -> DeskPin {
    let home = pin.rect();
    let centre = (
        home.x + (home.width / 2) as i32,
        home.y + (home.height / 2) as i32,
    );
    let monitor = monitor_at(centre.0, centre.1)
        .or_else(|| monitor_at(home.x, home.y))
        .map_or(home, |(m, _)| m);
    DeskPin {
        id: pin.id.clone(),
        home,
        monitor,
    }
}

/// 让钉图滑到新位置（#64）：内容在窗口里动画，原生窗口一次滑动最多改两次。
/// 收起的钉图静止在 [`Tuck::stage`](kinshoko_core::desktop::Tuck) 里：滑出与收回不动原生窗口，
/// 没滑出时让点击穿过，只露细边。
fn apply(app: &AppHandle, moves: &[PinMove]) {
    for m in moves {
        let Some((width, height)) = lock(&state(app).store)
            .get(&m.pin)
            .map(SavedPin::window_size)
        else {
            continue;
        };
        let content = ScreenRect {
            x: m.x,
            y: m.y,
            width,
            height,
        };
        let tuck = lock(&state(app).edge).tuck(&m.pin);
        let (rest, click_through) = match tuck {
            Some(t) => (t.stage, !t.peeking),
            None => (content, false),
        };
        show(app, &m.pin, content, rest, PinMotion::Slide, click_through);
    }
}

#[cfg(windows)]
fn remember_external_foreground() {
    if let Some((hwnd, pid)) = super::win32::foreground_window()
        && pid != std::process::id()
    {
        LAST_EXTERNAL.store(hwnd, Ordering::Relaxed);
    }
}

/// 焦点在本进程（钉图、主窗口）时，交还给最近的外部前台窗口（通常是绘画软件）。
/// 焦点本来就在外部时不动它。
#[cfg(windows)]
fn hand_back_focus() {
    let ours = super::win32::foreground_window().is_some_and(|(_, pid)| pid == std::process::id());
    let last = LAST_EXTERNAL.load(Ordering::Relaxed);
    if ours && last != 0 {
        super::win32::set_foreground(last);
    }
}

#[cfg(windows)]
fn cursor_position() -> Option<(i32, i32)> {
    super::win32::cursor_position()
}

#[cfg(not(windows))]
fn remember_external_foreground() {
    let _ = &LAST_EXTERNAL;
}

#[cfg(not(windows))]
fn hand_back_focus() {}

#[cfg(not(windows))]
fn cursor_position() -> Option<(i32, i32)> {
    None
}
