//! `--app`：核对真实应用里的原生钉图（#284）。工具不画钉图：把测试图放进剪贴板、按 F3 让应用钉住，
//! 用真实鼠标滚轮缩放、拖动，最后按 Esc 关掉。应用在环境变量 `KINSHOKO_PIN_TRACE` 指的文件里每次
//! 提交前追加一行（时间、钉图、内容矩形、窗口、缩放、透明度），这里边读边交给逐帧核对。
//!
//! 会动真实鼠标键盘、改剪贴板，先确认没人在用电脑。应用要用 `nativePins` 打开的测试实例。

use std::fmt::Write as _;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::GlobalFree;
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTOPRIMARY, MONITORINFO, MonitorFromPoint,
};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_WHEEL,
};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowW, GetForegroundWindow, GetWindowRect, PostMessageW, WM_CLOSE,
};
use windows::core::w;

use crate::input::{cursor, key, mouse, send};
use crate::rect::Rect;
use crate::sys::next_frame;
use crate::verify::{self, Submitted};

pub struct Follow {
    pub trace: PathBuf,
    pub report: PathBuf,
}

/// 测试图：品红边框为短边的 5%，里面绿色棋盘（与 `app::marker` 同一个样子，尺寸小些，100% 钉住
/// 时放得下）。
const SIZE: (u32, u32) = (400, 600);
const VK_F3: u8 = 0x72;
const VK_ESCAPE: u8 = 0x1b;
const VK_F4: u8 = 0x73;

fn border(scale: f64) -> f64 {
    f64::from(SIZE.0.min(SIZE.1) / 20) * scale
}

/// 测试图的 RGBA 像素：品红边框为短边的 5%，里面绿色棋盘。
fn marker() -> Vec<u8> {
    let (w, h) = SIZE;
    let b = w.min(h) / 20;
    let mut px = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let edge = x < b || y < b || x >= w - b || y >= h - b;
            px.extend_from_slice(&if edge {
                [255, 0, 255, 255]
            } else if ((x / 25) + (y / 25)) % 2 == 0 {
                [30, 160, 60, 255]
            } else {
                [200, 230, 200, 255]
            });
        }
    }
    px
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in bytes {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// 不压缩的 PNG（zlib 存储块），RGBA8，不带色彩块（按 sRGB）。
fn png(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity(rgba.len() + h as usize);
    for row in rgba.chunks_exact(w as usize * 4) {
        raw.push(0);
        raw.extend_from_slice(row);
    }
    let mut z = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65535).collect();
    for (i, block) in blocks.iter().enumerate() {
        z.push(u8::from(i + 1 == blocks.len()));
        let n = block.len() as u16;
        z.extend_from_slice(&n.to_le_bytes());
        z.extend_from_slice(&(!n).to_le_bytes());
        z.extend_from_slice(block);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for &v in &raw {
        a = (a + u32::from(v)) % 65521;
        b = (b + a) % 65521;
    }
    z.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut chunk = |kind: &[u8; 4], data: &[u8]| {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc32(&body).to_be_bytes());
    };
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(b"IHDR", &ihdr);
    chunk(b"IDAT", &z);
    chunk(b"IEND", &[]);
    out
}

/// 把测试图以“PNG”格式放进剪贴板（应用的 arboard 先认这个格式；它读 CF_DIBV5 的 BI_BITFIELDS 位图会失败）。
fn clipboard_marker() -> Result<(), String> {
    let bytes = png(SIZE.0, SIZE.1, &marker());
    unsafe {
        let format = RegisterClipboardFormatW(w!("PNG"));
        OpenClipboard(None).map_err(|e| format!("打不开剪贴板：{e}"))?;
        let result = (|| {
            EmptyClipboard().map_err(|e| e.to_string())?;
            let mem = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|e| e.to_string())?;
            let p = GlobalLock(mem);
            if p.is_null() {
                let _ = GlobalFree(Some(mem));
                return Err("锁不住剪贴板内存".to_owned());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p.cast::<u8>(), bytes.len());
            let _ = GlobalUnlock(mem);
            // 交给剪贴板之后内存归它；没交出去才自己放掉。
            if let Err(e) = SetClipboardData(format, Some(HANDLE(mem.0))) {
                let _ = GlobalFree(Some(mem));
                return Err(e.to_string());
            }
            Ok::<(), String>(())
        })();
        let _ = CloseClipboard();
        result
    }
}

fn primary_monitor() -> Rect {
    unsafe {
        let m = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let _ = GetMonitorInfoW(m, &mut info);
        let r = info.rcMonitor;
        Rect::new(r.left, r.top, r.right - r.left, r.bottom - r.top)
    }
}

/// 一行提交记录：时间 钉图 内容(x y w h) 窗口(x y w h) 缩放 透明度。
fn parse(line: &str, monitor: Rect) -> Option<Submitted> {
    let v: Vec<f64> = line
        .split_whitespace()
        .map(|t| t.parse().ok())
        .collect::<Option<_>>()?;
    let [_, _, cx, cy, cw, ch, wx, wy, ww, wh, scale, opacity] = v[..] else {
        return None;
    };
    let c = Rect::new(cx as i32, cy as i32, cw as i32, ch as i32);
    let w = Rect::new(wx as i32, wy as i32, ww as i32, wh as i32);
    let border = border(scale);
    let visible = |r: Rect| {
        r.intersect(&w)
            .and_then(|r| r.intersect(&monitor))
            .is_some_and(|r| r.w >= 3 && r.h >= 3)
    };
    let b = border.ceil() as i32;
    let opaque = opacity >= 1.0;
    Some(Submitted {
        content: c,
        window: w,
        border,
        translucent: !opaque,
        border_visible: opaque
            && (visible(Rect::new(c.x, c.y, b, c.h)) || visible(Rect::new(c.x, c.y, c.w, b))),
        // 一个源图像素放大后的宽度。
        slack: scale.max(1.0),
    })
}

/// 边读边把新提交交给核对。不睡：Windows 默认的定时精度是 15 ms，赶不上合成。
fn tail(
    path: PathBuf,
    from: u64,
    monitor: Rect,
    log: Arc<Mutex<Vec<Submitted>>>,
    stop: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        // 应用第一次提交时才建这个文件。
        let mut file = loop {
            if let Ok(f) = std::fs::File::open(&path) {
                break f;
            }
            if stop.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let _ = file.seek(SeekFrom::Start(from));
        let mut pending = String::new();
        let mut buf = [0u8; 4096];
        while !stop.load(Ordering::SeqCst) {
            match file.read(&mut buf) {
                Ok(0) | Err(_) => std::thread::yield_now(),
                Ok(n) => {
                    pending.push_str(&String::from_utf8_lossy(&buf[..n]));
                    while let Some(i) = pending.find('\n') {
                        let line: String = pending.drain(..=i).collect();
                        if let Some(s) = parse(line.trim(), monitor) {
                            log.lock().unwrap().push(s);
                        }
                    }
                }
            }
        }
    })
}

fn wheel(notches: i32) {
    send(&[mouse(MOUSEEVENTF_WHEEL, notches * 120)]);
}

fn frames(n: u32) {
    for _ in 0..n {
        next_frame();
    }
}

fn last(log: &Arc<Mutex<Vec<Submitted>>>) -> Option<Submitted> {
    log.lock().unwrap().last().copied()
}

fn centre(r: Rect) -> (i32, i32) {
    (r.x + r.w / 2, r.y + r.h / 2)
}

/// 拖动：按下、每帧挪一步、松开。
fn drag(from: (i32, i32), steps: &[(i32, i32)]) {
    cursor(from.0, from.1);
    send(&[mouse(MOUSEEVENTF_LEFTDOWN, 0)]);
    next_frame();
    let mut at = from;
    for &(dx, dy) in steps {
        at = (at.0 + dx, at.1 + dy);
        cursor(at.0, at.1);
        next_frame();
    }
    send(&[mouse(MOUSEEVENTF_LEFTUP, 0)]);
}

/// 起一个收键窗口（本程序的 `--key-sink` 子进程）并像画师那样点一下，让它成为前台。
fn front_sink() -> Result<(Child, HWND), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let sink = Command::new(exe)
        .args(["--key-sink", "300"])
        .stdout(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(1500));
    let hwnd = unsafe { FindWindowW(w!("KinshokoKeySink"), None) }.map_err(|e| e.to_string())?;
    let mut r = RECT::default();
    unsafe {
        let _ = GetWindowRect(hwnd, &mut r);
    }
    cursor((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    send(&[mouse(MOUSEEVENTF_LEFTDOWN, 0), mouse(MOUSEEVENTF_LEFTUP, 0)]);
    std::thread::sleep(Duration::from_millis(300));
    Ok((sink, hwnd))
}

fn close_sink(sink: &mut Child, hwnd: HWND) {
    unsafe {
        let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
    }
    let _ = sink.wait();
}

pub fn follow(f: &Follow) -> Result<bool, String> {
    let monitor = primary_monitor();
    clipboard_marker()?;
    // 前台放收键窗口：钉图的操作都不该抢走它；钉图的 Esc 也只在前台不是 Kinshoko 时才拦得到（见 README）。
    let (mut sink, sink_hwnd) = front_sink()?;
    let sink_front = unsafe { GetForegroundWindow() } == sink_hwnd;
    let from = std::fs::metadata(&f.trace).map_or(0, |m| m.len());
    let log = Arc::new(Mutex::new(Vec::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let reader = tail(f.trace.clone(), from, monitor, log.clone(), stop.clone());

    cursor(monitor.x + 200, monitor.y + 150);
    key(VK_F3);
    let started = Instant::now();
    while last(&log).is_none() {
        if started.elapsed() > Duration::from_secs(15) {
            stop.store(true, Ordering::SeqCst);
            let _ = reader.join();
            close_sink(&mut sink, sink_hwnd);
            return Err(format!(
                "15 秒内 {} 里没有新的提交：应用没在跑、没开 nativePins，或没设 KINSHOKO_PIN_TRACE",
                f.trace.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    frames(30);
    let checker = verify::start(log.clone(), monitor);
    let mut phases = String::new();
    let mut phase = |name: &str, log: &Arc<Mutex<Vec<Submitted>>>| {
        let _ = writeln!(phases, "{name}：到第 {} 次提交", log.lock().unwrap().len());
    };

    // 光标放在内容里靠左上的一点：放大时它不动，钉图往右下长，最后比屏幕大。
    let c = last(&log).expect("上面等到了").content;
    let anchor = (c.x + c.w / 4, c.y + c.h / 4);
    cursor(anchor.0, anchor.1);
    frames(5);
    for _ in 0..28 {
        wheel(1);
        next_frame();
    }
    frames(20);
    for _ in 0..28 {
        wheel(-1);
        next_frame();
    }
    frames(20);
    phase("一格一帧放大到比屏幕大再缩回", &log);
    for _ in 0..8 {
        wheel(3);
        next_frame();
    }
    for _ in 0..8 {
        wheel(-3);
        next_frame();
    }
    frames(20);
    phase("每帧三格", &log);
    for k in 0..12 {
        wheel(if k < 6 { 1 } else { -1 });
        std::thread::sleep(Duration::from_millis(150));
    }
    frames(20);
    phase("隔 150 ms 一格", &log);

    let c = last(&log).expect("有提交").content;
    let grip = centre(c);
    let right: Vec<(i32, i32)> = (0..40).map(|_| (12, 4)).collect();
    let back: Vec<(i32, i32)> = (0..40).map(|_| (-12, -4)).collect();
    drag(grip, &right);
    frames(5);
    drag((grip.0 + 480, grip.1 + 160), &back);
    frames(20);
    phase("拖动", &log);
    // 拖出屏幕左边一半再拖回。
    let c = last(&log).expect("有提交").content;
    let grip = centre(c);
    let out = (c.x - monitor.x + c.w / 2) / 30 + 1;
    let left: Vec<(i32, i32)> = (0..30).map(|_| (-out, 0)).collect();
    let home: Vec<(i32, i32)> = (0..30).map(|_| (out, 0)).collect();
    drag(grip, &left);
    frames(5);
    drag((grip.0 - out * 30, grip.1), &home);
    frames(20);
    phase("拖出屏幕一半再拖回", &log);

    // 拖角缩放：按住内容右下角往外拖再拖回，每帧一步，带缩放动画（#285）。
    let c = last(&log).expect("有提交").content;
    let corner = (c.x + c.w - 4, c.y + c.h - 4);
    let grow: Vec<(i32, i32)> = (0..30).map(|_| (8, 12)).collect();
    let shrink: Vec<(i32, i32)> = (0..30).map(|_| (-8, -12)).collect();
    drag(corner, &grow);
    frames(5);
    drag((corner.0 + 240, corner.1 + 360), &shrink);
    frames(30);
    phase("拖角放大再缩回", &log);

    // 贴边隐藏：F4 收到最近的屏幕边，指针碰细边滑出、离开收回，再按 F4 回原位（#285）。
    let home = last(&log).expect("有提交").content;
    cursor(monitor.x + monitor.w / 2, monitor.y + monitor.h / 2);
    frames(3);
    key(VK_F4);
    frames(40);
    let tucked = last(&log).expect("有提交").content;
    let sliver = (
        tucked.x.max(monitor.x),
        tucked.y.max(monitor.y),
        (tucked.x + tucked.w).min(monitor.x + monitor.w),
        (tucked.y + tucked.h).min(monitor.y + monitor.h),
    );
    cursor((sliver.0 + sliver.2) / 2, (sliver.1 + sliver.3) / 2);
    frames(40);
    cursor(monitor.x + monitor.w / 2, monitor.y + monitor.h / 2);
    frames(40);
    key(VK_F4);
    frames(40);
    let back = last(&log).expect("有提交").content;
    phase(
        &format!(
            "F4 收起、碰细边滑出、离开收回、F4 回原位（贴边前 {home:?}，收起 {tucked:?}，回来 {back:?}）"
        ),
        &log,
    );

    let verdict = checker.finish();
    let kept_front = sink_front && unsafe { GetForegroundWindow() } == sink_hwnd;
    // 收尾：光标放回钉图上按 Esc 关掉。
    if let Some(s) = last(&log) {
        let (x, y) = centre(s.content);
        cursor(x, y);
        frames(3);
        key(VK_ESCAPE);
    }
    frames(10);
    stop.store(true, Ordering::SeqCst);
    let _ = reader.join();
    close_sink(&mut sink, sink_hwnd);

    let ok = verdict.bad == 0 && verdict.checked > 0 && verdict.matched > 0 && kept_front;
    let report = format!(
        "原生钉图逐帧核对（应用，--app）\n显示器 {monitor:?}\n{phases}\n{}\n前台始终是收键窗口（开始时是：{sink_front}）：{}\n结论：{}\n",
        verdict.text,
        if kept_front { "通过" } else { "不通过" },
        if ok { "通过" } else { "不通过" }
    );
    write(&f.report, &report)?;
    print!("{report}");
    Ok(ok)
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    std::fs::write(path, text).map_err(|e| format!("写不了报告 {}：{e}", path.display()))
}
