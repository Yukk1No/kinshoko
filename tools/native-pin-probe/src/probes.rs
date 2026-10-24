//! 不走消息循环自测的两种测量：与应用管线比画质（`--compare`）、真实输入（`--input-test`）。

#![allow(unused_imports)]

use std::fmt::Write as _;
use std::sync::{Arc, Mutex};

use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Dwm::DwmFlush;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{PCWSTR, w};

use crate::measure::{self, ms, qpc};
use crate::raster::{Crop, PIN_EDGE, Quality, Rasterizer, Rect, View};
use crate::*;

/// 缩到同一宽度，逐像素比较 8 位值。不做显示器颜色管理（两边都是 sRGB）。
pub(crate) fn compare(width: u32, path: &std::path::Path) -> Result<String, String> {
    use kinshoko_core::fidelity::{DEFAULT_DOWNSCALE, render_sdr};
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let t = std::time::Instant::now();
    let reference = render_sdr(&bytes, width, DEFAULT_DOWNSCALE)?;
    let core_ms = t.elapsed().as_secs_f64() * 1e3;
    let reference = image::load_from_memory(&reference.bytes)
        .map_err(|e| e.to_string())?
        .into_rgba8();
    let (rw, rh) = reference.dimensions();
    let src = source::load(path, None)?;
    let scale = rw as f64 / src.width() as f64;
    let view = View {
        scale,
        rotation: 0,
        flip_h: false,
        flip_v: false,
        crop: None,
    };
    let (cw, ch) = view.content_size(&src);
    let mut out = String::new();
    let _ = writeln!(
        out,
        "应用管线 render_sdr：{rw}×{rh}，{core_ms:.0} ms（含解码、编码）；原型内容 {cw}×{ch}"
    );
    for (name, q, oversample) in [
        ("手势帧（金字塔＋三角滤波）", Quality::Gesture, 2.0),
        ("停手帧（≥2 倍层＋线性光 Lanczos3）", Quality::Settled, 2.0),
        (
            "停手帧（第 0 层＋线性光 Lanczos3）",
            Quality::Settled,
            f64::INFINITY,
        ),
    ] {
        let mut r = Rasterizer::new();
        r.oversample = oversample;
        let w = cw + 2 * PIN_EDGE;
        let h = ch + 2 * PIN_EDGE;
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let t = std::time::Instant::now();
        r.render(
            &src,
            &view,
            q,
            Rect { x: 0, y: 0, w, h },
            &mut buf,
            w as usize * 4,
        );
        let ms_ = t.elapsed().as_secs_f64() * 1e3;
        let mut diffs = Vec::with_capacity((rw * rh * 3) as usize);
        for y in 0..rh.min(ch as u32) {
            for x in 0..rw.min(cw as u32) {
                let p = (((y as i32 + PIN_EDGE) * w + x as i32 + PIN_EDGE) * 4) as usize;
                let q = reference.get_pixel(x, y).0;
                // 原型是 BGRA。
                for (a, b) in [(buf[p + 2], q[0]), (buf[p + 1], q[1]), (buf[p], q[2])] {
                    diffs.push((a as i32 - b as i32).unsigned_abs());
                }
            }
        }
        diffs.sort_unstable();
        let mean = diffs.iter().map(|&d| d as f64).sum::<f64>() / diffs.len() as f64;
        let at = |p: f64| diffs[((diffs.len() - 1) as f64 * p) as usize];
        let _ = writeln!(
            out,
            "{name}：{ms_:.1} ms；与应用管线差（8 位）均值 {mean:.2}，p99 {}，p99.9 {}，最大 {}",
            at(0.99),
            at(0.999),
            diffs[diffs.len() - 1]
        );
    }
    Ok(out)
}

/// 真实输入测试（`--input-test`，会动真实鼠标键盘，先征得维护者同意）：前台先放一个别的程序
/// （例如记事本，代替绘画软件），然后用 SendInput 在钉图上拖动、滚轮、按 R、右键、切点击穿透，
/// 每步之后看前台窗口有没有变。结束时把光标放回原处。
pub(crate) fn input_test(app: &mut App) -> String {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    let mut out = String::new();
    let send = |inputs: &[INPUT]| unsafe {
        SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
    };
    let mouse = |flags: MOUSE_EVENT_FLAGS, data: i32| INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let key = |vk: u16, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    KEYBD_EVENT_FLAGS(0)
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let fg = || unsafe { GetForegroundWindow() };
    let name = |h: HWND| {
        let mut buf = [0u16; 128];
        let n = unsafe { GetClassNameW(h, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    };
    let wait = |app: &mut App, ms_: i64| pump_until(app, qpc() + measure::qpf() * ms_ / 1000);
    let mut saved = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut saved);
    }
    let start_fg = fg();
    let _ = writeln!(
        out,
        "开始时前台窗口：{}（{:?}）",
        name(start_fg),
        start_fg.0
    );
    let pin = app.pins[0].hwnd;
    let centre = |app: &App| {
        let r = app.pins[0].shown;
        (r.x + r.w / 2, r.y + r.h / 2)
    };
    let check = |out: &mut String, what: &str| {
        let now = fg();
        let _ = writeln!(
            out,
            "{what}：前台 {}（{}）",
            name(now),
            if now == start_fg {
                "没变"
            } else {
                "变了！"
            }
        );
    };

    // 1. 拖动 60 像素。
    let (cx, cy) = centre(app);
    let o0 = app.pins[0].origin;
    unsafe {
        let _ = SetCursorPos(cx, cy);
    }
    wait(app, 50);
    send(&[mouse(MOUSEEVENTF_LEFTDOWN, 0)]);
    wait(app, 30);
    for k in 1..=12 {
        unsafe {
            let _ = SetCursorPos(cx + k * 5, cy);
        }
        send(&[mouse(MOUSEEVENTF_MOVE, 0)]);
        wait(app, 8);
    }
    send(&[mouse(MOUSEEVENTF_LEFTUP, 0)]);
    wait(app, 50);
    let o1 = app.pins[0].origin;
    let _ = writeln!(
        out,
        "拖动：钉图挪了 ({:.0}, {:.0}) 像素",
        o1.0 - o0.0,
        o1.1 - o0.1
    );
    check(&mut out, "拖动后");

    // 2. 滚轮 3 格（真实输入路径的延迟）。
    let first = app.presents.len();
    let s0 = app.pins[0].view.scale;
    for _ in 0..3 {
        send(&[mouse(MOUSEEVENTF_WHEEL, 120)]);
        wait(app, 30);
    }
    wait(app, 200);
    let lat: Vec<String> = app.presents[first..]
        .iter()
        .filter(|p| p.reason == "wheel")
        .filter_map(|p| p.input_ms)
        .map(|m| format!("{m:.2}"))
        .collect();
    let _ = writeln!(
        out,
        "滚轮 3 格：缩放 {:.3} → {:.3}；wndproc 收到→ULW 返回 {} ms",
        s0,
        app.pins[0].view.scale,
        lat.join(" / ")
    );
    check(&mut out, "滚轮后");

    // 3. 光标在钉图上按 R。
    let r0 = app.pins[0].view.rotation;
    send(&[key(0x52, false), key(0x52, true)]);
    wait(app, 100);
    let _ = writeln!(
        out,
        "按 R：旋转 {} → {}（键被钉图吞掉，不进前台程序）",
        r0, app.pins[0].view.rotation
    );
    check(&mut out, "按 R 后");

    // 4. 右键菜单：另一个线程在菜单打开后看前台、按 Esc，不行再点菜单外，最后发 WM_CANCELMODE 收掉。
    let (cx, cy) = centre(app);
    unsafe {
        let _ = SetCursorPos(cx, cy);
    }
    let report = Arc::new(Mutex::new(String::new()));
    let r2 = report.clone();
    let pin_raw = pin.0 as isize;
    let fg_raw = start_fg.0 as isize;
    let helper = std::thread::spawn(move || unsafe {
        let pin = HWND(pin_raw as *mut _);
        let menu_open = || {
            FindWindowW(w!("#32768"), PCWSTR::null()).is_ok_and(|h| IsWindowVisible(h).as_bool())
        };
        std::thread::sleep(std::time::Duration::from_millis(400));
        let now = GetForegroundWindow();
        let mut r = format!(
            "菜单打开：{}；菜单期间前台 {}",
            if menu_open() { "是" } else { "否" },
            if now.0 as isize == fg_raw {
                "没变"
            } else {
                "变了"
            }
        );
        let esc = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_ESCAPE,
                        ..Default::default()
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_ESCAPE,
                        dwFlags: KEYEVENTF_KEYUP,
                        ..Default::default()
                    },
                },
            },
        ];
        SendInput(&esc, std::mem::size_of::<INPUT>() as i32);
        std::thread::sleep(std::time::Duration::from_millis(300));
        r.push_str(&format!(
            "；按 Esc 后菜单{}",
            if menu_open() {
                "还开着（Esc 进了前台程序）"
            } else {
                "关了"
            }
        ));
        if menu_open() {
            let _ = PostMessageW(Some(pin), WM_CANCELMODE, WPARAM(0), LPARAM(0));
            std::thread::sleep(std::time::Duration::from_millis(200));
            r.push_str(&format!(
                "；WM_CANCELMODE 后{}",
                if menu_open() { "还开着" } else { "关了" }
            ));
        }
        *r2.lock().unwrap() = r;
    });
    send(&[
        mouse(MOUSEEVENTF_RIGHTDOWN, 0),
        mouse(MOUSEEVENTF_RIGHTUP, 0),
    ]);
    wait(app, 1200);
    let _ = helper.join();
    let _ = writeln!(
        out,
        "右键：{}；钉图{}",
        report.lock().unwrap(),
        if app.pins[0].closed {
            "被关掉了！"
        } else {
            "还在"
        }
    );
    check(&mut out, "菜单收起后");

    // 5. 点击穿透：按 T，再看光标下是谁。
    let (cx, cy) = centre(app);
    unsafe {
        let _ = SetCursorPos(cx, cy);
    }
    let before = unsafe { WindowFromPoint(POINT { x: cx, y: cy }) };
    send(&[key(0x54, false), key(0x54, true)]);
    wait(app, 100);
    let after = unsafe { WindowFromPoint(POINT { x: cx, y: cy }) };
    let _ = writeln!(
        out,
        "点击穿透：按 T 前光标下是 {}（{}），按 T 后是 {}（{}）",
        name(before),
        if before == pin { "钉图" } else { "别的" },
        name(after),
        if after == pin {
            "钉图"
        } else {
            "别的窗口"
        }
    );
    // 穿透时 R 仍归钉图（键盘钩子按光标位置判断，不靠点击）。
    let r0 = app.pins[0].view.rotation;
    send(&[key(0x52, false), key(0x52, true)]);
    wait(app, 100);
    let _ = writeln!(
        out,
        "穿透时按 R：旋转 {} → {}",
        r0, app.pins[0].view.rotation
    );
    send(&[key(0x54, false), key(0x54, true)]);
    wait(app, 100);
    check(&mut out, "全部结束");
    unsafe {
        let _ = SetCursorPos(saved.x, saved.y);
    }
    out
}
