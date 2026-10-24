//! 诊断日志（#70）：只读系统信息，不写任何东西。

use std::ptr;

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

pub(super) fn wide(s: &str) -> Vec<u16> {
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
