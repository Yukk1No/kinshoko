//! 丢弃型原型：每张钉图一个原生分层窗口（`UpdateLayeredWindow`），不用 WebView 画。
//!
//! 用法：
//!   native-pin-probe <图片>...                  钉出每张图
//!   native-pin-probe --count 8 <图片>           同一张图钉 8 份（量内存）
//!   native-pin-probe --selftest 报告.txt [--verify] <图片>
//!                                               自动跑缩放、旋转、动画、拖动并记录耗时；
//!                                               `--verify` 同时用桌面复制逐帧核对（需要 marker.png）
//!   native-pin-probe --gen <目录>               生成测试图
//!   native-pin-probe --info                     显示器、配置文件、色彩模式、QUNS
//! 选项：--no-icc 不做显示器颜色管理；--full-screen-ok 不让出最下面一行；--menu-foreground
//!
//! 钉图上：滚轮以光标为中心缩放（每格 10%）、左键拖动、右键占位菜单；光标在钉图上时
//! H 水平翻转、V 垂直翻转、R 顺时针转 90°、C 切换裁切、T 点击穿透、[ ] 透明度、
//! N 放大时按像素、A 动画、1 回到 100%、Esc 关掉这张钉图（全关后退出）。

mod actions;
mod dcomp;
mod measure;
mod options;
mod present;
mod probes;
mod raster;
mod selftest;
mod source;
mod verify;
mod win;

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fmt::Write as _;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
};
use windows::Win32::UI::WindowsAndMessaging::*;

use measure::qpc;
use raster::{Quality, Rasterizer, Rect, View};
use source::Source;

use options::*;
use probes::*;
use selftest::*;
use win::*;

/// 停手多久后换成精缩（与查看器的 120 ms 相同，ADR 0005）。
const SETTLE_MS: u32 = 120;

#[derive(Debug, Clone, Copy)]
enum Ev {
    Wheel {
        pin: usize,
        delta: i16,
        x: i32,
        y: i32,
        t: i64,
    },
    Down {
        pin: usize,
        x: i32,
        y: i32,
    },
    Drag {
        x: i32,
        y: i32,
        t: i64,
    },
    Up,
    Menu {
        pin: usize,
        x: i32,
        y: i32,
    },
    Key {
        pin: usize,
        vk: u32,
        t: i64,
    },
    Settle {
        pin: usize,
    },
}

thread_local! {
    static EVENTS: RefCell<VecDeque<Ev>> = const { RefCell::new(VecDeque::new()) };
    /// 每张钉图窗口此刻的屏幕矩形，键盘钩子判断光标在不在钉图上用。
    static RECTS: RefCell<Vec<(usize, Rect, HWND)>> = const { RefCell::new(Vec::new()) };
    /// 菜单开着时键盘钩子不拦键（Esc 等交给菜单或前台程序）。
    /// 自测每次上屏的明细（CSV），写在报告旁边。
    static CSV: RefCell<String> = const { RefCell::new(String::new()) };
    static MENU_OPEN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn push(ev: Ev) {
    EVENTS.with(|e| e.borrow_mut().push_back(ev));
}

struct Dib {
    hdc: HDC,
    bmp: HBITMAP,
    old: HGDIOBJ,
    bits: *mut u8,
    w: i32,
    h: i32,
}

impl Dib {
    fn new(w: i32, h: i32) -> Dib {
        unsafe {
            let hdc = CreateCompatibleDC(None);
            let mut bi = BITMAPINFO::default();
            bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bi.bmiHeader.biWidth = w;
            bi.bmiHeader.biHeight = -h; // 自上而下
            bi.bmiHeader.biPlanes = 1;
            bi.bmiHeader.biBitCount = 32;
            let mut bits = std::ptr::null_mut();
            let bmp = CreateDIBSection(Some(hdc), &bi, DIB_RGB_COLORS, &mut bits, None, 0)
                .expect("CreateDIBSection");
            let old = SelectObject(hdc, bmp.into());
            Dib {
                hdc,
                bmp,
                old,
                bits: bits as *mut u8,
                w,
                h,
            }
        }
    }
    fn pixels(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.bits, (self.w * self.h * 4) as usize) }
    }
}

impl Drop for Dib {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.hdc, self.old);
            let _ = DeleteObject(self.bmp.into());
            let _ = DeleteDC(self.hdc);
        }
    }
}

struct Pin {
    hwnd: HWND,
    src: Rc<Source>,
    view: View,
    /// 内容（旋转后）左上角的屏幕坐标，物理像素。保留小数，缩放来回不漂移。
    origin: (f64, f64),
    opacity: u8,
    click_through: bool,
    /// 窗口此刻的屏幕矩形（可能被裁到屏幕里）。
    shown: Rect,
    /// 窗口完整的矩形（未裁）。
    full: Rect,
    dib: Option<Dib>,
    gpu: Option<dcomp::GpuPin>,
    rendered_quality: Option<Quality>,
    nearest: bool,
    closed: bool,
}

/// 一次上屏的记录。
#[derive(Debug, Clone)]
struct Present {
    reason: &'static str,
    quality: Quality,
    level: usize,
    size: (i32, i32),
    render_us: u64,
    resample_us: u64,
    blit_us: u64,
    shadow_us: u64,
    ulw_us: u64,
    /// 输入到 ULW 返回（毫秒）；脚本触发的为 None。
    input_ms: Option<f64>,
    /// ULW 返回后到下一次垂直同步的时间（毫秒），估计值。
    to_vblank_ms: Option<f64>,
    cached: bool,
}

struct App {
    pins: Vec<Pin>,
    raster: Rasterizer,
    screen_dc: HDC,
    drag: Option<(usize, f64, f64)>,
    presents: Vec<Present>,
    no_fullscreen: bool,
    menu_foreground: bool,
    verify_log: Option<Arc<Mutex<Vec<verify::Submitted>>>>,
    monitors: Vec<measure::Monitor>,
    /// `--backend dcomp` 时的 GPU 设备；`move_first` 为先改窗口再 Present。
    gpu: Option<dcomp::Gpu>,
    move_first: bool,
}

fn virtual_screen() -> Rect {
    unsafe {
        Rect {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            w: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            h: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

fn main() {
    let o = match parse() {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    if let Some(n) = o.threads {
        rayon::ThreadPoolBuilder::new()
            .num_threads(n)
            .build_global()
            .expect("线程池");
    }
    let monitors = measure::monitors();
    let primary = monitors
        .iter()
        .find(|m| m.rect.x == 0 && m.rect.y == 0)
        .unwrap_or(&monitors[0])
        .clone();
    let display_icc = if o.icc {
        primary.icc.as_ref().and_then(|p| std::fs::read(p).ok())
    } else {
        None
    };
    let mut log = String::new();
    let _ = writeln!(
        log,
        "显示器 {} {}×{} {} Hz DPI {} 色彩模式 {} 配置文件 {:?}（颜色管理 {}）",
        primary.device,
        primary.rect.w,
        primary.rect.h,
        primary.refresh_hz,
        primary.dpi,
        primary.colour_mode,
        primary.icc,
        if display_icc.is_some() { "开" } else { "关" }
    );
    let (mem0, _) = measure::process_memory();

    let mut sources = Vec::new();
    // 每张钉图各读一份（与正式方案相同，不共用像素），--count 量的才是每张的真实代价。
    for path in o.images.iter().cycle().take(o.images.len() * o.count) {
        match source::load(path, display_icc.as_deref()) {
            Ok(s) => {
                let _ = writeln!(
                    log,
                    "读图 {}：{}；源图常驻 {:.1} MB",
                    path.display(),
                    s.report,
                    s.bytes() as f64 / 1048576.0
                );
                sources.push(Rc::new(s));
            }
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
    }
    print!("{log}");

    let mut app = App {
        pins: Vec::new(),
        raster: {
            let mut r = Rasterizer::new();
            r.gesture_interp = o.gesture_interp;
            r.oversample = o.oversample;
            r
        },
        screen_dc: unsafe { GetDC(None) },
        drag: None,
        presents: Vec::new(),
        no_fullscreen: o.no_fullscreen,
        menu_foreground: o.menu_foreground,
        verify_log: None,
        monitors: monitors.clone(),
        gpu: if o.dcomp {
            Some(dcomp::Gpu::new().expect("建不出 D3D/D2D/DComp 设备"))
        } else {
            None
        },
        move_first: o.move_first,
    };
    let vram0 = app.gpu.as_ref().map(|g| g.vram());
    let work = primary.work;
    let total = sources.len();
    for n in 0..total {
        let src = sources[n % sources.len()].clone();
        // 初始高度为工作区的 60%（多张时缩小并排开）。
        let fraction = if total == 1 { 0.6 } else { 0.35 };
        let scale = (work.h as f64 * fraction / src.height() as f64)
            .min(work.w as f64 * fraction / src.width() as f64);
        let scale = o.scale.unwrap_or(scale);
        let view = View {
            scale,
            rotation: 0,
            flip_h: false,
            flip_v: false,
            crop: None,
        };
        let (dw, dh) = view.display_size(&src);
        let col = n % 5;
        let row = n / 5;
        let origin = if total == 1 {
            (
                (work.x + (work.w - dw) / 2) as f64,
                (work.y + (work.h - dh) / 2) as f64,
            )
        } else {
            (
                (work.x + 40 + col as i32 * (dw + 30)) as f64,
                (work.y + 40 + row as i32 * (dh / 2 + 30)) as f64,
            )
        };
        let hwnd = create_window(n, o.dcomp);
        let gpu = app
            .gpu
            .as_ref()
            .map(|g| g.pin(hwnd, &src).expect("建不出交换链"));
        app.pins.push(Pin {
            hwnd,
            src,
            view,
            origin,
            opacity: 255,
            click_through: false,
            shown: Rect::default(),
            full: Rect::default(),
            dib: None,
            gpu,
            rendered_quality: None,
            nearest: false,
            closed: false,
        });
    }

    let verifier = if o.verify && o.selftest.is_some() {
        let log = Arc::new(Mutex::new(Vec::new()));
        app.verify_log = Some(log.clone());
        Some(verify::start(log, primary.rect))
    } else {
        None
    };

    for i in 0..app.pins.len() {
        app.present(i, Quality::Settled, "open", None);
    }
    if let (Some(g), Some(v0)) = (app.gpu.as_ref(), vram0) {
        println!(
            "DComp：本进程显存 {:.1} MB（钉图前 {:.1} MB）",
            g.vram() as f64 / 1048576.0,
            v0 as f64 / 1048576.0
        );
    }
    let (mem1, ws1) = measure::process_memory();
    println!(
        "钉出 {} 张：进程私有内存 {:.1} MB（钉图前 {:.1} MB），工作集 {:.1} MB；SHQueryUserNotificationState = {}",
        app.pins.len(),
        mem1 as f64 / 1048576.0,
        mem0 as f64 / 1048576.0,
        ws1 as f64 / 1048576.0,
        measure::quns()
    );

    let hook = unsafe {
        SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(keyboard_hook),
            Some(GetModuleHandleW(None).unwrap().into()),
            0,
        )
        .ok()
    };

    if o.input_test {
        println!("{}", input_test(&mut app));
    } else if let Some(report) = &o.selftest {
        let text = selftest(&mut app, verifier);
        std::fs::write(report, &text).expect("写报告");
        CSV.with(|c| {
            std::fs::write(report.with_extension("csv"), c.borrow().as_bytes()).expect("写明细")
        });
        println!("{text}");
    } else {
        let deadline = o
            .hold_ms
            .map(|h| qpc() + (h as f64 * measure::qpf() as f64 / 1000.0) as i64);
        run(&mut app, deadline);
        let mut lat: Vec<f64> = app
            .presents
            .iter()
            .filter(|p| p.reason == "wheel")
            .filter_map(|p| p.input_ms)
            .collect();
        println!("{}", measure::summary("滚轮 输入→ULW 返回 (ms)", &mut lat));
        let mut r: Vec<f64> = app
            .presents
            .iter()
            .filter(|p| p.reason == "wheel")
            .map(|p| p.render_us as f64 / 1e3)
            .collect();
        println!("{}", measure::summary("滚轮 画一帧 (ms)", &mut r));
        let mut d: Vec<f64> = app
            .presents
            .iter()
            .filter(|p| p.reason == "drag")
            .filter_map(|p| p.input_ms)
            .collect();
        println!("{}", measure::summary("拖动 输入→ULW 返回 (ms)", &mut d));
    }
    if let Some(h) = hook {
        unsafe {
            let _ = UnhookWindowsHookEx(h);
        }
    }
}
