//! 消息循环与自测脚本（`--selftest`）。

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

/// 消息循环：先把排着的消息都处理完（同一批滚轮合成一帧），再上屏。
pub(crate) fn run(app: &mut App, deadline: Option<i64>) {
    let mut msg = MSG::default();
    loop {
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    return;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        app.drain();
        if deadline.is_some_and(|d| qpc() >= d) {
            return;
        }
        unsafe {
            MsgWaitForMultipleObjects(
                None,
                false,
                if deadline.is_some() {
                    50
                } else {
                    windows::Win32::System::Threading::INFINITE
                },
                QS_ALLINPUT,
            );
        }
    }
}

/// 处理消息直到 `until`（QPC）。
pub(crate) fn pump_until(app: &mut App, until: i64) {
    let mut msg = MSG::default();
    loop {
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        app.drain();
        let now = qpc();
        if now >= until {
            return;
        }
        let wait = ms(until - now).ceil() as u32;
        unsafe {
            MsgWaitForMultipleObjects(None, false, wait.max(1), QS_ALLINPUT);
        }
    }
}

pub(crate) fn post_wheel(app: &App, i: usize, notches: i16) {
    let pin = &app.pins[i];
    let (dw, dh) = pin.view.display_size(&pin.src);
    // 锚点在内容中心偏左上（不在中心，才看得出以光标为中心）。
    let x = (pin.origin.0 + dw as f64 * 0.4) as i32;
    let y = (pin.origin.1 + dh as f64 * 0.35) as i32;
    let lp = ((y as u16 as isize) << 16) | (x as u16 as isize);
    let wp = ((notches as u16 as usize) << 16) as usize;
    unsafe {
        let _ = PostMessageW(Some(pin.hwnd), WM_MOUSEWHEEL, WPARAM(wp), LPARAM(lp));
    }
}

pub(crate) fn selftest(app: &mut App, verifier: Option<verify::Handle>) -> String {
    let mut out = String::new();
    let period = measure::dwm_timing()
        .map(|t| t.qpcRefreshPeriod as i64)
        .unwrap_or(measure::qpf() / 60);
    let _ = writeln!(out, "刷新周期 {:.3} ms", ms(period));
    pump_until(app, qpc() + measure::qpf() / 2);
    // 阴影那一圈接不接点击：系统按逐像素 alpha 做命中测试，WindowFromPoint 走的是同一套。
    {
        let pin = &app.pins[0];
        let f = pin.full;
        let at = |x: i32, y: i32| unsafe { WindowFromPoint(POINT { x, y }) } == pin.hwnd;
        let _ = writeln!(
            out,
            "命中测试：阴影最外一列 {}，阴影中间 {}，内容 {}，窗口外一列 {}",
            at(f.x, f.y + f.h / 2),
            at(f.x + PIN_EDGE / 2, f.y + f.h / 2),
            at(f.x + f.w / 2, f.y + f.h / 2),
            at(f.x - 1, f.y + f.h / 2)
        );
    }

    let mut phase = |app: &mut App, name: &str, f: &mut dyn FnMut(&mut App, i64)| {
        let first = app.presents.len();
        let d0 = measure::dwm_timing();
        let t0 = qpc();
        f(app, period);
        // 等精缩上屏。
        pump_until(app, qpc() + measure::qpf() / 4);
        let d1 = measure::dwm_timing();
        let span = ms(qpc() - t0);
        let ps = &app.presents[first..];
        let _ = writeln!(out, "\n== {name}（{:.0} ms，上屏 {} 次）", span, ps.len());
        for q in [Quality::Gesture, Quality::Settled, Quality::Nearest] {
            let sel: Vec<&Present> = ps.iter().filter(|p| p.quality == q).collect();
            if sel.is_empty() {
                continue;
            }
            let mut render: Vec<f64> = sel.iter().map(|p| p.render_us as f64 / 1e3).collect();
            let mut resample: Vec<f64> = sel.iter().map(|p| p.resample_us as f64 / 1e3).collect();
            let mut blit: Vec<f64> = sel
                .iter()
                .map(|p| (p.blit_us + p.shadow_us) as f64 / 1e3)
                .collect();
            let mut ulw: Vec<f64> = sel.iter().map(|p| p.ulw_us as f64 / 1e3).collect();
            let mut input: Vec<f64> = sel.iter().filter_map(|p| p.input_ms).collect();
            let mut vb: Vec<f64> = sel.iter().filter_map(|p| p.to_vblank_ms).collect();
            let max_px = sel
                .iter()
                .map(|p| p.size.0 as i64 * p.size.1 as i64)
                .max()
                .unwrap_or(0);
            let big = sel
                .iter()
                .max_by_key(|p| p.size.0 as i64 * p.size.1 as i64)
                .unwrap();
            let _ = writeln!(
                out,
                "[{q:?}] 最大窗口 {}×{}（{:.1} MP），金字塔层 {:?}",
                big.size.0,
                big.size.1,
                max_px as f64 / 1e6,
                sel.iter()
                    .map(|p| p.level)
                    .collect::<std::collections::BTreeSet<_>>()
            );
            let _ = writeln!(out, "  {}", measure::summary("画一帧 ms", &mut render));
            let _ = writeln!(
                out,
                "  {}",
                measure::summary("  其中缩放 ms", &mut resample)
            );
            let _ = writeln!(
                out,
                "  {}",
                measure::summary("  其中搬运+阴影 ms", &mut blit)
            );
            let _ = writeln!(
                out,
                "  {}",
                measure::summary("UpdateLayeredWindow ms", &mut ulw)
            );
            let _ = writeln!(
                out,
                "  {}",
                measure::summary("输入→ULW 返回 ms", &mut input)
            );
            let _ = writeln!(
                out,
                "  {}",
                measure::summary("ULW 返回→下一次垂直同步 ms", &mut vb)
            );
        }
        if let (Some(a), Some(b)) = (d0, d1) {
            let _ = writeln!(
                out,
                "DWM：合成 {} 帧，刷新 {} 次，错过合成 {}，丢帧 {}",
                { b.cFrame } - { a.cFrame },
                { b.cRefresh } - { a.cRefresh },
                { b.cFramesMissed } - { a.cFramesMissed },
                { b.cFramesDropped } - { a.cFramesDropped }
            );
        }
        // 每个刷新周期里最多算一次有效上屏：超过一帧的间隔说明这段时间里没有新画面。
        // 输入按刷新周期等间隔送进来；输入→ULW 返回超过一个周期，这一格最早也要晚一帧才上屏。
        let miss = ps
            .iter()
            .filter(|p| p.reason != "settle" && p.input_ms.is_some_and(|m| m > ms(period)))
            .count();
        let cached = ps.iter().filter(|p| p.cached && p.render_us > 0).count();
        let _ = writeln!(
            out,
            "输入→ULW 返回超过一个刷新周期（这一格晚了至少一帧）：{miss} 次；复用上一帧缩放结果的上屏 {cached} 次"
        );
        let _ = writeln!(out, "SHQueryUserNotificationState = {}", measure::quns());
    };

    // 1. 每帧一格：缩小 12 格、放大 30 格（最后接近满屏）、再缩回 18 格。
    phase(app, "滚轮每刷新周期一格", &mut |app, period| {
        let mut at = qpc();
        for (n, dir) in [(12, -120i16), (30, 120), (18, -120)] {
            for _ in 0..n {
                post_wheel(app, 0, dir);
                at += period;
                pump_until(app, at);
            }
        }
    });
    // 2. 快速连滚：每个刷新周期 3 格（自由滚动的滚轮或触控板）。
    phase(app, "滚轮每刷新周期三格", &mut |app, period| {
        let mut at = qpc();
        for (n, dir) in [(8, 120i16), (8, -120)] {
            for _ in 0..n {
                for _ in 0..3 {
                    post_wheel(app, 0, dir);
                }
                at += period;
                pump_until(app, at);
            }
        }
    });
    // 3. 旋转、翻转。
    phase(app, "旋转 4 次、翻转 H/V", &mut |app, _| {
        for vk in [0x52, 0x52, 0x52, 0x52, 0x48, 0x56, 0x48, 0x56] {
            push(Ev::Key {
                pin: 0,
                vk,
                t: qpc(),
            });
            pump_until(app, qpc() + measure::qpf() / 5);
        }
    });
    // 4. 动画。
    phase(
        app,
        "动画（250 ms 放大到 2 倍再回来）",
        &mut |app, _| {
            app.animate(0, 250.0);
        },
    );
    // 5. 拖动：每个刷新周期挪 7 像素，共 120 帧。
    phase(
        app,
        "拖动（每刷新周期挪 7 像素）",
        &mut |app, period| {
            let o = app.pins[0].origin;
            push(Ev::Down {
                pin: 0,
                x: o.0 as i32 + 10,
                y: o.1 as i32 + 10,
            });
            let mut at = qpc();
            for k in 0..120 {
                let dx = if k < 60 { k * 7 } else { (120 - k) * 7 };
                push(Ev::Drag {
                    x: o.0 as i32 + 10 + dx,
                    y: o.1 as i32 + 10,
                    t: qpc(),
                });
                at += period;
                pump_until(app, at);
            }
            push(Ev::Up);
        },
    );
    // 6. 透明度、裁切。
    phase(app, "裁切、透明度", &mut |app, _| {
        push(Ev::Key {
            pin: 0,
            vk: 0x43,
            t: qpc(),
        });
        pump_until(app, qpc() + measure::qpf() / 5);
        push(Ev::Key {
            pin: 0,
            vk: 0x43,
            t: qpc(),
        });
        for _ in 0..3 {
            push(Ev::Key {
                pin: 0,
                vk: 0xDB,
                t: qpc(),
            });
            pump_until(app, qpc() + measure::qpf() / 10);
        }
        for _ in 0..3 {
            push(Ev::Key {
                pin: 0,
                vk: 0xDD,
                t: qpc(),
            });
            pump_until(app, qpc() + measure::qpf() / 10);
        }
    });

    let mut csv = String::from(
        "reason,quality,level,w,h,render_ms,resample_ms,blit_ms,shadow_ms,ulw_ms,input_ms,cached\n",
    );
    for p in &app.presents {
        let _ = writeln!(
            csv,
            "{},{:?},{},{},{},{:.3},{:.3},{:.3},{:.3},{:.3},{},{}",
            p.reason,
            p.quality,
            p.level,
            p.size.0,
            p.size.1,
            p.render_us as f64 / 1e3,
            p.resample_us as f64 / 1e3,
            p.blit_us as f64 / 1e3,
            p.shadow_us as f64 / 1e3,
            p.ulw_us as f64 / 1e3,
            p.input_ms.map(|m| format!("{m:.3}")).unwrap_or_default(),
            p.cached
        );
    }
    CSV.with(|c| *c.borrow_mut() = csv);
    let (mem, ws) = measure::process_memory();
    let _ = writeln!(
        out,
        "\n进程私有内存 {:.1} MB，工作集 {:.1} MB",
        mem as f64 / 1048576.0,
        ws as f64 / 1048576.0
    );
    if let Some(v) = verifier {
        let _ = writeln!(out, "\n== 逐帧核对（桌面复制）\n{}", v.finish());
    }
    out
}
