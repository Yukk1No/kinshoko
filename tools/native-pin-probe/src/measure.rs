//! 计时、DWM 帧统计、显示器信息、内存与“全屏”判定。只读系统状态。

use std::path::PathBuf;

use windows::Win32::Devices::Display::*;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DWM_TIMING_INFO, DwmGetCompositionTimingInfo};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX};
use windows::Win32::System::Threading::GetCurrentProcess;
use windows::Win32::UI::ColorSystem::GetICMProfileW;
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Shell::SHQueryUserNotificationState;
use windows::core::{BOOL, PCWSTR, PWSTR};

use crate::raster::Rect;

pub fn qpc() -> i64 {
    let mut v = 0;
    unsafe { QueryPerformanceCounter(&mut v).ok() };
    v
}

pub fn qpf() -> i64 {
    static F: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *F.get_or_init(|| {
        let mut v = 0;
        unsafe { QueryPerformanceFrequency(&mut v).ok() };
        v
    })
}

pub fn ms(ticks: i64) -> f64 {
    ticks as f64 * 1000.0 / qpf() as f64
}

/// 整个桌面的合成统计（hwnd 为空时就是 DWM 自己的）。
pub fn dwm_timing() -> Option<DWM_TIMING_INFO> {
    let mut info = DWM_TIMING_INFO {
        cbSize: std::mem::size_of::<DWM_TIMING_INFO>() as u32,
        ..Default::default()
    };
    unsafe { DwmGetCompositionTimingInfo(HWND::default(), &mut info) }
        .ok()
        .map(|_| info)
}

/// `t`（QPC）之后的下一次垂直同步。
pub fn next_vblank_after(t: i64) -> Option<i64> {
    let info = dwm_timing()?;
    let period = info.qpcRefreshPeriod as i64;
    let vb = info.qpcVBlank as i64;
    if period <= 0 {
        return None;
    }
    let n = ((t - vb) as f64 / period as f64).ceil() as i64;
    Some(vb + n.max(0) * period)
}

pub fn quns() -> String {
    match unsafe { SHQueryUserNotificationState() } {
        Ok(s) => match s.0 {
            1 => "QUNS_NOT_PRESENT".into(),
            2 => "QUNS_BUSY".into(),
            3 => "QUNS_RUNNING_D3D_FULL_SCREEN".into(),
            4 => "QUNS_PRESENTATION_MODE".into(),
            5 => "QUNS_ACCEPTS_NOTIFICATIONS".into(),
            6 => "QUNS_QUIET_TIME".into(),
            7 => "QUNS_APP".into(),
            n => format!("未知 {n}"),
        },
        Err(e) => format!("查询失败 {e}"),
    }
}

/// （私有提交字节，工作集字节）
pub fn process_memory() -> (usize, usize) {
    let mut c = PROCESS_MEMORY_COUNTERS_EX {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        ..Default::default()
    };
    unsafe {
        let _ = GetProcessMemoryInfo(GetCurrentProcess(), &mut c as *mut _ as *mut _, c.cb);
    }
    (c.PrivateUsage, c.WorkingSetSize)
}

#[derive(Debug, Clone)]
pub struct Monitor {
    pub rect: Rect,
    pub work: Rect,
    pub device: String,
    pub dpi: u32,
    pub refresh_hz: u32,
    pub icc: Option<PathBuf>,
    pub colour_mode: String,
}

fn rect(r: RECT) -> Rect {
    Rect {
        x: r.left,
        y: r.top,
        w: r.right - r.left,
        h: r.bottom - r.top,
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn from_wide(b: &[u16]) -> String {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf16_lossy(&b[..end])
}

pub fn monitors() -> Vec<Monitor> {
    unsafe extern "system" fn each(m: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let list = unsafe { &mut *(data.0 as *mut Vec<HMONITOR>) };
        list.push(m);
        BOOL(1)
    }
    let mut handles: Vec<HMONITOR> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(each),
            LPARAM(&mut handles as *mut _ as isize),
        );
    }
    let modes = colour_modes();
    handles
        .into_iter()
        .filter_map(|h| {
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            unsafe { GetMonitorInfoW(h, &mut info as *mut _ as *mut MONITORINFO) }
                .ok()
                .ok()?;
            let device = from_wide(&info.szDevice);
            let (mut dx, mut dy) = (96, 96);
            unsafe {
                let _ = GetDpiForMonitor(h, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
            }
            let mut dm = DEVMODEW {
                dmSize: std::mem::size_of::<DEVMODEW>() as u16,
                ..Default::default()
            };
            let dev = wide(&device);
            unsafe {
                let _ = EnumDisplaySettingsW(PCWSTR(dev.as_ptr()), ENUM_CURRENT_SETTINGS, &mut dm);
            }
            Some(Monitor {
                rect: rect(info.monitorInfo.rcMonitor),
                work: rect(info.monitorInfo.rcWork),
                icc: profile_path(&device),
                colour_mode: modes
                    .iter()
                    .find(|(d, _)| *d == device)
                    .map(|(_, m)| m.clone())
                    .unwrap_or_default(),
                device,
                dpi: dx,
                refresh_hz: dm.dmDisplayFrequency,
            })
        })
        .collect()
}

/// 与 `src-tauri/src/desktop/win32.rs` 的 `display_profile` 相同的读法。
pub fn profile_path(device: &str) -> Option<PathBuf> {
    let dev = wide(device);
    let hdc = unsafe {
        CreateDCW(
            PCWSTR(dev.as_ptr()),
            PCWSTR(dev.as_ptr()),
            PCWSTR::null(),
            None,
        )
    };
    if hdc.is_invalid() {
        return None;
    }
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    let ok = unsafe { GetICMProfileW(hdc, &mut len, Some(PWSTR(buf.as_mut_ptr()))) };
    unsafe {
        let _ = DeleteDC(hdc);
    }
    ok.as_bool().then(|| PathBuf::from(from_wide(&buf)))
}

#[repr(C)]
#[derive(Default)]
struct AdvancedColorInfo2 {
    header: DISPLAYCONFIG_DEVICE_INFO_HEADER,
    value: u32,
    color_encoding: i32,
    bits_per_color_channel: u32,
    active_color_mode: i32,
}

/// （GDI 设备名，色彩模式）：SDR／自动色彩管理（ACM）／HDR。
fn colour_modes() -> Vec<(String, String)> {
    let (mut np, mut nm) = (0u32, 0u32);
    unsafe {
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut np, &mut nm).is_err() {
            return Vec::new();
        }
    }
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); np as usize];
    let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); nm as usize];
    unsafe {
        if QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut np,
            paths.as_mut_ptr(),
            &mut nm,
            modes.as_mut_ptr(),
            None,
        )
        .is_err()
        {
            return Vec::new();
        }
    }
    paths.truncate(np as usize);
    paths
        .iter()
        .map(|p| {
            let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                    size: std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                    adapterId: p.sourceInfo.adapterId,
                    id: p.sourceInfo.id,
                },
                ..Default::default()
            };
            unsafe { DisplayConfigGetDeviceInfo(&mut source.header) };
            let mut info2 = AdvancedColorInfo2 {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_TYPE(15),
                    size: std::mem::size_of::<AdvancedColorInfo2>() as u32,
                    adapterId: p.targetInfo.adapterId,
                    id: p.targetInfo.id,
                },
                ..Default::default()
            };
            let mode = if unsafe { DisplayConfigGetDeviceInfo(&mut info2.header) } == 0 {
                match info2.active_color_mode {
                    0 => "SDR".to_owned(),
                    1 => "自动色彩管理(ACM)".to_owned(),
                    2 => "HDR".to_owned(),
                    n => format!("未知 {n}"),
                }
            } else {
                "未知（旧系统）".to_owned()
            };
            (from_wide(&source.viewGdiDeviceName), mode)
        })
        .collect()
}

/// 一组数的摘要：个数、中位数、p95、p99、最大值。
pub fn summary(name: &str, v: &mut [f64]) -> String {
    if v.is_empty() {
        return format!("{name}: 无数据");
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let at = |p: f64| v[((v.len() - 1) as f64 * p).round() as usize];
    format!(
        "{name}: n={} 中位 {:.2} p95 {:.2} p99 {:.2} 最大 {:.2}",
        v.len(),
        at(0.5),
        at(0.95),
        at(0.99),
        v[v.len() - 1]
    )
}
