//! 本机的显卡与内存（Windows DXGI），移植自 `tools/tagger-probe`。

#![allow(unsafe_code)]

/// 专用显存至少这么多才算独立显卡；集成显卡通常只报告几百 MB。
const DISCRETE_MIN_VRAM: u64 = 1 << 30;

/// 一块独立显卡。
#[derive(Debug, Clone)]
pub struct Gpu {
    /// DXGI 枚举序号，也是 DirectML 的设备号。
    pub index: u32,
    pub name: String,
    /// 系统当前允许本进程使用的显存额度。
    pub budget: u64,
    /// 本进程正在使用的显存。
    pub usage: u64,
}

/// 第一块独立显卡；没有时为空。
#[cfg(windows)]
pub fn discrete_gpu() -> Option<Gpu> {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_MEMORY_SEGMENT_GROUP_LOCAL,
        DXGI_QUERY_VIDEO_MEMORY_INFO, IDXGIAdapter3, IDXGIFactory1,
    };
    use windows::core::Interface;
    // SAFETY: 只调用 DXGI 的查询接口，参数都是本函数里的局部变量。
    unsafe {
        let factory = CreateDXGIFactory1::<IDXGIFactory1>().ok()?;
        let mut i = 0;
        while let Ok(adapter) = factory.EnumAdapters1(i) {
            let index = i;
            i += 1;
            let Ok(desc) = adapter.GetDesc1() else {
                continue;
            };
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0
                || (desc.DedicatedVideoMemory as u64) < DISCRETE_MIN_VRAM
            {
                continue;
            }
            let len = desc
                .Description
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(desc.Description.len());
            let mut gpu = Gpu {
                index,
                name: String::from_utf16_lossy(&desc.Description[..len]),
                budget: desc.DedicatedVideoMemory as u64,
                usage: 0,
            };
            if let Ok(a3) = adapter.cast::<IDXGIAdapter3>() {
                let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
                if a3
                    .QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info)
                    .is_ok()
                {
                    gpu.budget = info.Budget;
                    gpu.usage = info.CurrentUsage;
                }
            }
            return Some(gpu);
        }
    }
    None
}

#[cfg(not(windows))]
pub fn discrete_gpu() -> Option<Gpu> {
    None
}

/// 整个系统当前可用的物理内存。
#[cfg(windows)]
pub fn available_ram() -> u64 {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut m = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    // SAFETY: `m` 是按要求设好 `dwLength` 的局部结构。
    if unsafe { GlobalMemoryStatusEx(&mut m) }.is_ok() {
        m.ullAvailPhys
    } else {
        0
    }
}

#[cfg(not(windows))]
pub fn available_ram() -> u64 {
    0
}
