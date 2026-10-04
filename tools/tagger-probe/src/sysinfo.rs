//! Hardware description and process memory sampling (Windows).

use serde::Serialize;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

#[derive(Serialize, Default)]
pub struct Adapter {
    pub name: String,
    pub dedicated_vram_bytes: u64,
    pub shared_bytes: u64,
    pub vendor_id: u32,
}

#[derive(Serialize, Default)]
pub struct Hardware {
    pub os: String,
    pub cpu: String,
    pub logical_cores: usize,
    pub ram_bytes: u64,
    pub adapters: Vec<Adapter>,
    pub displays: Vec<String>,
}

fn powershell(cmd: &str) -> String {
    Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &format!("[Console]::OutputEncoding=[Text.Encoding]::UTF8; {cmd}")])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

pub fn hardware() -> Hardware {
    Hardware {
        os: powershell("$o=Get-CimInstance Win32_OperatingSystem; \"$($o.Caption) $($o.Version)\""),
        cpu: powershell("(Get-CimInstance Win32_Processor | Select-Object -First 1).Name"),
        logical_cores: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        ram_bytes: powershell("(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory").parse().unwrap_or(0),
        adapters: adapters(),
        // Resolution and scale help interpret display-related results later; no identifiers.
        displays: powershell(
            "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { \"$($_.Bounds.Width)x$($_.Bounds.Height)\" }",
        )
        .lines()
        .map(str::to_string)
        .collect(),
    }
}

#[cfg(windows)]
fn adapters() -> Vec<Adapter> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
    let mut out = Vec::new();
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else { return out };
        let mut i = 0;
        while let Ok(a) = factory.EnumAdapters1(i) {
            i += 1;
            let Ok(d) = a.GetDesc1() else { continue };
            if d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }
            let len = d.Description.iter().position(|&c| c == 0).unwrap_or(d.Description.len());
            let name = String::from_utf16_lossy(&d.Description[..len]);
            // The same adapter can be enumerated more than once (e.g. per output).
            if out.iter().any(|a: &Adapter| a.name == name && a.dedicated_vram_bytes == d.DedicatedVideoMemory as u64) {
                continue;
            }
            out.push(Adapter {
                name,
                dedicated_vram_bytes: d.DedicatedVideoMemory as u64,
                shared_bytes: d.SharedSystemMemory as u64,
                vendor_id: d.VendorId,
            });
        }
    }
    out
}

#[cfg(not(windows))]
fn adapters() -> Vec<Adapter> {
    Vec::new()
}

/// Current working set of this process.
#[cfg(windows)]
pub fn working_set() -> u64 {
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let mut c = PROCESS_MEMORY_COUNTERS::default();
        let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        if GetProcessMemoryInfo(GetCurrentProcess(), &mut c, size).is_ok() {
            c.WorkingSetSize as u64
        } else {
            0
        }
    }
}

#[cfg(not(windows))]
pub fn working_set() -> u64 {
    0
}

/// Local (dedicated) video memory used by this process, summed over adapters.
#[cfg(windows)]
pub fn vram_usage() -> u64 {
    use windows::core::Interface;
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter3, IDXGIFactory1, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO};
    let mut total = 0;
    let mut seen = Vec::new();
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else { return 0 };
        let mut i = 0;
        while let Ok(a) = factory.EnumAdapters1(i) {
            i += 1;
            // The same adapter can be enumerated more than once; count each LUID once.
            if let Ok(d) = a.GetDesc1() {
                let luid = (d.AdapterLuid.HighPart, d.AdapterLuid.LowPart);
                if seen.contains(&luid) {
                    continue;
                }
                seen.push(luid);
            }
            if let Ok(a3) = a.cast::<IDXGIAdapter3>() {
                let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
                if a3.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info).is_ok() {
                    total += info.CurrentUsage;
                }
            }
        }
    }
    total
}

#[cfg(not(windows))]
pub fn vram_usage() -> u64 {
    0
}

/// Samples peak working set and VRAM in the background until stopped.
pub struct PeakSampler {
    stop: Arc<AtomicBool>,
    ram: Arc<AtomicU64>,
    vram: Arc<AtomicU64>,
    handle: Option<JoinHandle<()>>,
}

impl PeakSampler {
    pub fn start() -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let ram = Arc::new(AtomicU64::new(working_set()));
        let vram = Arc::new(AtomicU64::new(vram_usage()));
        let (s, r, v) = (stop.clone(), ram.clone(), vram.clone());
        let handle = std::thread::spawn(move || {
            while !s.load(Ordering::Relaxed) {
                r.fetch_max(working_set(), Ordering::Relaxed);
                v.fetch_max(vram_usage(), Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(200));
            }
        });
        Self { stop, ram, vram, handle: Some(handle) }
    }

    /// Returns (peak working set, peak VRAM) in bytes.
    pub fn finish(mut self) -> (u64, u64) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        (self.ram.load(Ordering::Relaxed), self.vram.load(Ordering::Relaxed))
    }
}

#[cfg(windows)]
pub fn utf8_console() {
    unsafe {
        let _ = windows::Win32::System::Console::SetConsoleOutputCP(65001);
    }
}

#[cfg(not(windows))]
pub fn utf8_console() {}
