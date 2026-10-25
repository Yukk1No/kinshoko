//! 钉图的显存与私有内存（#282）：`cargo run --release -p pin-render --example memory`。
//!
//! 按显示尺寸上传常见尺寸的钉图（默认 1000×1500），依次量只建设备、1 张、5 张、10 张、全部释放、
//! 再来一轮 10 张，再对照一张整张上传的 24 MP 图。私有内存是进程的私有提交，显存是本进程在第一块显卡本地段上的
//! 占用（DXGI），另记 wgpu 分配器报告的已分配与已向驱动申请的字节。只在 Windows 上有。
#![allow(unsafe_code)]

#[cfg(not(windows))]
fn main() {
    eprintln!("只在 Windows 上测。");
}

#[cfg(windows)]
fn main() {
    use pin_render::{Pixels, Renderer};

    let args: Vec<String> = std::env::args().collect();
    let (w, h) = args
        .get(1)
        .and_then(|s| s.split_once('x'))
        .and_then(|(a, b)| Some((a.parse().ok()?, b.parse().ok()?)))
        .unwrap_or((1000u32, 1500u32));
    let fallback = args.iter().any(|a| a == "--fallback");

    println!("| 场景 | 私有内存 MB | 本进程显存 MB | wgpu 已分配 MB | wgpu 已申请 MB |");
    println!("|---|---|---|---|---|");
    let row = |label: &str, r: Option<&Renderer>| {
        let (alloc, reserved) = r
            .and_then(Renderer::memory)
            .map_or((f64::NAN, f64::NAN), |m| (mb(m.allocated), mb(m.reserved)));
        println!(
            "| {label} | {:.0} | {:.0} | {alloc:.0} | {reserved:.0} |",
            sys::private_mb(),
            sys::vram_mb()
        );
    };
    row("没有设备", None);
    let r = if fallback {
        Renderer::new_fallback()
    } else {
        Renderer::new()
    }
    .expect("要有 GPU 适配器");
    eprintln!("适配器：{}", r.describe());
    r.wait_idle();
    row("只建设备", Some(&r));

    // 像照片一样各处不同的像素（内容不影响占用，只免得驱动对全零页做特殊处理）。
    let pixels = |w: u32, h: u32| -> Vec<u16> {
        (0..w as usize * h as usize * 4)
            .map(|i| 0x3000 + (i as u16 % 0x0800))
            .collect()
    };
    let common = pixels(w, h);
    let mut pins = Vec::new();
    for target in [1usize, 5, 10] {
        while pins.len() < target {
            pins.push(
                r.upload(Pixels {
                    width: w,
                    height: h,
                    rgba: &common,
                })
                .unwrap(),
            );
        }
        r.wait_idle();
        row(&format!("{target} 张 {w}×{h}"), Some(&r));
    }
    std::thread::sleep(std::time::Duration::from_secs(2));
    r.wait_idle();
    row("10 张，静置 2 秒后", Some(&r));
    pins.clear();
    r.wait_idle();
    row("全部释放", Some(&r));
    // 再来一轮：私有内存若是驱动留着复用的上传内存，这一轮不再涨。
    for _ in 0..10 {
        pins.push(
            r.upload(Pixels {
                width: w,
                height: h,
                rgba: &common,
            })
            .unwrap(),
        );
    }
    r.wait_idle();
    row(&format!("再上传 10 张 {w}×{h}"), Some(&r));
    pins.clear();
    r.wait_idle();
    row("再全部释放", Some(&r));
    drop(common);

    let big = pixels(6000, 4000);
    let image = r
        .upload(Pixels {
            width: 6000,
            height: 4000,
            rgba: &big,
        })
        .unwrap();
    drop(big);
    r.wait_idle();
    row("1 张 24 MP 整张（对照）", Some(&r));
    drop(image);
    r.wait_idle();
    row("释放 24 MP", Some(&r));
    drop(r);
    row("释放设备", None);
}

fn mb(bytes: u64) -> f64 {
    bytes as f64 / 1_048_576.0
}

#[cfg(windows)]
mod sys {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory2, DXGI_CREATE_FACTORY_FLAGS, DXGI_MEMORY_SEGMENT_GROUP_LOCAL,
        DXGI_QUERY_VIDEO_MEMORY_INFO, IDXGIAdapter3, IDXGIFactory4,
    };
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX};
    use windows::Win32::System::Threading::GetCurrentProcess;
    use windows::core::Interface;

    /// 进程私有提交（MB）。
    pub fn private_mb() -> f64 {
        let mut c = PROCESS_MEMORY_COUNTERS_EX {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            ..Default::default()
        };
        // SAFETY: 传入本进程伪句柄与大小正确的结构。
        unsafe {
            let _ = GetProcessMemoryInfo(GetCurrentProcess(), &mut c as *mut _ as *mut _, c.cb);
        }
        c.PrivateUsage as f64 / 1_048_576.0
    }

    /// 本进程在第一块显卡本地段上的显存占用（MB）。
    pub fn vram_mb() -> f64 {
        // SAFETY: 只调用 DXGI 的查询接口，结构由我们分配。
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
            info.CurrentUsage as f64 / 1_048_576.0
        }
    }
}
