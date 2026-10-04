//! Hardware description and process memory sampling (Windows).

use serde::Serialize;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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

/// This process's memory: (working set, committed private bytes).
#[cfg(windows)]
pub fn process_memory() -> (u64, u64) {
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let mut c = PROCESS_MEMORY_COUNTERS::default();
        let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        if GetProcessMemoryInfo(GetCurrentProcess(), &mut c, size).is_ok() {
            (c.WorkingSetSize as u64, c.PagefileUsage as u64)
        } else {
            (0, 0)
        }
    }
}

#[cfg(not(windows))]
pub fn process_memory() -> (u64, u64) {
    (0, 0)
}

/// Physical memory currently available to the whole system.
#[cfg(windows)]
pub fn available_ram() -> u64 {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    unsafe {
        let mut m = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        if GlobalMemoryStatusEx(&mut m).is_ok() {
            m.ullAvailPhys
        } else {
            0
        }
    }
}

#[cfg(not(windows))]
pub fn available_ram() -> u64 {
    0
}

/// One hardware adapter's memory as seen by this process.
#[derive(Serialize, Default, Clone)]
pub struct GpuMemory {
    pub name: String,
    /// Dedicated VRAM this process uses.
    pub local_usage: u64,
    /// How much dedicated VRAM the OS currently lets this process use.
    pub local_budget: u64,
    /// Shared system memory this process uses through the adapter; it grows when VRAM overflows.
    pub non_local_usage: u64,
}

/// Memory per hardware adapter, in DXGI enumeration order (DirectML's device 0 first).
#[cfg(windows)]
pub fn gpu_memory() -> Vec<GpuMemory> {
    use windows::core::Interface;
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter3, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_MEMORY_SEGMENT_GROUP_LOCAL,
        DXGI_MEMORY_SEGMENT_GROUP_NON_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO,
    };
    let mut out = Vec::new();
    let mut seen = Vec::new();
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else { return out };
        let mut i = 0;
        while let Ok(a) = factory.EnumAdapters1(i) {
            i += 1;
            let Ok(d) = a.GetDesc1() else { continue };
            let len = d.Description.iter().position(|&c| c == 0).unwrap_or(d.Description.len());
            let name = String::from_utf16_lossy(&d.Description[..len]);
            // The same GPU can be enumerated more than once, even under different LUIDs, and
            // each entry reports the same per-process usage; keep the first.
            let key = (name.clone(), d.DedicatedVideoMemory);
            if d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 || seen.contains(&key) {
                continue;
            }
            seen.push(key);
            let mut m = GpuMemory { name, ..Default::default() };
            if let Ok(a3) = a.cast::<IDXGIAdapter3>() {
                let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
                if a3.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info).is_ok() {
                    m.local_usage = info.CurrentUsage;
                    m.local_budget = info.Budget;
                }
                if a3.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_NON_LOCAL, &mut info).is_ok() {
                    m.non_local_usage = info.CurrentUsage;
                }
            }
            out.push(m);
        }
    }
    out
}

#[cfg(not(windows))]
pub fn gpu_memory() -> Vec<GpuMemory> {
    Vec::new()
}

/// Peaks observed while a run was going.
#[derive(Serialize, Default, Clone)]
pub struct Peaks {
    pub working_set: u64,
    /// Committed private memory: what actually has to fit in RAM plus page file.
    pub commit: u64,
    pub min_available_ram: u64,
    /// Per adapter: peak dedicated and shared usage, and the smallest budget seen.
    pub gpus: Vec<GpuMemory>,
}

impl Peaks {
    fn update(&mut self) {
        let (ws, commit) = process_memory();
        self.working_set = self.working_set.max(ws);
        self.commit = self.commit.max(commit);
        let avail = available_ram();
        self.min_available_ram = if self.min_available_ram == 0 { avail } else { self.min_available_ram.min(avail) };
        for g in gpu_memory() {
            match self.gpus.iter_mut().find(|p| p.name == g.name) {
                Some(p) => {
                    p.local_usage = p.local_usage.max(g.local_usage);
                    p.non_local_usage = p.non_local_usage.max(g.non_local_usage);
                    p.local_budget = p.local_budget.min(g.local_budget);
                }
                None => self.gpus.push(g),
            }
        }
    }
}

/// Samples peak memory in the background until stopped.
pub struct PeakSampler {
    stop: Arc<AtomicBool>,
    peaks: Arc<Mutex<Peaks>>,
    handle: Option<JoinHandle<()>>,
}

impl PeakSampler {
    pub fn start() -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let peaks = Arc::new(Mutex::new(Peaks::default()));
        peaks.lock().unwrap().update();
        let (s, p) = (stop.clone(), peaks.clone());
        let handle = std::thread::spawn(move || {
            while !s.load(Ordering::Relaxed) {
                p.lock().unwrap().update();
                std::thread::sleep(Duration::from_millis(200));
            }
        });
        Self { stop, peaks, handle: Some(handle) }
    }

    /// Peaks so far, without stopping.
    pub fn current(&self) -> Peaks {
        self.peaks.lock().unwrap().clone()
    }

    pub fn finish(mut self) -> Peaks {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        let mut p = self.peaks.lock().unwrap().clone();
        p.update();
        p
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
