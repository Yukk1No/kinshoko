//! 窗口过程：槽窗口的输入与焦点，宿主窗口收各线程投来的消息。
//!
//! 输入排进本线程的队列，[`PinShell::pump`](crate::PinShell::pump) 取走；每排一条调一次唤醒回调。
//! 槽窗口过程不碰平台层的状态（只用 [`SlotData`] 的 `Cell`），因为它可能在平台层的方法里被同步调用。
//! 宿主窗口只收投递来的消息，借用状态时若已被借用（极少：方法里处理了别的线程发来的消息），重投一次。
//!
//! 鼠标走 `WM_MOUSE*`、笔和触摸走 `WM_POINTER*`，报出的事件形状相同。不用 `EnableMouseInPointer`：
//! 它对整个进程生效，会改掉 tao 与 WebView2 窗口收到的鼠标消息。

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::{Rc, Weak};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::UI::Controls::WM_MOUSELEAVE;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetCapture, ReleaseCapture, SetCapture, TME_LEAVE, TRACKMOUSEEVENT, TrackMouseEvent,
};
use windows::Win32::UI::Input::Pointer::{
    GetPointerInfo, GetPointerPenInfo, GetPointerType, POINTER_INFO, POINTER_PEN_INFO,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DefWindowProcW, GWLP_USERDATA, GetCursorPos, GetWindowRect, HTCLIENT, MA_NOACTIVATE,
    PA_NOACTIVATE, PT_PEN, PT_TOUCH, PostMessageW, SetCursor, SetWindowLongPtrW, WM_APP,
    WM_CAPTURECHANGED, WM_DISPLAYCHANGE, WM_DPICHANGED, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MOUSEACTIVATE, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_NCDESTROY, WM_POINTERACTIVATE,
    WM_POINTERCAPTURECHANGED, WM_POINTERDOWN, WM_POINTERLEAVE, WM_POINTERUP, WM_POINTERUPDATE,
    WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SETCURSOR, WM_SETTINGCHANGE, WM_TIMER, WindowFromPoint,
};

use super::State;
use super::input::{
    buttons_held, client_to_screen, lparam_point, unpack_key, wheel_ctrl, wheel_notches,
};
use super::window::{SlotData, any_slot_data, slot_data};
use crate::types::{HookEvent, PinInput, Pointer, PointerEvent};
use crate::{PointerButton, PointerKind};

/// 时钟线程：合成器已收下 `wParam` 及以前的换窗请求。
pub(super) const WM_COMPOSED: u32 = WM_APP + 0x10;
/// 到时收起换下的槽（时钟线程，或槽上的指针松开时）。
pub(super) const WM_RETIRE: u32 = WM_APP + 0x11;
/// 钩子线程拦下的按键。
pub(super) const WM_PIN_KEY: u32 = WM_APP + 0x12;
/// 钩子线程的状况。
pub(super) const WM_HOOK: u32 = WM_APP + 0x13;
/// 重新看一遍显示器。
pub(super) const WM_DISPLAYS: u32 = WM_APP + 0x14;
/// 定时重看显示器（颜色配置文件改了没有系统通知）。
pub(super) const DISPLAY_TIMER: usize = 1;

thread_local! {
    static EVENTS: RefCell<VecDeque<PinInput>> = const { RefCell::new(VecDeque::new()) };
    static WAKE: RefCell<Option<Rc<dyn Fn()>>> = const { RefCell::new(None) };
    static STATE: RefCell<Weak<RefCell<State>>> = const { RefCell::new(Weak::new()) };
    static HOST: Cell<isize> = const { Cell::new(0) };
}

/// 本线程的平台层：宿主窗口过程从这里找到状态，输入排进这里的队列。
pub(super) fn bind(state: &Rc<RefCell<State>>, host: HWND, wake: Rc<dyn Fn()>) {
    STATE.with(|s| *s.borrow_mut() = Rc::downgrade(state));
    HOST.with(|h| h.set(host.0 as isize));
    WAKE.with(|w| *w.borrow_mut() = Some(wake));
}

pub(super) fn unbind() {
    STATE.with(|s| *s.borrow_mut() = Weak::new());
    HOST.with(|h| h.set(0));
    WAKE.with(|w| *w.borrow_mut() = None);
    EVENTS.with(|e| e.borrow_mut().clear());
}

pub(super) fn bound() -> bool {
    STATE.with(|s| s.borrow().strong_count() > 0)
}

pub(super) fn push(events: impl IntoIterator<Item = PinInput>) {
    let mut any = false;
    EVENTS.with(|q| {
        let mut q = q.borrow_mut();
        for e in events {
            q.push_back(e);
            any = true;
        }
    });
    if any && let Some(wake) = WAKE.with(|w| w.borrow().clone()) {
        wake();
    }
}

pub(super) fn drain() -> Vec<PinInput> {
    EVENTS.with(|q| q.borrow_mut().drain(..).collect())
}

pub(super) fn post_host(msg: u32, wp: usize) {
    let host = HOST.with(Cell::get);
    if host != 0 {
        // SAFETY：只投递消息。
        let _ = unsafe { PostMessageW(Some(HWND(host as *mut _)), msg, WPARAM(wp), LPARAM(0)) };
    }
}

fn origin(hwnd: HWND) -> (i32, i32) {
    let mut r = RECT::default();
    // SAFETY：`r` 由本函数持有。
    let _ = unsafe { GetWindowRect(hwnd, &mut r) };
    (r.left, r.top)
}

/// 光标现在是不是在同一张钉图的某个槽上（换窗时指针从一个槽到另一个槽，不算离开）。
fn over_same_pin(data: &SlotData) -> bool {
    let mut p = POINT::default();
    // SAFETY：`p` 由本函数持有；WindowFromPoint 只查询。返回的槽数据只在这里读一次。
    unsafe {
        if GetCursorPos(&mut p).is_err() {
            return false;
        }
        any_slot_data(WindowFromPoint(p)).is_some_and(|d| d.pin == data.pin)
    }
}

fn pointer(data: &SlotData, kind: PointerKind, at: (i32, i32), event: PointerEvent) {
    push([PinInput::Pointer(Pointer {
        pin: data.pin,
        kind,
        at,
        event,
    })]);
}

pub(super) unsafe extern "system" fn slot_proc(
    hwnd: HWND,
    msg: u32,
    wp: WPARAM,
    lp: LPARAM,
) -> LRESULT {
    if msg == WM_NCDESTROY {
        // SAFETY：收回 `create_slot` 交出的 Box；之后这个窗口不再有槽数据。
        unsafe {
            let p = SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) as *mut SlotData;
            if !p.is_null() {
                drop(Box::from_raw(p));
            }
        }
    }
    // 点钉图不抢绘画软件的焦点（也在拿到槽数据之前生效）。
    match msg {
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        WM_POINTERACTIVATE => return LRESULT(PA_NOACTIVATE as isize),
        _ => {}
    }
    // SAFETY：本窗口是槽窗口；引用只在这次调用里用。
    if let Some(data) = unsafe { slot_data(hwnd) }
        && let Some(r) = slot_message(hwnd, data, msg, wp, lp)
    {
        return r;
    }
    // SAFETY：没处理的消息交给系统默认处理。
    unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
}

fn slot_message(hwnd: HWND, data: &SlotData, msg: u32, wp: WPARAM, lp: LPARAM) -> Option<LRESULT> {
    let handled = Some(LRESULT(0));
    match msg {
        WM_SETCURSOR if (lp.0 & 0xffff) as u32 == HTCLIENT => {
            // SAFETY：系统光标句柄。
            unsafe { SetCursor(Some(data.cursor.get())) };
            Some(LRESULT(1))
        }
        // 忽略系统建议的矩形：窗口一律按物理像素摆，尺寸不随 DPI 跳。显示器的缩放变了，重看一遍。
        WM_DPICHANGED => {
            post_host(WM_DISPLAYS, 0);
            handled
        }
        WM_LBUTTONDOWN | WM_RBUTTONDOWN => {
            let button = if msg == WM_LBUTTONDOWN {
                PointerButton::Primary
            } else {
                PointerButton::Secondary
            };
            // SAFETY：本线程的窗口。
            unsafe { SetCapture(hwnd) };
            data.pressed.set(true);
            data.button.set(button);
            let at = client_to_screen(origin(hwnd), lparam_point(lp.0));
            pointer(data, PointerKind::Mouse, at, PointerEvent::Down(button));
            handled
        }
        WM_LBUTTONUP | WM_RBUTTONUP => {
            let button = if msg == WM_LBUTTONUP {
                PointerButton::Primary
            } else {
                PointerButton::Secondary
            };
            let at = client_to_screen(origin(hwnd), lparam_point(lp.0));
            if !buttons_held(wp.0) {
                data.pressed.set(false);
                // SAFETY：释放本线程的捕获；随后的 WM_CAPTURECHANGED 因 `pressed` 已清掉不报取消。
                let _ = unsafe { ReleaseCapture() };
                post_host(WM_RETIRE, 0);
            }
            pointer(data, PointerKind::Mouse, at, PointerEvent::Up(button));
            handled
        }
        WM_MOUSEMOVE => {
            if !data.tracking.get() {
                let mut t = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                // SAFETY：`t` 由本函数持有。
                data.tracking
                    .set(unsafe { TrackMouseEvent(&mut t) }.is_ok());
            }
            let at = client_to_screen(origin(hwnd), lparam_point(lp.0));
            pointer(data, PointerKind::Mouse, at, PointerEvent::Move);
            handled
        }
        WM_MOUSELEAVE => {
            data.tracking.set(false);
            if !data.pressed.get() && !over_same_pin(data) {
                pointer(data, PointerKind::Mouse, (0, 0), PointerEvent::Leave);
            }
            handled
        }
        WM_CAPTURECHANGED => {
            // SAFETY：`lParam` 是拿到捕获的窗口；只读它是不是同一张钉图的槽。
            let sibling =
                unsafe { any_slot_data(HWND(lp.0 as *mut _)) }.is_some_and(|d| d.pin == data.pin);
            if data.pressed.replace(false) && !sibling {
                pointer(data, PointerKind::Mouse, (0, 0), PointerEvent::Cancel);
                post_host(WM_RETIRE, 0);
            }
            handled
        }
        // 滚轮的坐标已是屏幕坐标。
        WM_MOUSEWHEEL => {
            push([PinInput::Wheel {
                pin: data.pin,
                at: lparam_point(lp.0),
                notches: wheel_notches(wp.0),
                ctrl: wheel_ctrl(wp.0),
            }]);
            handled
        }
        WM_POINTERDOWN
        | WM_POINTERUPDATE
        | WM_POINTERUP
        | WM_POINTERLEAVE
        | WM_POINTERCAPTURECHANGED => pen_or_touch(data, msg, (wp.0 & 0xffff) as u32),
        _ => None,
    }
}

/// 笔和触摸的指针消息；鼠标（没开 `EnableMouseInPointer` 时不会来）交给系统。
fn pen_or_touch(data: &SlotData, msg: u32, id: u32) -> Option<LRESULT> {
    let mut ty = Default::default();
    // SAFETY：出参由本函数持有。
    unsafe { GetPointerType(id, &mut ty) }.ok()?;
    let kind = if ty == PT_PEN {
        PointerKind::Pen
    } else if ty == PT_TOUCH {
        PointerKind::Touch
    } else {
        return None;
    };
    let mut info = POINTER_INFO::default();
    // SAFETY：出参由本函数持有。`ptPixelLocation` 是屏幕物理像素（进程 Per-Monitor V2）。
    unsafe { GetPointerInfo(id, &mut info) }.ok()?;
    let at = (info.ptPixelLocation.x, info.ptPixelLocation.y);
    let event = match msg {
        WM_POINTERDOWN => {
            let button = if kind == PointerKind::Pen && barrel(id) {
                PointerButton::Secondary
            } else {
                PointerButton::Primary
            };
            data.pressed.set(true);
            data.button.set(button);
            PointerEvent::Down(button)
        }
        WM_POINTERUPDATE => PointerEvent::Move,
        WM_POINTERUP => {
            data.pressed.set(false);
            post_host(WM_RETIRE, 0);
            PointerEvent::Up(data.button.get())
        }
        WM_POINTERLEAVE => {
            if data.pressed.get() || over_same_pin(data) {
                return Some(LRESULT(0));
            }
            PointerEvent::Leave
        }
        _ => {
            if !data.pressed.replace(false) {
                return Some(LRESULT(0));
            }
            post_host(WM_RETIRE, 0);
            PointerEvent::Cancel
        }
    };
    pointer(data, kind, at, event);
    // 处理过就不让系统再合成一份鼠标消息。
    Some(LRESULT(0))
}

/// 笔的侧键按着。
fn barrel(id: u32) -> bool {
    let mut pen = POINTER_PEN_INFO::default();
    // SAFETY：出参由本函数持有。
    unsafe { GetPointerPenInfo(id, &mut pen) }.is_ok()
        && pen.penFlags & windows::Win32::UI::WindowsAndMessaging::PEN_FLAG_BARREL != 0
}

pub(super) unsafe extern "system" fn host_proc(
    hwnd: HWND,
    msg: u32,
    wp: WPARAM,
    lp: LPARAM,
) -> LRESULT {
    match msg {
        WM_PIN_KEY => {
            if let Some(c) = unpack_key(wp.0, lp.0) {
                push([PinInput::Key {
                    pin: c.pin,
                    key: c.key,
                    shift: c.shift,
                    repeat: c.repeat,
                }]);
            }
            return LRESULT(0);
        }
        WM_HOOK => {
            let event = if wp.0 == 0 {
                HookEvent::Reinstalled {
                    late_ms: lp.0 as u32,
                }
            } else {
                HookEvent::Failed { code: lp.0 as u32 }
            };
            push([PinInput::KeyHook(event)]);
            return LRESULT(0);
        }
        WM_COMPOSED | WM_RETIRE | WM_DISPLAYS => {
            with_state(msg, wp.0);
            return LRESULT(0);
        }
        WM_DISPLAYCHANGE | WM_SETTINGCHANGE => post_host(WM_DISPLAYS, 0),
        WM_TIMER if wp.0 == DISPLAY_TIMER => {
            with_state(WM_DISPLAYS, 0);
            return LRESULT(0);
        }
        _ => {}
    }
    // SAFETY：没处理的消息交给系统默认处理。
    unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
}

fn with_state(msg: u32, wp: usize) {
    let Some(state) = STATE.with(|s| s.borrow().upgrade()) else {
        return;
    };
    let Ok(mut s) = state.try_borrow_mut() else {
        post_host(msg, wp);
        return;
    };
    let events = match msg {
        WM_COMPOSED => s.composed(wp as u64),
        WM_RETIRE => {
            s.retire_due();
            Vec::new()
        }
        _ => s.check_displays(),
    };
    drop(s);
    push(events);
}

/// 槽上有没有按着的指针、捕获在不在它身上。
pub(super) fn holds_capture(hwnd: HWND) -> bool {
    // SAFETY：只查询。
    unsafe { GetCapture() == hwnd }
}
