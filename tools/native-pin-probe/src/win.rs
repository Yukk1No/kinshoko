//! 窗口类、窗口过程与低级键盘钩子：只把输入排进队列，处理在消息循环里。

#![allow(unused_imports)]

use std::fmt::Write as _;
use std::sync::{Arc, Mutex};

use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Dwm::DwmFlush;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{PCWSTR, w};

use crate::measure::{self, ms, qpc};
use crate::raster::{Crop, PIN_EDGE, Quality, Rasterizer, Rect, View};
use crate::*;

pub(crate) fn pin_index(hwnd: HWND) -> usize {
    unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as usize }
}

pub(crate) fn screen_xy(lparam: LPARAM) -> (i32, i32) {
    (
        (lparam.0 & 0xFFFF) as i16 as i32,
        ((lparam.0 >> 16) & 0xFFFF) as i16 as i32,
    )
}

pub(crate) unsafe extern "system" fn wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let t = qpc();
    match msg {
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        WM_MOUSEWHEEL => {
            let (x, y) = screen_xy(lparam);
            push(Ev::Wheel {
                pin: pin_index(hwnd),
                delta: ((wparam.0 >> 16) & 0xFFFF) as i16,
                x,
                y,
                t,
            });
            return LRESULT(0);
        }
        WM_LBUTTONDOWN => {
            let mut p = POINT::default();
            unsafe {
                let _ = GetCursorPos(&mut p);
                SetCapture(hwnd);
            }
            push(Ev::Down {
                pin: pin_index(hwnd),
                x: p.x,
                y: p.y,
            });
            return LRESULT(0);
        }
        WM_MOUSEMOVE if wparam.0 & 1 != 0 => {
            let mut p = POINT::default();
            unsafe {
                let _ = GetCursorPos(&mut p);
            }
            push(Ev::Drag { x: p.x, y: p.y, t });
            return LRESULT(0);
        }
        WM_LBUTTONUP => {
            unsafe {
                let _ = ReleaseCapture();
            }
            push(Ev::Up);
            return LRESULT(0);
        }
        WM_RBUTTONUP => {
            let mut p = POINT::default();
            unsafe {
                let _ = GetCursorPos(&mut p);
            }
            push(Ev::Menu {
                pin: pin_index(hwnd),
                x: p.x,
                y: p.y,
            });
            return LRESULT(0);
        }
        WM_TIMER => {
            unsafe {
                let _ = KillTimer(Some(hwnd), wparam.0);
            }
            push(Ev::Settle {
                pin: pin_index(hwnd),
            });
            return LRESULT(0);
        }
        _ => {}
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// 光标在钉图上时，H/V/R/C/T/N/A/1/[/]/Esc 归钉图（并吞掉，不传给前台程序）；不在时原样放行。
/// 钉图窗口不激活、拿不到键盘焦点，所以用低级键盘钩子。
pub(crate) unsafe extern "system" fn keyboard_hook(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if code == HC_ACTION as i32
        && (wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN)
    {
        let k = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let ours = matches!(
            k.vkCode,
            0x48 | 0x56 | 0x52 | 0x43 | 0x54 | 0x4E | 0x41 | 0x31 | 0xDB | 0xDD | 0x1B
        );
        if ours && !MENU_OPEN.with(|m| m.get()) {
            let mut p = POINT::default();
            unsafe {
                let _ = GetCursorPos(&mut p);
            }
            let hit = RECTS.with(|r| {
                r.borrow()
                    .iter()
                    .rev()
                    .find(|(_, rect, _)| rect.contains(p.x, p.y))
                    .map(|(i, _, h)| (*i, *h))
            });
            if let Some((pin, hwnd)) = hit {
                push(Ev::Key {
                    pin,
                    vk: k.vkCode,
                    t: qpc(),
                });
                unsafe {
                    let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
                }
                return LRESULT(1);
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

pub(crate) fn create_window(index: usize, gpu: bool) -> HWND {
    unsafe {
        let instance = GetModuleHandleW(None).unwrap();
        let class = w!("KinshokoNativePin");
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(wndproc),
            hInstance: instance.into(),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap(),
            lpszClassName: class,
            ..Default::default()
        };
        RegisterClassExW(&wc); // 第二次注册失败无妨
        let hwnd = CreateWindowExW(
            // DComp 窗口不能是分层窗口，用 NOREDIRECTIONBITMAP（整个窗口矩形都接点击）。
            if gpu {
                WS_EX_NOREDIRECTIONBITMAP
            } else {
                WS_EX_LAYERED
            } | WS_EX_TOPMOST
                | WS_EX_NOACTIVATE
                | WS_EX_TOOLWINDOW,
            class,
            w!("钉图"),
            WS_POPUP,
            0,
            0,
            1,
            1,
            None,
            None,
            Some(instance.into()),
            None,
        )
        .expect("CreateWindowExW");
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, index as isize);
        hwnd
    }
}
