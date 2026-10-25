//! 平台薄壳：钉图窗口、输入、以及“备用窗口一次提交换上来”。正式方案里这是唯一按平台写的部分。
//!
//! 每张钉图两个槽（两个原生窗口）。任何时候只有一个槽看得见。看得见的槽只许平移；尺寸变化都在
//! 看不见的备用槽上做：摆好、画好（渲染层 Present）、等合成器收下，再一次提交让它看得见、让原来
//! 那个看不见（[`Shell::swap`]）。合成器保证一次提交里的改动同一帧生效，所以不会出现
//! “新内容配旧窗口”或两个都看得见、都看不见的帧。

use std::cell::RefCell;
use std::collections::VecDeque;

use windows::Win32::Foundation::*;
use windows::Win32::Graphics::DirectComposition::*;
use windows::Win32::Graphics::Dwm::DwmFlush;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetCapture, ReleaseCapture, SetCapture};
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{Interface, w};

use crate::geom::Rect;

/// 平台层报给钉图逻辑的输入（屏幕物理像素）。
#[derive(Debug, Clone, Copy)]
pub enum Input {
    Wheel { pin: usize, x: i32, y: i32, notches: f64 },
    Down { pin: usize, x: i32, y: i32 },
    Move { pin: usize, x: i32, y: i32 },
    Up { pin: usize, x: i32, y: i32 },
    Context { pin: usize },
}

/// 平台接口（正式方案的 trait；这里只有 Windows 一份实现）。
pub trait Shell {
    /// 新建一张钉图的两个槽，返回给渲染层建 Surface 用的目标。槽 0 先看得见（还没显示）。
    fn create(&mut self, pin: usize) -> [wgpu::SurfaceTargetUnsafe; 2];
    /// 第一次显示：把看得见的槽放到 `rect`。
    fn show(&mut self, pin: usize, rect: Rect);
    /// 平移看得见的槽（尺寸不变）。窗口里的合成内容跟着窗口走。
    fn translate(&mut self, pin: usize, rect: Rect);
    /// 把备用槽摆到 `rect`，保持看不见。之后渲染层往备用槽 Present。
    fn stage(&mut self, pin: usize, rect: Rect);
    /// 等备用槽的 Present 和摆放都被合成器收下，再一次提交换上来。返回等待的毫秒数。
    fn swap(&mut self, pin: usize) -> f64;
    /// 第 `slot` 个槽是不是看得见的那个。
    fn visible_slot(&self, pin: usize) -> usize;
    fn set_click_through(&mut self, pin: usize, on: bool);
    /// 处理排队的窗口消息，取出输入。
    fn pump(&mut self) -> Vec<Input>;
    /// 每一轮循环调一次：收起已换下、合成器也已不再显示的槽。
    fn housekeeping(&mut self);
    fn close(&mut self, pin: usize);
}

thread_local! {
    static INPUT: RefCell<VecDeque<Input>> = const { RefCell::new(VecDeque::new()) };
}

struct Slot {
    hwnd: HWND,
    _target: IDCompositionTarget,
    visual: IDCompositionVisual3,
    shown: bool,
}

struct WinPin {
    slots: [Slot; 2],
    visible: usize,
    /// 换下来的槽和换下的时刻（QPC），过两个刷新周期再隐藏。
    retire: Option<(usize, i64)>,
}

pub struct WinShell {
    dcomp: IDCompositionDesktopDevice,
    pins: Vec<Option<WinPin>>,
    refresh_ticks: i64,
}

impl WinShell {
    pub fn new() -> windows::core::Result<WinShell> {
        unsafe {
            let instance = GetModuleHandleW(None)?;
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(wndproc),
                hInstance: instance.into(),
                hCursor: LoadCursorW(None, IDC_ARROW)?,
                lpszClassName: w!("KinshokoPinGpuProbe"),
                ..Default::default()
            };
            RegisterClassExW(&class);
            let dcomp: IDCompositionDesktopDevice = DCompositionCreateDevice3(None)?;
            let period_ms = crate::sys::refresh_ms();
            Ok(WinShell {
                dcomp,
                pins: Vec::new(),
                refresh_ticks: (period_ms * crate::sys::qpf() as f64 / 1000.0) as i64,
            })
        }
    }

    fn pin(&self, pin: usize) -> &WinPin {
        self.pins[pin].as_ref().expect("钉图已关")
    }

    fn pin_mut(&mut self, pin: usize) -> &mut WinPin {
        self.pins[pin].as_mut().expect("钉图已关")
    }

    /// 提交 DComp 改动（对照组用：交换链换了尺寸后重新挂上）。
    pub fn commit(&self) {
        unsafe {
            let _ = self.dcomp.Commit();
        }
    }

    pub fn hwnd(&self, pin: usize, slot: usize) -> HWND {
        self.pin(pin).slots[slot].hwnd
    }

    fn slot(&self, pin: usize, index: usize) -> windows::core::Result<Slot> {
        unsafe {
            let hwnd = CreateWindowExW(
                // 不重定向（只有 DComp 内容）、置顶、不激活、工具窗口（不进任务栏和 Alt+Tab，
                // Chromium 的遮挡判定也跳过它，#275）。
                WS_EX_NOREDIRECTIONBITMAP | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                w!("KinshokoPinGpuProbe"),
                w!("pin"),
                WS_POPUP,
                0,
                0,
                1,
                1,
                None,
                None,
                Some(GetModuleHandleW(None)?.into()),
                None,
            )?;
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, ((pin << 1) | index) as isize);
            let target = self.dcomp.CreateTargetForHwnd(hwnd, true)?;
            let visual: IDCompositionVisual3 = self.dcomp.CreateVisual()?.cast()?;
            visual.SetOpacity2(if index == 0 { 1.0 } else { 0.0 })?;
            target.SetRoot(&visual)?;
            Ok(Slot {
                hwnd,
                _target: target,
                visual,
                shown: false,
            })
        }
    }

    fn place(&mut self, pin: usize, slot: usize, rect: Rect, insert_after: Option<HWND>) {
        let s = &mut self.pin_mut(pin).slots[slot];
        let mut flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER;
        if !s.shown {
            flags |= SWP_SHOWWINDOW;
            s.shown = true;
        }
        let after = insert_after.or(Some(HWND_TOPMOST));
        unsafe {
            let _ = SetWindowPos(s.hwnd, after, rect.x, rect.y, rect.w, rect.h, flags);
        }
    }
}

impl Shell for WinShell {
    fn create(&mut self, pin: usize) -> [wgpu::SurfaceTargetUnsafe; 2] {
        let a = self.slot(pin, 0).expect("建窗口失败");
        let b = self.slot(pin, 1).expect("建窗口失败");
        let targets = [
            wgpu::SurfaceTargetUnsafe::CompositionVisual(a.visual.as_raw()),
            wgpu::SurfaceTargetUnsafe::CompositionVisual(b.visual.as_raw()),
        ];
        if self.pins.len() <= pin {
            self.pins.resize_with(pin + 1, || None);
        }
        self.pins[pin] = Some(WinPin {
            slots: [a, b],
            visible: 0,
            retire: None,
        });
        unsafe {
            let _ = self.dcomp.Commit();
        }
        targets
    }

    fn show(&mut self, pin: usize, rect: Rect) {
        let v = self.pin(pin).visible;
        self.place(pin, v, rect, None);
        // 渲染层第一次 Present 时把交换链挂上 visual（SetContent），但不提交：这里提交才显示出来。
        self.commit();
    }

    fn translate(&mut self, pin: usize, rect: Rect) {
        let p = self.pin(pin);
        let hwnd = p.slots[p.visible].hwnd;
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                None,
                rect.x,
                rect.y,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOSIZE | SWP_NOOWNERZORDER,
            );
        }
    }

    fn stage(&mut self, pin: usize, rect: Rect) {
        // 备用槽可能刚换下、还没隐藏：它的不透明度已经是 0，直接重摆。
        let p = self.pin_mut(pin);
        let standby = 1 - p.visible;
        if p.retire.is_some_and(|(s, _)| s == standby) {
            p.retire = None;
        }
        let above = p.slots[p.visible].hwnd;
        // 摆在看得见的槽紧下面：换上来之前两者都在时，指针仍落在原来那个上。
        self.place(pin, standby, rect, Some(above));
    }

    fn swap(&mut self, pin: usize) -> f64 {
        let t = crate::sys::qpc();
        // 等合成器收下备用槽的 Present 与摆放（DwmFlush：直到下一次合成，所有已提交的 DX 表面更新都已生效）。
        unsafe {
            let _ = DwmFlush();
        }
        let waited = crate::sys::ms_since(t);
        let dcomp = self.dcomp.clone();
        let p = self.pin_mut(pin);
        let old = p.visible;
        let new = 1 - old;
        unsafe {
            let _ = p.slots[new].visual.SetOpacity2(1.0);
            let _ = p.slots[old].visual.SetOpacity2(0.0);
            let _ = dcomp.Commit();
            // 拖动中换窗口：指针捕获跟过去。
            if GetCapture() == p.slots[old].hwnd {
                SetCapture(p.slots[new].hwnd);
            }
        }
        p.visible = new;
        p.retire = Some((old, crate::sys::qpc()));
        waited
    }

    fn visible_slot(&self, pin: usize) -> usize {
        self.pin(pin).visible
    }

    fn set_click_through(&mut self, pin: usize, on: bool) {
        for s in &self.pin(pin).slots {
            unsafe {
                let ex = GetWindowLongW(s.hwnd, GWL_EXSTYLE) as u32;
                let ex = if on {
                    ex | (WS_EX_LAYERED | WS_EX_TRANSPARENT).0
                } else {
                    ex & !(WS_EX_LAYERED | WS_EX_TRANSPARENT).0
                };
                SetWindowLongW(s.hwnd, GWL_EXSTYLE, ex as i32);
            }
        }
    }

    fn pump(&mut self) -> Vec<Input> {
        unsafe {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        INPUT.with(|q| q.borrow_mut().drain(..).collect())
    }

    fn housekeeping(&mut self) {
        let now = crate::sys::qpc();
        let wait = self.refresh_ticks * 2;
        for p in self.pins.iter_mut().flatten() {
            if let Some((slot, at)) = p.retire
                && now - at >= wait
            {
                let s = &mut p.slots[slot];
                unsafe {
                    let _ = ShowWindow(s.hwnd, SW_HIDE);
                }
                s.shown = false;
                p.retire = None;
            }
        }
    }

    fn close(&mut self, pin: usize) {
        if let Some(p) = self.pins[pin].take() {
            for s in p.slots {
                unsafe {
                    let _ = DestroyWindow(s.hwnd);
                }
            }
        }
    }
}

fn point(lp: LPARAM) -> (i32, i32) {
    (
        (lp.0 & 0xffff) as i16 as i32,
        ((lp.0 >> 16) & 0xffff) as i16 as i32,
    )
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let tag = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as usize;
    let pin = tag >> 1;
    let to_screen = |lp: LPARAM| {
        let (x, y) = point(lp);
        let mut p = POINT { x, y };
        unsafe {
            let _ = windows::Win32::Graphics::Gdi::ClientToScreen(hwnd, &mut p);
        }
        (p.x, p.y)
    };
    let push = |i: Input| INPUT.with(|q| q.borrow_mut().push_back(i));
    match msg {
        // 点钉图不抢绘画软件的焦点。
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        WM_MOUSEWHEEL => {
            let (x, y) = point(lp);
            let delta = ((wp.0 >> 16) & 0xffff) as i16 as f64;
            push(Input::Wheel {
                pin,
                x,
                y,
                notches: delta / 120.0,
            });
            return LRESULT(0);
        }
        WM_LBUTTONDOWN => {
            let (x, y) = to_screen(lp);
            unsafe {
                SetCapture(hwnd);
            }
            push(Input::Down { pin, x, y });
            return LRESULT(0);
        }
        WM_MOUSEMOVE => {
            let (x, y) = to_screen(lp);
            push(Input::Move { pin, x, y });
            return LRESULT(0);
        }
        WM_LBUTTONUP => {
            let (x, y) = to_screen(lp);
            unsafe {
                let _ = ReleaseCapture();
            }
            push(Input::Up { pin, x, y });
            return LRESULT(0);
        }
        WM_RBUTTONUP => {
            push(Input::Context { pin });
            return LRESULT(0);
        }
        _ => {}
    }
    unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
}
