//! 读显示器：物理像素矩形、缩放比例、当前的颜色配置文件。配置文件与应用壳 `win32.rs` 的
//! `display_profile` 同一读法（按设备名建 DC，`GetICMProfileW` 取路径，读文件）。

use std::path::PathBuf;

use windows::Win32::Foundation::{LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    CreateDCW, DeleteDC, EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
    MONITORINFOEXW,
};
use windows::Win32::UI::ColorSystem::GetICMProfileW;
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::core::{BOOL, PCWSTR};

use crate::ScreenRect;
use crate::displays::{Display, Layout, scale_from_dpi};

/// 现在的显示器布局（配置文件只取路径）。
pub(super) fn layouts() -> Vec<Layout> {
    monitors()
        .into_iter()
        .map(|m| {
            let profile = profile_path(&m.id).map(|p| p.to_string_lossy().into_owned());
            Layout {
                id: m.id,
                rect: m.rect,
                scale: m.scale,
                profile,
            }
        })
        .collect()
}

/// 现在的显示器（读配置文件字节）。
pub(super) fn displays() -> Vec<Display> {
    monitors()
        .into_iter()
        .map(|m| {
            let profile = profile_path(&m.id).and_then(|p| std::fs::read(p).ok());
            Display {
                id: m.id,
                rect: m.rect,
                scale: m.scale,
                profile,
            }
        })
        .collect()
}

struct Monitor {
    id: String,
    rect: ScreenRect,
    scale: f64,
}

fn monitors() -> Vec<Monitor> {
    let mut handles: Vec<HMONITOR> = Vec::new();
    unsafe extern "system" fn each(m: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        // SAFETY：`data` 是下面传入的 `&mut Vec<HMONITOR>`，枚举期间有效。
        let handles = unsafe { &mut *(data.0 as *mut Vec<HMONITOR>) };
        handles.push(m);
        true.into()
    }
    // SAFETY：回调只往 `handles` 里推句柄；`handles` 在枚举期间由本函数持有。
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(each),
            LPARAM(&mut handles as *mut Vec<HMONITOR> as isize),
        );
    }
    handles.into_iter().filter_map(describe).collect()
}

fn describe(m: HMONITOR) -> Option<Monitor> {
    let mut info = MONITORINFOEXW {
        monitorInfo: MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFOEXW>() as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    // SAFETY：`info` 由本函数持有，`cbSize` 表明是扩展结构。
    unsafe { GetMonitorInfoW(m, &mut info.monitorInfo) }
        .ok()
        .ok()?;
    let (mut dx, mut dy) = (96, 96);
    // SAFETY：出参由本函数持有。失败时按 100%。
    let _ = unsafe { GetDpiForMonitor(m, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) };
    let r = info.monitorInfo.rcMonitor;
    let end = info
        .szDevice
        .iter()
        .position(|&c| c == 0)
        .unwrap_or(info.szDevice.len());
    Some(Monitor {
        id: String::from_utf16_lossy(&info.szDevice[..end]),
        rect: ScreenRect {
            x: r.left,
            y: r.top,
            width: (r.right - r.left).max(0) as u32,
            height: (r.bottom - r.top).max(0) as u32,
        },
        scale: scale_from_dpi(dx),
    })
}

fn profile_path(device: &str) -> Option<PathBuf> {
    let device: Vec<u16> = device.encode_utf16().chain(Some(0)).collect();
    let name = PCWSTR(device.as_ptr());
    // SAFETY：设备名是以 0 结尾的 UTF-16 串，在调用期间有效；其余参数允许为空。
    let hdc = unsafe { CreateDCW(name, name, PCWSTR::null(), None) };
    if hdc.is_invalid() {
        return None;
    }
    let mut buffer = vec![0u16; 260];
    let mut len = buffer.len() as u32;
    // SAFETY：`hdc` 有效；`len` 是 `buffer` 的容量（以 u16 计），函数最多写这么多。
    let mut ok = unsafe {
        GetICMProfileW(
            hdc,
            &mut len,
            Some(windows::core::PWSTR(buffer.as_mut_ptr())),
        )
    };
    if !ok.as_bool() && len as usize > buffer.len() {
        // 路径比默认缓冲区长：`len` 已是需要的长度，按它重试一次。
        buffer = vec![0u16; len as usize];
        // SAFETY：同上，`len` 等于新缓冲区的容量。
        ok = unsafe {
            GetICMProfileW(
                hdc,
                &mut len,
                Some(windows::core::PWSTR(buffer.as_mut_ptr())),
            )
        };
    }
    // SAFETY：`hdc` 由上面的 CreateDCW 创建，只在这里释放一次。
    let _ = unsafe { DeleteDC(hdc) };
    if !ok.as_bool() {
        return None;
    }
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    Some(PathBuf::from(String::from_utf16_lossy(&buffer[..end])))
}
