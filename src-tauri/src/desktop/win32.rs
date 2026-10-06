//! 直接调用的 Windows 接口：显示器当前使用的颜色配置文件（ICC，#62）；前台窗口、交还焦点与
//! 光标位置（贴边隐藏，#63）。
//!
//! 这些信息只有 Win32 函数提供，没有安全的 Rust 封装，所以本模块是应用壳里唯一允许
//! `unsafe` 的地方。每处调用都只传本函数自己持有的缓冲区，句柄在同一函数内创建并释放。
#![allow(unsafe_code)]

use std::path::PathBuf;
use std::ptr;

use windows_sys::Win32::Foundation::{HWND, POINT};
use windows_sys::Win32::Graphics::Gdi::{CreateDCW, DeleteDC};
use windows_sys::Win32::UI::ColorSystem::GetICMProfileW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetWindowThreadProcessId, IsWindow, SetForegroundWindow,
};

/// 前台窗口（句柄按整数传，便于跨线程保存）与它所属的进程 id。没有前台窗口时为 `None`。
pub fn foreground_window() -> Option<(isize, u32)> {
    // SAFETY：无参数，只读取系统状态。
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_null() {
        return None;
    }
    let mut pid = 0u32;
    // SAFETY：`hwnd` 由系统返回；`pid` 是本函数持有的变量。
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    Some((hwnd as isize, pid))
}

/// 把 `hwnd`（由 [`foreground_window`] 得到）设为前台窗口。系统只在本进程当前处于前台时允许。
/// 窗口已经不在或系统拒绝时返回 false。
pub fn set_foreground(hwnd: isize) -> bool {
    let hwnd = hwnd as HWND;
    // SAFETY：IsWindow 接受任意值；已销毁的句柄只会让它返回 0。
    if unsafe { IsWindow(hwnd) } == 0 {
        return false;
    }
    // SAFETY：`hwnd` 刚确认是有效窗口。
    unsafe { SetForegroundWindow(hwnd) != 0 }
}

/// 光标位置，物理像素（进程是每显示器 DPI 感知）。
pub fn cursor_position() -> Option<(i32, i32)> {
    let mut point = POINT { x: 0, y: 0 };
    // SAFETY：`point` 是本函数持有的变量。
    (unsafe { GetCursorPos(&mut point) } != 0).then_some((point.x, point.y))
}

/// `device` 为显示器的设备名（`MONITORINFOEXW.szDevice`，例如 `\\.\DISPLAY1`）。
/// 读不到时为 `None`，截图按 sRGB 解释。
pub fn display_profile(device: &str) -> Option<Vec<u8>> {
    let path = profile_path(device)?;
    std::fs::read(path).ok()
}

fn profile_path(device: &str) -> Option<PathBuf> {
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let device = wide(device);
    // SAFETY：两个参数都是以 0 结尾的 UTF-16 串，在调用期间有效；其余参数允许为空。
    let hdc = unsafe { CreateDCW(device.as_ptr(), device.as_ptr(), ptr::null(), ptr::null()) };
    if hdc.is_null() {
        return None;
    }
    let mut buffer = vec![0u16; 260];
    let mut len = buffer.len() as u32;
    // SAFETY：`hdc` 有效；`len` 是 `buffer` 的容量（以 u16 计），函数最多写这么多。
    let mut ok = unsafe { GetICMProfileW(hdc, &mut len, buffer.as_mut_ptr()) };
    if ok == 0 && len as usize > buffer.len() {
        // 路径比默认缓冲区长：`len` 已是需要的长度，按它重试一次。
        buffer = vec![0u16; len as usize];
        // SAFETY：同上，`len` 等于新缓冲区的容量。
        ok = unsafe { GetICMProfileW(hdc, &mut len, buffer.as_mut_ptr()) };
    }
    // SAFETY：`hdc` 由上面的 CreateDCW 创建，只在这里释放一次。
    unsafe { DeleteDC(hdc) };
    if ok == 0 {
        return None;
    }
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    Some(PathBuf::from(String::from_utf16_lossy(&buffer[..end])))
}
