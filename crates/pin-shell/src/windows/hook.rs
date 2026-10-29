//! 低级键盘钩子，跑在自己的线程（自带消息循环）上：钉图窗口不激活、拿不到键盘焦点（ADR 0013）。
//!
//! 回调只查表（[`KeyGate`]）：光标在某张钉图（含阴影）上、键在拦截表里才拦下，投给界面线程；
//! 其余放行。表由界面线程发布，回调只在锁里取一个 `Arc`。回调送达得太晚时（系统可能已因超时
//! 移除钩子）重装，并报给编排写日志。

use std::cell::{Cell, RefCell};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetCursorPos, GetMessageW, HC_ACTION, HHOOK, KBDLLHOOKSTRUCT, MSG, PM_NOREMOVE,
    PeekMessageW, PostMessageW, PostThreadMessageW, SetTimer, SetWindowsHookExW,
    UnhookWindowsHookEx, WH_KEYBOARD_LL, WM_APP, WM_KEYDOWN, WM_QUIT, WM_SYSKEYDOWN, WM_TIMER,
};

use super::input::{key_from_vk, pack_key, vk_from_key};
use crate::keys::{HitTable, KeyGate, Mods, Verdict, late_ms};

/// 钩子线程自己的消息：重装钩子，`wParam` 为晚了多少毫秒。
const WM_REINSTALL: u32 = WM_APP + 1;
/// 两次重装至少隔这么久（一阵卡顿里每个按键都会晚）。
const REINSTALL_GAP: Duration = Duration::from_secs(1);
/// 兜底：系统移除钩子之后不再有回调，晚到的回调也就看不到。每隔这么久没有按着的键时悄悄重装一次。
const REFRESH_MS: u32 = 30_000;

/// 发给宿主窗口的消息号。
#[derive(Clone, Copy)]
pub(super) struct Messages {
    /// 拦下的按键，参数见 [`pack_key`]。
    pub key: u32,
    /// 钩子状况：`wParam` 0 为已重装（`lParam` 晚了多少毫秒），1 为装不上（`lParam` 错误码）。
    pub status: u32,
}

struct Shared {
    table: Mutex<Arc<HitTable>>,
    target: isize,
    messages: Messages,
}

thread_local! {
    static SHARED: RefCell<Option<Arc<Shared>>> = const { RefCell::new(None) };
    static GATE: RefCell<KeyGate> = RefCell::new(KeyGate::default());
    static THREAD: Cell<u32> = const { Cell::new(0) };
}

pub(super) struct Hook {
    shared: Arc<Shared>,
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

impl Hook {
    pub fn start(target: HWND, messages: Messages) -> Hook {
        let shared = Arc::new(Shared {
            table: Mutex::new(Arc::new(HitTable::default())),
            target: target.0 as isize,
            messages,
        });
        let (tx, rx) = mpsc::channel();
        let s = shared.clone();
        let thread = std::thread::Builder::new()
            .name("pin-shell keyboard hook".into())
            .spawn(move || run(s, tx))
            .ok();
        let thread_id = if thread.is_some() {
            rx.recv().unwrap_or(0)
        } else {
            0
        };
        Hook {
            shared,
            thread_id,
            thread,
        }
    }

    /// 换上新的表（钉图窗口、拦哪些键）。
    pub fn publish(&self, table: HitTable) {
        if let Ok(mut t) = self.shared.table.lock() {
            *t = Arc::new(table);
        }
    }
}

impl Hook {
    /// 卸下钩子、停下线程并等它退出；之后不再投消息。可以调多次。
    pub fn stop(&mut self) {
        if self.thread_id != 0 {
            // SAFETY：只投递一条线程消息。
            let _ = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
            self.thread_id = 0;
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Hook {
    fn drop(&mut self) {
        self.stop();
    }
}

fn post(shared: &Shared, msg: u32, wp: usize, lp: isize) {
    // SAFETY：只投递消息；宿主窗口已销毁时投递失败，忽略。
    unsafe {
        let _ = PostMessageW(
            Some(HWND(shared.target as *mut _)),
            msg,
            WPARAM(wp),
            LPARAM(lp),
        );
    }
}

fn install(shared: &Shared) -> Option<HHOOK> {
    // SAFETY：回调是本模块的 `extern "system"` 函数；低级钩子不需要模块句柄。
    match unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(callback), None, 0) } {
        Ok(h) => Some(h),
        Err(e) => {
            post(shared, shared.messages.status, 1, e.code().0 as isize);
            None
        }
    }
}

fn run(shared: Arc<Shared>, ready: mpsc::Sender<u32>) {
    // SAFETY：只改本线程的 DPI 感知，让 GetCursorPos 给物理像素；建消息队列。
    unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
    }
    // SAFETY：无参数。
    let me = unsafe { GetCurrentThreadId() };
    THREAD.with(|t| t.set(me));
    SHARED.with(|s| *s.borrow_mut() = Some(shared.clone()));
    let _ = ready.send(me);
    let mut hook = install(&shared);
    let mut last_reinstall: Option<Instant> = None;
    // SAFETY：线程计时器，到时往本线程的队列放 WM_TIMER。
    unsafe { SetTimer(None, 0, REFRESH_MS, None) };
    let mut msg = MSG::default();
    // SAFETY：`msg` 由本函数持有；GetMessageW 出错（-1）或收到 WM_QUIT（0）时退出。
    while unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 > 0 {
        let report = match msg.message {
            WM_REINSTALL if last_reinstall.is_none_or(|t| t.elapsed() >= REINSTALL_GAP) => true,
            WM_TIMER => {
                // 钩子被移除期间松开的键收不到松开，按物理状态清掉，否则兜底永远等不到空闲。
                let idle = GATE.with(|g| {
                    let mut g = g.borrow_mut();
                    g.forget_released(|key| held(vk_from_key(key) as u16));
                    g.idle()
                });
                if !idle {
                    continue;
                }
                false
            }
            _ => continue,
        };
        last_reinstall = Some(Instant::now());
        if let Some(h) = hook.take() {
            // SAFETY：`h` 是本线程装的钩子；已被系统移除时这里返回失败，忽略。
            let _ = unsafe { UnhookWindowsHookEx(h) };
        }
        hook = install(&shared);
        if report && hook.is_some() {
            post(&shared, shared.messages.status, 0, msg.wParam.0 as isize);
        }
    }
    if let Some(h) = hook {
        // SAFETY：同上。
        let _ = unsafe { UnhookWindowsHookEx(h) };
    }
}

fn held(vk: u16) -> bool {
    // SAFETY：只读按键状态。最高位为 1 表示按着。
    (unsafe { GetAsyncKeyState(i32::from(vk)) }) < 0
}

unsafe extern "system" fn callback(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        // SAFETY：HC_ACTION 时 lParam 指向系统给的 KBDLLHOOKSTRUCT，回调期间有效。
        let k = unsafe { &*(lp.0 as *const KBDLLHOOKSTRUCT) };
        // SAFETY：无参数。
        if let Some(late) = late_ms(k.time, unsafe { GetTickCount() }) {
            let me = THREAD.with(Cell::get);
            // SAFETY：只投递一条线程消息给本线程。
            let _ =
                unsafe { PostThreadMessageW(me, WM_REINSTALL, WPARAM(late as usize), LPARAM(0)) };
        }
        if decide(k.vkCode, matches!(wp.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN)) == Some(true) {
            return LRESULT(1);
        }
    }
    // SAFETY：把没拦的事件交给下一个钩子，参数原样转交。
    unsafe { CallNextHookEx(None, code, wp, lp) }
}

/// 拦不拦（Some(true) 拦）；不是钉图认的键直接 None，不碰锁也不取光标。
fn decide(vk: u32, down: bool) -> Option<bool> {
    let key = key_from_vk(vk)?;
    let shared = SHARED.with(|s| s.borrow().clone())?;
    let verdict = if down {
        let table = shared.table.lock().ok()?.clone();
        let mut p = POINT::default();
        // SAFETY：`p` 由本函数持有。
        unsafe { GetCursorPos(&mut p) }.ok()?;
        let mods = Mods {
            shift: held(VK_SHIFT.0),
            ctrl: held(VK_CONTROL.0),
            alt: held(VK_MENU.0),
            win: held(VK_LWIN.0) || held(VK_RWIN.0),
        };
        GATE.with(|g| g.borrow_mut().down(&table, Some(key), (p.x, p.y), mods))
    } else {
        GATE.with(|g| g.borrow_mut().up(Some(key)))
    };
    match verdict {
        Verdict::Pass => Some(false),
        Verdict::Swallow(captured) => {
            if let Some(c) = captured {
                let (wp, lp) = pack_key(c);
                post(&shared, shared.messages.key, wp, lp);
            }
            Some(true)
        }
    }
}
