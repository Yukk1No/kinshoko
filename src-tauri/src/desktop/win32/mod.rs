//! 直接调用的 Windows 接口：显示器当前使用的颜色配置文件（ICC，#62）；前台窗口、交还焦点与
//! 光标位置（贴边隐藏，#63）；一次调用同时改窗口的位置与尺寸（#64）；诊断日志用的系统版本、
//! 处理器、内存、显卡与显示器色彩模式（#70）；冻结截图时盖在参考图上的窗口（含 DWM 云化与
//! 分层透明度，#125）；还没有窗口时的启动错误提示（#145）；关掉钉图菜单窗口的系统显示、隐藏过渡（#194），把它标成工具窗口（#275）。
//!
//! 这些信息只有 Win32 函数提供，没有安全的 Rust 封装，所以本模块是应用壳里唯一允许
//! `unsafe` 的地方。每处调用都只传本函数自己持有的缓冲区，句柄在同一函数内创建并释放
//! （测试窗口由守卫在离开作用域时释放）。
#![allow(unsafe_code)]

mod system;
#[cfg(test)]
mod tests;

pub use system::*;

use std::path::PathBuf;
use std::ptr;

use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Dwm::{
    DWMWA_CLOAKED, DWMWA_TRANSITIONS_FORCEDISABLED, DwmGetWindowAttribute, DwmSetWindowAttribute,
};
use windows_sys::Win32::Graphics::Gdi::{
    CreateDCW, CreateRectRgn, DeleteDC, DeleteObject, GetRegionData, GetWindowRgn, RGN_ERROR,
    RGNDATAHEADER,
};
use windows_sys::Win32::UI::ColorSystem::GetICMProfileW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GW_HWNDNEXT, GWL_EXSTYLE, GetCursorPos, GetForegroundWindow, GetLayeredWindowAttributes,
    GetTopWindow, GetWindow, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsIconic,
    IsWindow, IsWindowVisible, LWA_ALPHA, MB_ICONERROR, MB_OK, MessageBoxW, SWP_NOACTIVATE,
    SWP_NOOWNERZORDER, SWP_NOZORDER, SetForegroundWindow, SetWindowLongW, SetWindowPos,
    WS_EX_LAYERED, WS_EX_TOOLWINDOW,
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
/// 显示器、区域只盖住钉图本身，#193）按区域里的各个矩形算（钉图之间的空隙不算），区域为空的不算。
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
            let parts = match window_region(window) {
                Some(parts) => parts
                    .into_iter()
                    .map(|r| RECT {
                        left: rect.left + r.left,
                        top: rect.top + r.top,
                        right: rect.left + r.right,
                        bottom: rect.top + r.bottom,
                    })
                    .collect(),
                None => vec![rect],
            };
            for r in parts {
                if r.right > r.left && r.bottom > r.top {
                    covered.push(kinshoko_core::desktop::ScreenRect {
                        x: r.left,
                        y: r.top,
                        width: r.right.abs_diff(r.left),
                        height: r.bottom.abs_diff(r.top),
                    });
                }
            }
        }
        // SAFETY：只查询下一借用句柄；seen 与数量上限保证窗口变化时也会终止。
        window = unsafe { GetWindow(window, GW_HWNDNEXT) };
    }
    None
}

/// 窗口区域里的矩形（相对窗口左上角）；区域为空时没有矩形。没有设窗口区域、或读不出区域时为
/// `None`，调用方保守地按整个窗口算。
fn window_region(window: HWND) -> Option<Vec<RECT>> {
    // SAFETY：只传值；失败时返回空句柄。
    let region = unsafe { CreateRectRgn(0, 0, 0, 0) };
    if region.is_null() {
        return None;
    }
    // SAFETY：`region` 由本函数持有；没有窗口区域时返回 ERROR。
    let rects = if unsafe { GetWindowRgn(window, region) } == RGN_ERROR {
        None
    } else {
        region_rects(region)
    };
    // SAFETY：上面创建的区域，只释放一次。
    unsafe { DeleteObject(region) };
    rects
}

/// 区域由哪些矩形组成；读不出来时为 `None`。
fn region_rects(region: windows_sys::Win32::Graphics::Gdi::HRGN) -> Option<Vec<RECT>> {
    // SAFETY：缓冲区为空时只返回需要的字节数。
    let size = unsafe { GetRegionData(region, 0, ptr::null_mut()) };
    let header = size_of::<RGNDATAHEADER>();
    if (size as usize) < header {
        return None;
    }
    // 按 u32 对齐的缓冲区，放得下 RGNDATAHEADER 与其后的 RECT 数组。
    let mut buffer = vec![0u32; (size as usize).div_ceil(4)];
    // SAFETY：缓冲区由本函数持有，至少 `size` 字节。
    if unsafe { GetRegionData(region, size, buffer.as_mut_ptr().cast()) } != size {
        return None;
    }
    // SAFETY：GetRegionData 写入了完整的头；按 u32 对齐满足 RGNDATAHEADER 的对齐。
    let head = unsafe { ptr::read(buffer.as_ptr().cast::<RGNDATAHEADER>()) };
    let count = (head.nCount as usize).min((size as usize - header) / size_of::<RECT>());
    // SAFETY：头之后紧跟 `count` 个 RECT，都在缓冲区以内；RECT 只要求 4 字节对齐。
    unsafe {
        let first = buffer.as_ptr().cast::<u8>().add(header).cast::<RECT>();
        Some((0..count).map(|i| ptr::read(first.add(i))).collect())
    }
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

/// 关掉 DWM 给窗口显示与隐藏加的系统过渡（#194）。无边框窗口仍带标题栏样式，系统会在显示时从中间
/// 放大、隐藏时边缩小边淡出；铺满显示器的菜单窗口隐藏时，菜单因此看上去向左滑走。
pub fn disable_transitions(hwnd: isize) -> bool {
    let hwnd = hwnd as HWND;
    // SAFETY：IsWindow 接受任意值；已销毁的句柄只会让它返回 0。
    if unsafe { IsWindow(hwnd) } == 0 {
        return false;
    }
    let disabled: i32 = 1;
    // SAFETY：`hwnd` 刚确认是有效窗口；值是本函数持有的 BOOL。
    let hr = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED as u32,
            (&disabled as *const i32).cast(),
            size_of::<i32>() as u32,
        )
    };
    hr == 0
}

/// 标成工具窗口（#275）：Chromium 的遮挡判定跳过工具窗口。铺满显示器的透明菜单窗口不是工具窗口时，
/// 窗口区域是一个矩形就按整个窗口算不透明，背后的 Edge、Electron 程序与 Kinshoko 主窗口被判成挡住、停止绘制。
/// 工具窗口也不出现在 Alt+Tab 里。窗口已经不在时返回 false。
pub fn make_tool_window(hwnd: isize) -> bool {
    let hwnd = hwnd as HWND;
    // SAFETY：IsWindow 接受任意值；已销毁的句柄只会让它返回 0。
    if unsafe { IsWindow(hwnd) } == 0 {
        return false;
    }
    // SAFETY：`hwnd` 刚确认是有效窗口；只改扩展样式里的一位。
    unsafe {
        let style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        SetWindowLongW(hwnd, GWL_EXSTYLE, (style | WS_EX_TOOLWINDOW) as i32);
        GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW != 0
    }
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
