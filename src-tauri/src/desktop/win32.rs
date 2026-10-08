//! 直接调用的 Windows 接口：显示器当前使用的颜色配置文件（ICC，#62）；前台窗口、交还焦点与
//! 光标位置（贴边隐藏，#63）；一次调用同时改钉图窗口的位置与尺寸（#64）；诊断日志用的系统版本、
//! 处理器、内存、显卡与显示器色彩模式（#70）。
//!
//! 这些信息只有 Win32 函数提供，没有安全的 Rust 封装，所以本模块是应用壳里唯一允许
//! `unsafe` 的地方。每处调用都只传本函数自己持有的缓冲区，句柄在同一函数内创建并释放。
#![allow(unsafe_code)]

use std::path::PathBuf;
use std::ptr;

use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::{CreateDCW, DeleteDC};
use windows_sys::Win32::UI::ColorSystem::GetICMProfileW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GW_HWNDNEXT, GetCursorPos, GetForegroundWindow, GetTopWindow, GetWindow, GetWindowRect,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, SWP_NOACTIVATE,
    SWP_NOOWNERZORDER, SWP_NOZORDER, SetForegroundWindow, SetWindowPos,
};

/// 冻结截图时位于目标上方的窗口矩形。透明或异形窗口也保守地算遮挡，避免误连来源。
/// 目标消失或 Z 序遍历不稳定时返回 None，调用方按普通截图处理。
pub fn covering_windows(target: isize) -> Option<Vec<kinshoko_core::desktop::ScreenRect>> {
    let mut covered = Vec::new();
    let mut seen = std::collections::HashSet::new();
    // SAFETY：空句柄表示桌面顶层窗口；只查询系统管理的借用句柄。
    let mut window = unsafe { GetTopWindow(ptr::null_mut()) };
    while !window.is_null() && seen.len() < 10_000 && seen.insert(window as isize) {
        if window as isize == target {
            return Some(covered);
        }
        // SAFETY：系统返回的借用句柄；窗口销毁时这些查询返回失败。
        if unsafe { IsWindowVisible(window) != 0 && IsIconic(window) == 0 } {
            let mut rect: RECT = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            // SAFETY：rect 是本函数持有的有效输出缓冲区。
            if unsafe { GetWindowRect(window, &mut rect) } == 0 {
                return None;
            }
            if rect.right > rect.left && rect.bottom > rect.top {
                covered.push(kinshoko_core::desktop::ScreenRect {
                    x: rect.left,
                    y: rect.top,
                    width: rect.right.abs_diff(rect.left),
                    height: rect.bottom.abs_diff(rect.top),
                });
            }
        }
        // SAFETY：只查询下一借用句柄；seen 与数量上限保证窗口变化时也会终止。
        window = unsafe { GetWindow(window, GW_HWNDNEXT) };
    }
    None
}

/// 距离画师最后一次键盘、鼠标或笔输入过了多少毫秒（自动备份的“空闲”，#69）。读不到时为 `None`。
pub fn idle_ms() -> Option<u32> {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY：`info` 是本函数持有的结构，cbSize 已按要求填好。
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }
    // SAFETY：无参数，只读取系统计时。
    let now = unsafe { GetTickCount() };
    Some(now.wrapping_sub(info.dwTime))
}

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

/// 一次调用同时改窗口外框的位置与尺寸（物理像素）。分成移动、改尺寸两次调用时，
/// 中间会合成出位置变了尺寸没变的一帧（#64）。不改 Z 序、不激活窗口。
pub fn set_window_rect(hwnd: isize, x: i32, y: i32, width: u32, height: u32) -> bool {
    let hwnd = hwnd as HWND;
    // SAFETY：IsWindow 接受任意值；已销毁的句柄只会让它返回 0。
    if unsafe { IsWindow(hwnd) } == 0 {
        return false;
    }
    let flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
    let (w, h) = (
        width.min(i32::MAX as u32) as i32,
        height.min(i32::MAX as u32) as i32,
    );
    // SAFETY：`hwnd` 刚确认是有效窗口；其余参数都是值。
    unsafe { SetWindowPos(hwnd, ptr::null_mut(), x, y, w, h, flags) != 0 }
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

// ---- 诊断日志（#70）：只读系统信息，不写任何东西。 ----

use windows_sys::Win32::Devices::Display::{
    DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO, DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
    DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME, DISPLAYCONFIG_DEVICE_INFO_HEADER,
    DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
    DISPLAYCONFIG_SOURCE_DEVICE_NAME, DISPLAYCONFIG_TARGET_DEVICE_NAME, DisplayConfigGetDeviceInfo,
    GetDisplayConfigBufferSizes, QDC_ONLY_ACTIVE_PATHS, QueryDisplayConfig,
};
use windows_sys::Win32::Graphics::Gdi::{
    DISPLAY_DEVICE_MIRRORING_DRIVER, DISPLAY_DEVICEW, EnumDisplayDevicesW,
};
use windows_sys::Win32::System::Registry::{
    HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegGetValueW,
};
use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

use kinshoko_core::diagnostics::DisplayColourMode;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn from_wide(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end]).trim().to_owned()
}

fn registry_string(key: &str, value: &str) -> Option<String> {
    let (key, value) = (wide(key), wide(value));
    let mut buffer = vec![0u16; 256];
    let mut bytes = (buffer.len() * 2) as u32;
    // SAFETY：键名与值名是以 0 结尾的 UTF-16 串；`bytes` 是 `buffer` 的字节容量。
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    (status == 0).then(|| from_wide(&buffer))
}

fn registry_dword(key: &str, value: &str) -> Option<u32> {
    let (key, value) = (wide(key), wide(value));
    let mut data = 0u32;
    let mut bytes = 4u32;
    // SAFETY：同上；`data` 是 4 字节的本地变量。
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            ptr::null_mut(),
            (&mut data as *mut u32).cast(),
            &mut bytes,
        )
    };
    (status == 0).then_some(data)
}

/// 例如 `Windows 11 Professional 25H2（26200.9550）`。注册表的 ProductName 在 Windows 11 上仍写
/// “Windows 10”，所以按版本号判断。
pub fn windows_version() -> String {
    const KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    let build = registry_string(KEY, "CurrentBuild").unwrap_or_default();
    let name = match build.parse::<u32>() {
        Ok(b) if b >= 22000 => "Windows 11",
        Ok(_) => "Windows 10",
        Err(_) => "Windows",
    };
    let edition = registry_string(KEY, "EditionID").unwrap_or_default();
    let display = registry_string(KEY, "DisplayVersion").unwrap_or_default();
    let ubr = registry_dword(KEY, "UBR").unwrap_or(0);
    format!("{name} {edition} {display}（{build}.{ubr}）")
}

pub fn cpu_name() -> String {
    registry_string(
        r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
        "ProcessorNameString",
    )
    .unwrap_or_else(|| "未查询到".to_owned())
}

pub fn total_memory() -> u64 {
    let mut m = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    // SAFETY：`m` 是按要求设好 `dwLength` 的本地结构。
    if unsafe { GlobalMemoryStatusEx(&mut m) } != 0 {
        m.ullTotalPhys
    } else {
        0
    }
}

/// 接着显示器的显卡型号（去重）。
pub fn gpu_names() -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for i in 0.. {
        let mut device = DISPLAY_DEVICEW {
            cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
            ..Default::default()
        };
        // SAFETY：`device` 是设好 `cb` 的本地结构；第一个参数为空表示枚举显卡。
        if unsafe { EnumDisplayDevicesW(ptr::null(), i, &mut device, 0) } == 0 {
            break;
        }
        if device.StateFlags & DISPLAY_DEVICE_MIRRORING_DRIVER != 0 {
            continue;
        }
        let name = from_wide(&device.DeviceString);
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

/// 一台显示器的型号与色彩模式；`gdi_name` 为 GDI 设备名（例如 `\\.\DISPLAY1`），与 xcap 的显示器名相同。
pub struct DisplayColour {
    pub gdi_name: String,
    pub friendly_name: String,
    pub mode: DisplayColourMode,
    pub bits_per_channel: Option<u32>,
}

/// Windows 11 24H2 起的 `DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO_2`（windows-sys 0.61 还没有）。
#[repr(C)]
#[derive(Default)]
struct AdvancedColorInfo2 {
    header: DISPLAYCONFIG_DEVICE_INFO_HEADER,
    value: u32,
    color_encoding: i32,
    bits_per_color_channel: u32,
    /// 0 SDR、1 WCG（自动色彩管理）、2 HDR。
    active_color_mode: i32,
}
const GET_ADVANCED_COLOR_INFO_2: i32 = 15;

/// 当前接着的每台显示器。查询失败时为空。
pub fn display_colours() -> Vec<DisplayColour> {
    let (mut paths_len, mut modes_len) = (0u32, 0u32);
    // SAFETY：两个计数是本地变量。
    let status = unsafe {
        GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut paths_len, &mut modes_len)
    };
    if status != 0 {
        return Vec::new();
    }
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); paths_len as usize];
    let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); modes_len as usize];
    // SAFETY：两个数组的长度与传入的计数一致；只取活动路径时拓扑参数须为空。
    let status = unsafe {
        QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut paths_len,
            paths.as_mut_ptr(),
            &mut modes_len,
            modes.as_mut_ptr(),
            ptr::null_mut(),
        )
    };
    if status != 0 {
        return Vec::new();
    }
    paths.truncate(paths_len as usize);
    paths.iter().map(display_colour).collect()
}

fn display_colour(path: &DISPLAYCONFIG_PATH_INFO) -> DisplayColour {
    let target = |kind: i32, size: usize| DISPLAYCONFIG_DEVICE_INFO_HEADER {
        r#type: kind,
        size: size as u32,
        adapterId: path.targetInfo.adapterId,
        id: path.targetInfo.id,
    };
    let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
        header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
            r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
            size: std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
            adapterId: path.sourceInfo.adapterId,
            id: path.sourceInfo.id,
        },
        ..Default::default()
    };
    // SAFETY：每个请求包都是本地结构，`header.size` 等于结构大小，系统只写这么多。
    let gdi_name = if unsafe { DisplayConfigGetDeviceInfo(&mut source.header) } == 0 {
        from_wide(&source.viewGdiDeviceName)
    } else {
        String::new()
    };
    let mut name = DISPLAYCONFIG_TARGET_DEVICE_NAME {
        header: target(
            DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
            std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>(),
        ),
        ..Default::default()
    };
    // SAFETY：同上。
    let friendly_name = if unsafe { DisplayConfigGetDeviceInfo(&mut name.header) } == 0 {
        from_wide(&name.monitorFriendlyDeviceName)
    } else {
        String::new()
    };

    let mut info2 = AdvancedColorInfo2 {
        header: target(
            GET_ADVANCED_COLOR_INFO_2,
            std::mem::size_of::<AdvancedColorInfo2>(),
        ),
        ..Default::default()
    };
    // SAFETY：同上；旧系统不认识这个类型，只会返回错误码。
    let (mode, bits) = if unsafe { DisplayConfigGetDeviceInfo(&mut info2.header) } == 0 {
        let mode = match info2.active_color_mode {
            0 => DisplayColourMode::Sdr,
            1 => DisplayColourMode::AutoColourManagement,
            2 => DisplayColourMode::Hdr,
            _ => DisplayColourMode::Unknown,
        };
        (mode, Some(info2.bits_per_color_channel))
    } else {
        let mut info = DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO {
            header: target(
                DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
                std::mem::size_of::<DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO>(),
            ),
            ..Default::default()
        };
        // SAFETY：同上。
        if unsafe { DisplayConfigGetDeviceInfo(&mut info.header) } == 0 {
            // SAFETY：联合体两种解释都是同一个 u32。
            let value = unsafe { info.Anonymous.value };
            // 位 1：已开启高级颜色；位 2：强制广色域（SDR 上的自动色彩管理）。
            let (enabled, wide_enforced) = (value & 0b10 != 0, value & 0b100 != 0);
            let mode = match (enabled, wide_enforced) {
                (true, true) => DisplayColourMode::AutoColourManagement,
                (true, false) => DisplayColourMode::Hdr,
                _ => DisplayColourMode::Sdr,
            };
            (mode, Some(info.bitsPerColorChannel))
        } else {
            (DisplayColourMode::Unknown, None)
        }
    };
    DisplayColour {
        gdi_name,
        friendly_name,
        mode,
        bits_per_channel: bits,
    }
}
