//! 丢弃型原型：每张钉图一个原生窗口，wgpu 画，几何变化只在看不见的备用窗口上做。
//! 结论见 `docs/discovery/pin-gpu-design.md`。

mod geom;
mod gpu;
mod shell;
mod sys;
mod verify;
mod app;
mod modes;
mod selftest;

use app::frame;
use modes::{hold, input_test};
use selftest::selftest;

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use geom::{PIN_EDGE, Rect, Step, View, needed, plan};
use shell::{Input, Shell, WinShell};
use windows::Win32::Graphics::Dwm::DwmFlush;
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
};

/// 停手多久算手势结束（与现有钉图、ADR 0005 的 120 ms 相同）。
const SETTLE_MS: f64 = 120.0;

#[derive(Default, Clone)]
struct Options {
    images: Vec<PathBuf>,
    gen_dir: Option<PathBuf>,
    selftest: Option<PathBuf>,
    verify: bool,
    /// 对照组：只有一个窗口，每帧 SetWindowPos 改尺寸再 Present（或反过来）。
    naive: bool,
    present_first: bool,
    count: usize,
    hold_ms: Option<u64>,
    fill: bool,
    full_screen_ok: bool,
    info: bool,
    input_test: bool,
    scale: Option<f64>,
}

fn parse() -> Result<Options, String> {
    let mut o = Options {
        count: 1,
        ..Default::default()
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--gen" => o.gen_dir = Some(args.next().ok_or("--gen 要目录")?.into()),
            "--selftest" => o.selftest = Some(args.next().ok_or("--selftest 要报告路径")?.into()),
            "--verify" => o.verify = true,
            "--naive" => o.naive = true,
            "--present-first" => o.present_first = true,
            "--count" => o.count = args.next().ok_or("--count 要数字")?.parse().map_err(|_| "--count")?,
            "--hold" => o.hold_ms = Some(args.next().ok_or("--hold 要毫秒")?.parse().map_err(|_| "--hold")?),
            "--fill" => o.fill = true,
            "--full-screen-ok" => o.full_screen_ok = true,
            "--info" => o.info = true,
            "--input-test" => o.input_test = true,
            "--scale" => o.scale = Some(args.next().ok_or("--scale 要数字")?.parse().map_err(|_| "--scale")?),
            s if s.starts_with("--") => return Err(format!("不认识的选项 {s}")),
            s => o.images.push(s.into()),
        }
    }
    Ok(o)
}

/// 逐帧核对用的测试图：品红边框（短边的 5%），里面绿色棋盘。
fn generate(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (w, h) = (4000u32, 6000u32);
    let border = w.min(h) / 20;
    let img = image::RgbaImage::from_fn(w, h, |x, y| {
        if x < border || y < border || x >= w - border || y >= h - border {
            image::Rgba([255, 0, 255, 255])
        } else if ((x / 250) + (y / 250)) % 2 == 0 {
            image::Rgba([30, 160, 60, 255])
        } else {
            image::Rgba([200, 230, 200, 255])
        }
    });
    let path = dir.join("marker.png");
    img.save(&path).map_err(|e| e.to_string())?;
    println!("写好 {}", path.display());
    Ok(())
}

#[derive(Debug, Clone)]
struct Record {
    phase: &'static str,
    step: &'static str,
    window_px: i64,
    /// 从开始处理到 Present 返回（含改交换链、换窗口的等待）。
    total: f64,
    configure: f64,
    acquire: f64,
    submit: f64,
    wait: f64,
    /// Present 返回之后再等 GPU 做完（只在测量时）。
    gpu_done: f64,
}

struct Pin {
    view: View,
    image: gpu::Image,
    surfaces: [gpu::Surface; 2],
    window: Rect,
    drawn: Rect,
    gesture_until: Option<i64>,
    drag: Option<(i32, i32, f64, f64)>,
    shown: bool,
}

struct App {
    gpu: gpu::Gpu,
    shell: WinShell,
    pins: Vec<Pin>,
    monitor: Rect,
    clip: Rect,
    opts: Options,
    log: Arc<Mutex<Vec<verify::Submitted>>>,
    records: Vec<Record>,
    phase: &'static str,
    measure_gpu: bool,
}

fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let opts = parse()?;
    if let Some(dir) = &opts.gen_dir {
        return generate(dir);
    }
    if opts.info {
        let (m, dpi) = sys::primary_monitor();
        println!("主显示器 {m:?}，DPI {dpi}，刷新 {:.2} ms，QUNS {}", sys::refresh_ms(), sys::quns());
        let mem = (sys::private_mb(), sys::vram_mb());
        let gpu = gpu::Gpu::new()?;
        println!("{}；建设备前 私有 {:.0} MB、显存 {:.0} MB；之后 私有 {:.0} MB、显存 {:.0} MB",
            gpu.describe(), mem.0, mem.1, sys::private_mb(), sys::vram_mb());
        return Ok(());
    }
    if opts.images.is_empty() {
        return Err("用法见 README".into());
    }
    let mut app = App::new(opts.clone())?;
    let before = (sys::private_mb(), sys::vram_mb());
    for path in &opts.images {
        for k in 0..opts.count {
            let n = app.pins.len();
            app.add_pin(path, n + k * 0)?;
        }
    }
    println!(
        "设备与 {} 张钉图：私有 {:.0} → {:.0} MB，显存 {:.0} → {:.0} MB",
        app.pins.len(),
        before.0,
        sys::private_mb(),
        before.1,
        sys::vram_mb()
    );
    if let Some(report) = opts.selftest.clone() {
        return selftest(&mut app, &report);
    }
    if let Some(ms) = opts.hold_ms {
        return hold(&mut app, ms);
    }
    if opts.input_test {
        return input_test(&mut app);
    }
    // 手动试：滚轮缩放、左键拖动、右键关掉；全关后退出。
    while app.pins.iter().any(|p| p.shown) {
        app.tick()?;
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    let _ = PIN_EDGE;
    Ok(())
}
