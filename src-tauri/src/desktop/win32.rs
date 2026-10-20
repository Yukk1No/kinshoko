//! 直接调用的 Windows 接口：显示器当前使用的颜色配置文件（ICC，#62）；前台窗口、交还焦点与
//! 光标位置（贴边隐藏，#63）；一次调用同时改窗口的位置与尺寸（#64）与钉图层的窗口区域（#193）；诊断日志用的系统版本、
//! 处理器、内存、显卡与显示器色彩模式（#70）；冻结截图时盖在参考图上的窗口（含 DWM 云化与
//! 分层透明度，#125）；还没有窗口时的启动错误提示（#145）。
//!
//! 这些信息只有 Win32 函数提供，没有安全的 Rust 封装，所以本模块是应用壳里唯一允许
//! `unsafe` 的地方。每处调用都只传本函数自己持有的缓冲区，句柄在同一函数内创建并释放
//! （测试窗口由守卫在离开作用域时释放）。
#![allow(unsafe_code)]

use std::path::PathBuf;
use std::ptr;

use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows_sys::Win32::Graphics::Gdi::{
    CombineRgn, CreateDCW, CreateRectRgn, DeleteDC, DeleteObject, GetWindowRgnBox, NULLREGION,
    RGN_ERROR, RGN_OR, SetWindowRgn,
};
use windows_sys::Win32::UI::ColorSystem::GetICMProfileW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GW_HWNDNEXT, GWL_EXSTYLE, GetCursorPos, GetForegroundWindow, GetLayeredWindowAttributes,
    GetTopWindow, GetWindow, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsIconic,
    IsWindow, IsWindowVisible, LWA_ALPHA, MB_ICONERROR, MB_OK, MessageBoxW, SWP_NOACTIVATE,
    SWP_NOOWNERZORDER, SWP_NOZORDER, SetForegroundWindow, SetWindowPos, WS_EX_LAYERED,
};

/// 启动失败、还没有任何窗口时的错误提示（#145：数据文件夹不可写）。
pub fn show_error(title: &str, text: &str) {
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (title, text) = (wide(title), wide(text));
    // SAFETY：两个以 0 结尾的 UTF-16 缓冲区在调用期间由本函数持有；没有父窗口。
    unsafe {
        MessageBoxW(
            ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

/// 冻结截图时位于目标上方的窗口矩形。半透明或异形窗口也保守地算遮挡，避免误连来源；
/// 只有确定不画任何东西的窗口不算（#125，见 [`draws_nothing`]）。设了窗口区域的窗口（钉图铺满
/// 显示器、区域只盖住钉图本身，#193）按区域的外接矩形算，区域为空的不算。
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
        if unsafe { IsWindowVisible(window) != 0 && IsIconic(window) == 0 }
            && !draws_nothing(window)
        {
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
            let mut region: RECT = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            // SAFETY：同上；没有窗口区域时返回 ERROR，rect 不变。
            match unsafe { GetWindowRgnBox(window, &mut region) } {
                RGN_ERROR => {}
                NULLREGION => rect = region,
                _ => {
                    rect = RECT {
                        left: rect.left + region.left,
                        top: rect.top + region.top,
                        right: rect.left + region.right,
                        bottom: rect.top + region.bottom,
                    }
                }
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

/// “可见”却不画任何东西的窗口：被 DWM 云化，或整窗透明度为 0 的分层窗口。
/// Raycast 等启动器常驻这样一个置顶、鼠标穿透的窗口；鼠标穿透本身不算（穿透的钉图仍然画着）。
fn draws_nothing(window: HWND) -> bool {
    let mut cloaked: u32 = 0;
    // SAFETY：系统返回的借用句柄；输出缓冲区是本函数持有的 u32。
    let hr = unsafe {
        DwmGetWindowAttribute(
            window,
            DWMWA_CLOAKED as u32,
            (&mut cloaked as *mut u32).cast(),
            size_of::<u32>() as u32,
        )
    };
    if hr == 0 && cloaked != 0 {
        return true;
    }
    // SAFETY：同上，只读取窗口样式。
    if unsafe { GetWindowLongW(window, GWL_EXSTYLE) } as u32 & WS_EX_LAYERED == 0 {
        return false;
    }
    let (mut key, mut alpha, mut flags) = (0, 0, 0);
    // SAFETY：同上；三个输出都是本函数持有的变量。逐像素透明的分层窗口在这里返回失败，保守算遮挡。
    let ok = unsafe { GetLayeredWindowAttributes(window, &mut key, &mut alpha, &mut flags) };
    ok != 0 && flags & LWA_ALPHA != 0 && alpha == 0
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

/// 系统的双击间隔（毫秒）与双击判定矩形的宽、高（物理像素，以第一下为中心，#179）。读不到时为 `None`。
pub fn double_click() -> Option<(u32, i32, i32)> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXDOUBLECLK, SM_CYDOUBLECLK,
    };
    // SAFETY：三个调用都无指针参数，只读取系统设置。
    let (interval, width, height) = unsafe {
        (
            GetDoubleClickTime(),
            GetSystemMetrics(SM_CXDOUBLECLK),
            GetSystemMetrics(SM_CYDOUBLECLK),
        )
    };
    (interval > 0 && width > 0 && height > 0).then_some((interval, width, height))
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

/// 窗口区域：这些矩形的并集（相对窗口左上角的左、上、右、下，物理像素），只在区域里显示、接点击
/// （钉图层，#193）。没有矩形时什么都不显示、不接点击。窗口已经不在时返回 false。
pub fn set_window_region(hwnd: isize, rects: &[(i32, i32, i32, i32)]) -> bool {
    let hwnd = hwnd as HWND;
    // SAFETY：IsWindow 接受任意值；已销毁的句柄只会让它返回 0。
    if unsafe { IsWindow(hwnd) } == 0 {
        return false;
    }
    // SAFETY：只传值；失败时返回空句柄。
    let region = unsafe { CreateRectRgn(0, 0, 0, 0) };
    if region.is_null() {
        return false;
    }
    for &(l, t, r, b) in rects {
        // SAFETY：只传值；`part` 合并后在这里释放，`region` 由本函数持有。
        unsafe {
            let part = CreateRectRgn(l, t, r, b);
            if !part.is_null() {
                CombineRgn(region, region, part, RGN_OR);
                DeleteObject(part);
            }
        }
    }
    // SAFETY：`hwnd` 刚确认有效；成功后区域归系统所有，失败时由这里释放。
    let ok = unsafe { SetWindowRgn(hwnd, region, 1) } != 0;
    if !ok {
        // SAFETY：上面创建、没有交给系统的区域，只释放一次。
        unsafe { DeleteObject(region) };
    }
    ok
}

/// 把置顶窗口提到置顶窗口的最上面，不激活、不改位置和尺寸。新钉图进了一个已有的钉图层时用：
/// 别的程序启动时可能盖到了这个层上面（#193）。窗口已经不在时返回 false。
pub fn raise_topmost(hwnd: isize) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE};
    let hwnd = hwnd as HWND;
    // SAFETY：IsWindow 接受任意值；已销毁的句柄只会让它返回 0。
    if unsafe { IsWindow(hwnd) } == 0 {
        return false;
    }
    let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
    // SAFETY：`hwnd` 刚确认是有效窗口；其余参数都是值。
    unsafe { SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags) != 0 }
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

#[cfg(test)]
mod tests {
    use super::*;
    use kinshoko_core::desktop::{
        CaptureSelection, CaptureSurface, OriginalPixels, Placement, Region, SavedPin, ScreenRect,
        Screenshot,
    };
    use kinshoko_core::library::ReferenceImage;
    use windows_sys::Win32::Graphics::Dwm::{DWMWA_CLOAK, DwmSetWindowAttribute};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, SW_SHOWNOACTIVATE, SetLayeredWindowAttributes, ShowWindow,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
    };

    /// 测试用的顶层窗口，离开作用域时销毁。
    struct Window(HWND);
    impl Window {
        fn new(rect: ScreenRect, ex_style: u32) -> Self {
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            // SAFETY：系统内置的 STATIC 窗口类；参数都是本函数持有的值。
            let hwnd = unsafe {
                CreateWindowExW(
                    ex_style | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                    class.as_ptr(),
                    ptr::null(),
                    WS_POPUP,
                    rect.x,
                    rect.y,
                    rect.width as i32,
                    rect.height as i32,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null(),
                )
            };
            assert!(!hwnd.is_null(), "创建测试窗口失败");
            Self(hwnd)
        }
        fn show(self) -> Self {
            // SAFETY：句柄由本测试创建，尚未销毁。
            unsafe { ShowWindow(self.0, SW_SHOWNOACTIVATE) };
            self
        }
    }
    impl Drop for Window {
        fn drop(&mut self) {
            // SAFETY：句柄由本测试创建，只销毁一次。
            unsafe { DestroyWindow(self.0) };
        }
    }

    fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    /// #125：Raycast 之类的启动器常驻一个“可见”、置顶、鼠标穿透、整窗透明度为 0 的窗口，
    /// 云化（cloaked）的窗口同样不画任何东西。它们不能把下面的参考图算成被遮住，
    /// 否则选区完全落在图内也只读屏幕像素。真正画在上面的窗口仍算遮挡。
    #[test]
    fn windows_that_draw_nothing_do_not_cover_the_reference() {
        // 本机验收的几何：110% 缩放、窗口最大化，1117×701 的图按原始像素显示在 (722, 374)。
        let shown = rect(722, 374, 1117, 701);
        let main = Window::new(shown, 0).show();
        // 桌面上别的窗口（通知、其他程序）随时可能出现在上面；只比较本测试自己加上去的窗口。
        let before = covering_windows(main.0 as isize).expect("Z 序可遍历");
        let invisible = Window::new(shown, WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT);
        // SAFETY：句柄由本测试创建。
        assert_ne!(
            unsafe { SetLayeredWindowAttributes(invisible.0, 0, 0, LWA_ALPHA) },
            0
        );
        let invisible = invisible.show();
        let cloaked = Window::new(shown, WS_EX_TOPMOST);
        let cloak: i32 = 1;
        // SAFETY：句柄由本测试创建；值是本函数持有的 BOOL。
        let hr = unsafe {
            DwmSetWindowAttribute(
                cloaked.0,
                DWMWA_CLOAK as u32,
                (&cloak as *const i32).cast(),
                size_of::<i32>() as u32,
            )
        };
        assert_eq!(hr, 0, "云化测试窗口失败");
        let cloaked = cloaked.show();
        let corner = rect(722, 374, 40, 30);
        let opaque = Window::new(corner, WS_EX_TOPMOST).show();
        // #193：钉图层铺满显示器，窗口区域只盖住钉图本身。按区域算遮挡，不按外框；
        // 区域为空（什么都不显示）的不算。
        let pinned = rect(1800, 1000, 30, 20);
        let big = Window::new(rect(0, 0, 2560, 1440), WS_EX_TOPMOST);
        assert!(set_window_region(
            big.0 as isize,
            &[(1800, 1000, 1830, 1020)]
        ));
        let big = big.show();
        let empty = Window::new(rect(0, 0, 2560, 1440), WS_EX_TOPMOST);
        assert!(set_window_region(empty.0 as isize, &[]));
        let empty = empty.show();

        let mut covered = covering_windows(main.0 as isize).expect("Z 序可遍历");
        for r in &before {
            if let Some(i) = covered.iter().position(|c| c == r) {
                covered.remove(i);
            }
        }
        // 不画任何东西的窗口不算遮挡，真正画在上面的窗口仍算；有窗口区域的按区域算。
        assert_eq!(covered, vec![pinned, corner]);

        let image = ReferenceImage {
            id: "a".into(),
            width: 1117,
            height: 701,
            sealed: false,
        };
        let surfaces = [CaptureSurface {
            pin: SavedPin::reference("a", "library", &image, None, Placement::default()).unwrap(),
            shown,
            visible: shown,
            covered,
        }];
        let screen = Screenshot {
            image: image::RgbaImage::new(1, 1),
            icc: None,
        };
        let readout = |region: Region| {
            CaptureSelection {
                screen: &screen,
                origin: (0, 0),
                region,
                references: &surfaces,
            }
            .original_pixels()
        };
        // 图中央约 100×80 CSS px 的选区（111×89 物理像素）：原始像素。
        let inside = Region {
            x: 1225,
            y: 680,
            width: 111,
            height: 89,
        };
        assert_eq!(
            readout(inside),
            Some(OriginalPixels {
                width: 111,
                height: 89
            })
        );
        // 跨出图片左缘：屏幕像素。
        let crossing = Region {
            x: 672,
            y: 680,
            width: 111,
            height: 89,
        };
        assert_eq!(readout(crossing), None);
        drop((empty, big, opaque, cloaked, invisible));
    }
}
