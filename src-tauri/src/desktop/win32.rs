//! 读取显示器当前使用的颜色配置文件（ICC）。
//!
//! Windows 只以 GDI 函数提供这项信息，没有安全的 Rust 封装，所以本模块是应用壳里唯一允许
//! `unsafe` 的地方。每处调用都只传本函数自己持有的缓冲区，句柄在同一函数内创建并释放。
#![allow(unsafe_code)]

use std::path::PathBuf;
use std::ptr;

use windows_sys::Win32::Graphics::Gdi::{CreateDCW, DeleteDC};
use windows_sys::Win32::UI::ColorSystem::GetICMProfileW;

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
