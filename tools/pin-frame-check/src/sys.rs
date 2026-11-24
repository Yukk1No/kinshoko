//! 测量用的系统读数：刷新周期、全屏判定、内存、显存。只读。

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{DWM_TIMING_INFO, DwmFlush, DwmGetCompositionTimingInfo};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory2, DXGI_CREATE_FACTORY_FLAGS, DXGI_MEMORY_SEGMENT_GROUP_LOCAL,
    DXGI_QUERY_VIDEO_MEMORY_INFO, IDXGIAdapter3, IDXGIFactory4,
};
use windows::Win32::System::Performance::QueryPerformanceFrequency;
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX};
use windows::Win32::System::Threading::GetCurrentProcess;
use windows::Win32::UI::Shell::SHQueryUserNotificationState;
use windows::core::Interface;

/// 一个刷新周期（毫秒）。
pub fn refresh_ms() -> f64 {
    let mut info = DWM_TIMING_INFO {
        cbSize: std::mem::size_of::<DWM_TIMING_INFO>() as u32,
        ..Default::default()
    };
    let mut freq = 0;
    let ok = unsafe {
        DwmGetCompositionTimingInfo(HWND::default(), &mut info).is_ok()
            && QueryPerformanceFrequency(&mut freq).is_ok()
    };
    if ok && info.qpcRefreshPeriod > 0 && freq > 0 {
        info.qpcRefreshPeriod as f64 * 1000.0 / freq as f64
    } else {
        1000.0 / 60.0
    }
}

/// 等到下一次合成（脚本节奏：一步一帧）。只在工具的脚本里用，平台层不这样等。
pub fn next_frame() {
    unsafe {
        let _ = DwmFlush();
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

/// 本进程在第一块显卡本地段上的显存占用（MB）。
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
        if a.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info)
            .is_err()
        {
            return f64::NAN;
        }
        info.CurrentUsage as f64 / 1048576.0
    }
}

/// 中位数、p95、p99、最大值。
pub fn stats(v: impl Iterator<Item = f64>) -> [f64; 4] {
    let mut v: Vec<f64> = v.collect();
    if v.is_empty() {
        return [0.0; 4];
    }
    v.sort_by(|a, b| a.total_cmp(b));
    let at = |p: f64| v[((v.len() - 1) as f64 * p).round() as usize];
    [at(0.5), at(0.95), at(0.99), v[v.len() - 1]]
}
