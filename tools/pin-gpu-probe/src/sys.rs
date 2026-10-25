//! 测量用的系统读数：计时、显示器、刷新周期、内存、显存、全屏判定。只读。

use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::Graphics::Dwm::{DWM_TIMING_INFO, DwmGetCompositionTimingInfo};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory2, DXGI_CREATE_FACTORY_FLAGS, DXGI_MEMORY_SEGMENT_GROUP_LOCAL,
    DXGI_QUERY_VIDEO_MEMORY_INFO, IDXGIAdapter3, IDXGIFactory4,
};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTOPRIMARY, MONITORINFO, MonitorFromPoint};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX};
use windows::Win32::System::Threading::GetCurrentProcess;
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Shell::SHQueryUserNotificationState;
use windows::core::Interface;

use crate::geom::Rect;

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

pub fn ms_since(t: i64) -> f64 {
    (qpc() - t) as f64 * 1000.0 / qpf() as f64
}

pub fn refresh_ms() -> f64 {
    let mut info = DWM_TIMING_INFO {
        cbSize: std::mem::size_of::<DWM_TIMING_INFO>() as u32,
        ..Default::default()
    };
    match unsafe { DwmGetCompositionTimingInfo(HWND::default(), &mut info) } {
        Ok(()) if info.qpcRefreshPeriod > 0 => {
            info.qpcRefreshPeriod as f64 * 1000.0 / qpf() as f64
        }
        _ => 1000.0 / 60.0,
    }
}

/// 主显示器（矩形，DPI）。
pub fn primary_monitor() -> (Rect, u32) {
    unsafe {
        let m = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let _ = GetMonitorInfoW(m, &mut info);
        let r = info.rcMonitor;
        let (mut dx, mut dy) = (96, 96);
        let _ = GetDpiForMonitor(m, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
        (Rect::new(r.left, r.top, r.right - r.left, r.bottom - r.top), dx)
    }
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

/// 进程私有提交（MB）。
pub fn private_mb() -> f64 {
    let mut c = PROCESS_MEMORY_COUNTERS_EX {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        ..Default::default()
    };
    unsafe {
        let _ = GetProcessMemoryInfo(GetCurrentProcess(), &mut c as *mut _ as *mut _, c.cb);
    }
    c.PrivateUsage as f64 / 1048576.0
}

/// 本进程在第一块（独立）显卡本地段上的显存占用（MB）。
pub fn vram_mb() -> f64 {
    unsafe {
        let Ok(f) = CreateDXGIFactory2::<IDXGIFactory4>(DXGI_CREATE_FACTORY_FLAGS(0)) else {
            return f64::NAN;
        };
        let Ok(a) = f.EnumAdapters1(0) else {
            return f64::NAN;
        };
        let Ok(a) = a.cast::<IDXGIAdapter3>() else {
            return f64::NAN;
        };
        let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
        if a.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info).is_err() {
            return f64::NAN;
        }
        info.CurrentUsage as f64 / 1048576.0
    }
}
