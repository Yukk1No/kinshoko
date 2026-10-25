//! Windows 适配器：每个槽一个 `WS_EX_NOREDIRECTIONBITMAP` 窗口，各挂一个 DComp 目标与根 visual，
//! 两个槽（所有钉图）共用一个 `IDCompositionDesktopDevice`。换上就是一次 `Commit` 里同时改两个
//! visual 的不透明度；等合成器收下备用槽在时钟线程上做（[`clock`]），界面线程不调 `DwmFlush`。
//!
//! 用法：在界面线程（Tauri 的主线程）上 [`WinShell::new`]，窗口消息由那个线程的消息循环分发；
//! 没有别的消息循环时（工具、测试）调 [`dispatch_pending`]。进程必须是 Per-Monitor V2（Tauri 已设）。

mod clock;
mod hook;
mod input;
mod monitors;
mod proc;
mod tools;
mod window;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::DirectComposition::{
    DCompositionCreateDevice3, IDCompositionDesktopDevice,
};
use windows::Win32::UI::HiDpi::{
    AreDpiAwarenessContextsEqual, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    GetThreadDpiAwarenessContext, SetProcessDpiAwarenessContext,
};
use windows::Win32::UI::Input::KeyboardAndMouse::SetCapture;
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyWindow, DispatchMessageW, GWL_EXSTYLE, GetWindowLongW, HWND_TOPMOST, KillTimer, MSG,
    PM_REMOVE, PeekMessageW, SET_WINDOW_POS_FLAGS, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SetCursor, SetTimer,
    SetWindowLongW, SetWindowPos, TranslateMessage, WS_EX_LAYERED, WS_EX_TRANSPARENT,
};

use crate::displays::{Display, DisplayWatch};
use crate::keys::{HitTable, PinKeys};
use crate::slots::Slots;
use crate::types::{PinCursor, PinId, PinInput, ShellError};
use crate::{PinShell, ScreenRect};
use window::Slot;

fn err(context: &str, e: windows::core::Error) -> ShellError {
    ShellError(format!("{context}：{e}"))
}

/// 处理本线程排着的窗口消息。只给没有别的消息循环的宿主（工具、测试）用；Tauri 里 tao 的循环会分发。
pub fn dispatch_pending() {
    let mut msg = MSG::default();
    // SAFETY：`msg` 由本函数持有；分发本线程的消息。
    unsafe {
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

struct WinPin {
    slots: Slots,
    windows: [Slot; 2],
    click_through: bool,
    /// 调 `swap` 的时刻，报 `Swapped` 时算等了多久。
    swap_at: Option<Instant>,
    /// 换下的槽与换下的时刻：过两个刷新周期、槽上没有按着的指针时收起。
    retire: Option<(usize, Instant)>,
}

/// 平台层的状态。宿主窗口过程（时钟、钩子线程投来的消息）也要用，所以放在 `Rc<RefCell<_>>` 里。
pub(crate) struct State {
    dcomp: IDCompositionDesktopDevice,
    host: HWND,
    pins: BTreeMap<PinId, WinPin>,
    /// 钉图从上到下。
    order: Vec<PinId>,
    keys: PinKeys,
    tickets: u64,
    refresh: Duration,
    watch: DisplayWatch,
    hook: hook::Hook,
    clock: clock::Clock,
}

/// Windows 的 [`PinShell`]。不能跨线程：所有方法都在建它的那个线程上调。
pub struct WinShell {
    state: Rc<RefCell<State>>,
}

impl WinShell {
    /// 在界面线程上建平台层：注册窗口类、建宿主窗口与 DComp 设备，起时钟线程和键盘钩子线程。
    /// `wake` 在有新输入或通知时（在本线程上）调用，提醒宿主找机会 [`PinShell::pump`]；它不能同步
    /// 回调平台层（可能正处在平台层的方法里），应当投递到事件循环里再 pump。
    pub fn new(wake: impl Fn() + 'static) -> Result<WinShell, ShellError> {
        if proc::bound() {
            return Err(ShellError("这个线程上已经有一个 WinShell".into()));
        }
        // SAFETY：设置进程 DPI 感知（已设过时失败，忽略）并读回本线程的。
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            if !AreDpiAwarenessContextsEqual(
                GetThreadDpiAwarenessContext(),
                DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            )
            .as_bool()
            {
                return Err(ShellError(
                    "进程不是 Per-Monitor V2，钉图坐标会被系统缩放".into(),
                ));
            }
        }
        window::register(Some(proc::slot_proc), Some(proc::host_proc))
            .map_err(|e| err("注册窗口类", e))?;
        let host = window::create_host().map_err(|e| err("建宿主窗口", e))?;
        // SAFETY：不需要参数；失败时销毁刚建的宿主窗口。
        let dcomp: IDCompositionDesktopDevice = match unsafe { DCompositionCreateDevice3(None) } {
            Ok(d) => d,
            Err(e) => {
                // SAFETY：刚建的本线程窗口。
                let _ = unsafe { DestroyWindow(host) };
                return Err(err("建 DComp 设备", e));
            }
        };
        let mut watch = DisplayWatch::default();
        watch.update(monitors::layouts());
        let state = Rc::new(RefCell::new(State {
            dcomp,
            host,
            pins: BTreeMap::new(),
            order: Vec::new(),
            keys: PinKeys::none(),
            tickets: 0,
            refresh: clock::refresh_period(),
            watch,
            hook: hook::Hook::start(
                host,
                hook::Messages {
                    key: proc::WM_PIN_KEY,
                    status: proc::WM_HOOK,
                },
            ),
            clock: clock::Clock::start(host, proc::WM_COMPOSED),
        }));
        proc::bind(&state, host, Rc::new(wake));
        // SAFETY：本线程的宿主窗口；颜色配置文件改了没有系统通知，两秒看一次。
        unsafe { SetTimer(Some(host), proc::DISPLAY_TIMER, 2000, None) };
        Ok(WinShell { state })
    }

    /// 看得见的槽的窗口句柄（按整数）：应用壳据此查哪些窗口盖在钉图上（F1 截图冻结时的遮挡）。
    pub fn window_handle(&self, pin: PinId) -> Option<isize> {
        let s = self.state.borrow();
        let p = s.pins.get(&pin)?;
        Some(p.windows[p.slots.visible()].hwnd.0 as isize)
    }
}

impl Drop for WinShell {
    fn drop(&mut self) {
        let pins: Vec<PinId> = self.state.borrow().pins.keys().copied().collect();
        for pin in pins {
            self.close(pin);
        }
        proc::unbind();
        // 先停钩子、时钟两个线程，它们不会再往宿主窗口投消息，再销毁窗口。
        let host = {
            let mut s = self.state.borrow_mut();
            s.hook.stop();
            s.clock.stop();
            s.host
        };
        // SAFETY：本线程的宿主窗口。
        unsafe {
            let _ = KillTimer(Some(host), proc::DISPLAY_TIMER);
            let _ = DestroyWindow(host);
        }
    }
}

fn set_pos(hwnd: HWND, after: Option<HWND>, rect: Option<ScreenRect>, flags: SET_WINDOW_POS_FLAGS) {
    let (x, y, w, h) = rect.map_or((0, 0, 0, 0), |r| {
        (r.x, r.y, r.width as i32, r.height as i32)
    });
    // SAFETY：本线程的窗口；所有调用都带 SWP_NOACTIVATE。
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            after,
            x,
            y,
            w,
            h,
            flags | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        )
    };
}

impl State {
    fn pin(&mut self, pin: PinId) -> Option<&mut WinPin> {
        let p = self.pins.get_mut(&pin);
        debug_assert!(p.is_some(), "钉图 {pin:?} 不存在或已关");
        p
    }

    fn put_on_top(&mut self, pin: PinId) {
        self.order.retain(|&p| p != pin);
        self.order.insert(0, pin);
    }

    /// 把钩子要查的表换成现在的样子。
    fn publish(&self) {
        let pins = self
            .order
            .iter()
            .filter_map(|id| {
                let p = &self.pins[id];
                (!p.click_through).then_some(())?;
                Some((*id, p.slots.window()?))
            })
            .collect();
        self.hook.publish(HitTable {
            pins,
            keys: self.keys.clone(),
        });
    }

    fn commit(&self) {
        // SAFETY：设备有效；把所有排着的 visual 改动一次提交。
        let _ = unsafe { self.dcomp.Commit() };
    }

    /// 合成器已收下 `ticket` 及以前的请求：一次提交换上，捕获跟过去。
    fn composed(&mut self, ticket: u64) -> Vec<PinInput> {
        let now = Instant::now();
        let mut events = Vec::new();
        let mut captures = Vec::new();
        for (&pin, p) in &mut self.pins {
            let Some((old, new)) = p.slots.complete(ticket) else {
                continue;
            };
            // SAFETY：两个 visual 都有效；改动在下面的 Commit 里一起生效。
            unsafe {
                let _ = p.windows[new].visual.SetOpacity2(1.0);
                let _ = p.windows[old].visual.SetOpacity2(0.0);
            }
            captures.push((p.windows[old].hwnd, p.windows[new].hwnd));
            p.retire = Some((old, now));
            let waited = p
                .swap_at
                .take()
                .map_or(0.0, |t| t.elapsed().as_secs_f64() * 1000.0);
            events.push(PinInput::Swapped {
                pin,
                waited_ms: waited,
            });
        }
        if events.is_empty() {
            return events;
        }
        self.commit();
        for (old, new) in captures {
            // 拖动中换窗：鼠标捕获交给新槽（笔和触摸的隐式捕获留在旧槽，旧槽等松开再收起）。
            if proc::holds_capture(old) {
                // SAFETY：两个都是本线程的槽窗口；引用只在这里用。
                unsafe {
                    if let (Some(o), Some(n)) = (window::slot_data(old), window::slot_data(new)) {
                        o.hand_over(n);
                    }
                    SetCapture(new);
                }
            }
        }
        self.clock.at(now + self.refresh * 2, proc::WM_RETIRE);
        self.publish();
        events
    }

    /// 收起到时的换下的槽；槽上还按着指针的等松开（松开时会再来一次）。
    fn retire_due(&mut self) {
        let now = Instant::now();
        let wait = self.refresh * 2;
        let mut later = None;
        for p in self.pins.values_mut() {
            let Some((slot, at)) = p.retire else { continue };
            let s = &mut p.windows[slot];
            // SAFETY：本线程的槽窗口。
            let pressed = unsafe { window::slot_data(s.hwnd) }.is_some_and(|d| d.pressed.get());
            if now < at + wait {
                later = Some(at + wait);
            } else if !pressed {
                set_pos(
                    s.hwnd,
                    None,
                    None,
                    SWP_HIDEWINDOW | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
                );
                s.shown = false;
                p.retire = None;
            }
        }
        if let Some(t) = later {
            self.clock.at(t, proc::WM_RETIRE);
        }
    }

    fn check_displays(&mut self) -> Vec<PinInput> {
        if self.watch.update(monitors::layouts()) {
            vec![PinInput::DisplaysChanged]
        } else {
            Vec::new()
        }
    }

    fn place(&mut self, pin: PinId, slot: usize, rect: ScreenRect, after: HWND) {
        let Some(p) = self.pin(pin) else { return };
        let s = &mut p.windows[slot];
        let mut flags = SET_WINDOW_POS_FLAGS(0);
        if !s.shown {
            flags |= SWP_SHOWWINDOW;
            s.shown = true;
        }
        set_pos(s.hwnd, Some(after), Some(rect), flags);
    }
}

impl PinShell for WinShell {
    fn create(&mut self, pin: PinId) -> Result<[wgpu::SurfaceTargetUnsafe; 2], ShellError> {
        let mut s = self.state.borrow_mut();
        if s.pins.contains_key(&pin) {
            return Err(ShellError(format!("钉图 {pin:?} 已经建过")));
        }
        let a = window::create_slot(&s.dcomp, pin, 1.0).map_err(|e| err("建窗口", e))?;
        let b = match window::create_slot(&s.dcomp, pin, 0.0) {
            Ok(b) => b,
            Err(e) => {
                // SAFETY：刚建的本线程窗口。
                let _ = unsafe { DestroyWindow(a.hwnd) };
                return Err(err("建窗口", e));
            }
        };
        let targets = [a.surface_target(), b.surface_target()];
        s.pins.insert(
            pin,
            WinPin {
                slots: Slots::new(),
                windows: [a, b],
                click_through: false,
                swap_at: None,
                retire: None,
            },
        );
        s.commit();
        Ok(targets)
    }

    fn retarget(&mut self, pin: PinId) -> Result<[wgpu::SurfaceTargetUnsafe; 2], ShellError> {
        let mut s = self.state.borrow_mut();
        let dcomp = s.dcomp.clone();
        let p = s
            .pins
            .get_mut(&pin)
            .ok_or_else(|| ShellError(format!("钉图 {pin:?} 不存在")))?;
        // 换窗请求是对旧 visual 的，合成器回报晚到也不能再把新的、还没画的备用槽换上。
        p.slots.cancel_swap();
        p.swap_at = None;
        let visible = p.slots.visible();
        let opacity = |i: usize| if i == visible { 1.0 } else { 0.0 };
        // 两个都建好再换上：失败时两个槽都留着原来的 visual。
        let a = window::new_visual(&dcomp, &p.windows[0].target, opacity(0));
        let b = window::new_visual(&dcomp, &p.windows[1].target, opacity(1));
        let (a, b) = match (a, b) {
            (Ok(a), Ok(b)) => (a, b),
            (Err(e), _) | (_, Err(e)) => {
                for slot in &p.windows {
                    // SAFETY：目标与原来的 visual 都有效；改回原来的根。
                    let _ = unsafe { slot.target.SetRoot(&slot.visual) };
                }
                return Err(err("重建 visual", e));
            }
        };
        p.windows[0].visual = a;
        p.windows[1].visual = b;
        Ok([p.windows[0].surface_target(), p.windows[1].surface_target()])
    }

    fn show(&mut self, pin: PinId, rect: ScreenRect) {
        let mut s = self.state.borrow_mut();
        let Some(p) = s.pin(pin) else { return };
        p.slots.show(rect);
        let v = p.slots.visible();
        s.place(pin, v, rect, HWND_TOPMOST);
        // 渲染层 Present 时把交换链挂上 visual 但不提交：这里提交才显示出来。
        s.commit();
        s.put_on_top(pin);
        s.publish();
    }

    fn translate(&mut self, pin: PinId, rect: ScreenRect) {
        let mut s = self.state.borrow_mut();
        let Some(p) = s.pin(pin) else { return };
        if let Err(e) = p.slots.translate(rect) {
            debug_assert!(false, "translate({pin:?}, {rect:?})：{e:?}");
            return;
        }
        let hwnd = p.windows[p.slots.visible()].hwnd;
        set_pos(hwnd, None, Some(rect), SWP_NOZORDER | SWP_NOSIZE);
        s.publish();
    }

    fn stage(&mut self, pin: PinId, rect: ScreenRect) {
        let mut s = self.state.borrow_mut();
        let Some(p) = s.pin(pin) else { return };
        p.slots.stage(rect);
        p.swap_at = None;
        let standby = p.slots.standby();
        // 换下后还没收起的槽直接重摆（不透明度已是 0）。
        if p.retire.is_some_and(|(slot, _)| slot == standby) {
            p.retire = None;
        }
        // 摆在可见槽紧下面：两个都在时指针仍落在原来那个上。
        let above = p.windows[p.slots.visible()].hwnd;
        s.place(pin, standby, rect, above);
    }

    fn swap(&mut self, pin: PinId) {
        let mut s = self.state.borrow_mut();
        s.tickets += 1;
        let ticket = s.tickets;
        let Some(p) = s.pin(pin) else { return };
        if let Err(e) = p.slots.request_swap(ticket) {
            debug_assert!(false, "swap({pin:?})：{e:?}");
            return;
        }
        p.swap_at = Some(Instant::now());
        s.clock.after_composition(ticket);
    }

    fn visible_slot(&self, pin: PinId) -> usize {
        self.state
            .borrow()
            .pins
            .get(&pin)
            .map_or(0, |p| p.slots.visible())
    }

    fn raise(&mut self, pin: PinId) {
        let mut s = self.state.borrow_mut();
        let Some(p) = s.pin(pin) else { return };
        let visible = p.windows[p.slots.visible()].hwnd;
        let standby = p.windows[p.slots.standby()].hwnd;
        set_pos(visible, Some(HWND_TOPMOST), None, SWP_NOMOVE | SWP_NOSIZE);
        set_pos(standby, Some(visible), None, SWP_NOMOVE | SWP_NOSIZE);
        s.put_on_top(pin);
        s.publish();
    }

    fn set_click_through(&mut self, pin: PinId, on: bool) {
        let mut s = self.state.borrow_mut();
        let Some(p) = s.pin(pin) else { return };
        p.click_through = on;
        // 分层＋透明：命中测试跳过窗口；没调 SetLayeredWindowAttributes，DComp 内容不受影响。
        let bits = (WS_EX_LAYERED | WS_EX_TRANSPARENT).0;
        for slot in &p.windows {
            // SAFETY：本线程的窗口，只改扩展样式里的这两位。
            unsafe {
                let ex = GetWindowLongW(slot.hwnd, GWL_EXSTYLE) as u32;
                let ex = if on { ex | bits } else { ex & !bits };
                SetWindowLongW(slot.hwnd, GWL_EXSTYLE, ex as i32);
            }
        }
        s.publish();
    }

    fn set_cursor(&mut self, pin: PinId, cursor: PinCursor) {
        let mut s = self.state.borrow_mut();
        let Some(p) = s.pin(pin) else { return };
        let handle = window::cursor(cursor);
        for slot in &p.windows {
            // SAFETY：本线程的槽窗口；引用只在这里用。
            if let Some(d) = unsafe { window::slot_data(slot.hwnd) } {
                d.cursor.set(handle);
            }
        }
        // 光标已经在这张钉图上：马上换，不等下一次移动。
        if window::pin_under_cursor() == Some(pin) {
            // SAFETY：系统光标句柄。
            unsafe { SetCursor(Some(handle)) };
        }
    }

    fn set_keys(&mut self, keys: PinKeys) {
        let mut s = self.state.borrow_mut();
        s.keys = keys;
        s.publish();
    }

    fn displays(&self) -> Vec<Display> {
        monitors::displays()
    }

    fn pump(&mut self) -> Vec<PinInput> {
        proc::drain()
    }

    fn close(&mut self, pin: PinId) {
        let mut s = self.state.borrow_mut();
        let Some(p) = s.pins.remove(&pin) else { return };
        for slot in &p.windows {
            // SAFETY：本线程的窗口；槽数据在 WM_NCDESTROY 里释放。
            let _ = unsafe { DestroyWindow(slot.hwnd) };
        }
        s.order.retain(|&id| id != pin);
        s.commit();
        s.publish();
    }
}
