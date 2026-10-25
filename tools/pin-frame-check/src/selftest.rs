//! 自测脚本（原型的全部场景）与报告。滚轮消息直接投进钉图窗口（不动真实鼠标），拖动、旋转、
//! 动画、透明度直接改状态。

use std::fmt::Write as _;
use std::path::Path;

use kinshoko_core::desktop::Turn;
use kinshoko_core::desktop::frame::ZoomAnchor;
use pin_shell::{PinShell, PointerEvent};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_MOUSEWHEEL};

use crate::app::{App, SETTLE_MS};
use crate::sys::{self, next_frame, stats};
use crate::verify;

/// 往钉图看得见的槽投一条滚轮消息，落点按内容的比例取，夹在屏幕里。
fn wheel(app: &mut App, notches: f64, fx: f64, fy: f64) {
    let p = &app.pins[0];
    let c = p.pin.rect();
    let m = app.monitor;
    let x = (c.x + (f64::from(c.width) * fx) as i32).clamp(m.x + 50, m.x + m.width as i32 - 50);
    let y = (c.y + (f64::from(c.height) * fy) as i32).clamp(m.y + 50, m.y + m.height as i32 - 50);
    let slot = app.shell.visible_slot(p.id);
    let hwnd = HWND(app.shell.hwnd(p.id, slot).unwrap_or_default() as *mut _);
    let delta = ((notches * 120.0) as i16 as u16 as usize) << 16;
    let lp = ((y as u16 as isize) << 16) | (x as u16 as isize);
    unsafe {
        let _ = PostMessageW(Some(hwnd), WM_MOUSEWHEEL, WPARAM(delta), LPARAM(lp));
    }
}

fn step(app: &mut App) -> Result<(), String> {
    app.tick()?;
    next_frame();
    Ok(())
}

fn drag(
    app: &mut App,
    from: (i32, i32),
    moves: impl Iterator<Item = (i32, i32)>,
) -> Result<(), String> {
    app.pointer(
        0,
        from,
        PointerEvent::Down(pin_shell::PointerButton::Primary),
    )?;
    let mut at = from;
    for (dx, dy) in moves {
        at = (at.0 + dx, at.1 + dy);
        app.pointer(0, at, PointerEvent::Move)?;
        step(app)?;
    }
    app.pointer(0, at, PointerEvent::Up(pin_shell::PointerButton::Primary))
}

pub fn selftest(app: &mut App, report: &Path) -> Result<bool, String> {
    let checker = app
        .opts
        .verify
        .then(|| verify::start(app.log.clone(), app.monitor.into()));
    app.pump_for(300)?;
    let mem0 = (sys::private_mb(), sys::vram_mb());

    app.phase = "滚轮一格一帧";
    for k in 0..90 {
        wheel(app, if k < 45 { 1.0 } else { -1.0 }, 0.4, 0.3);
        step(app)?;
    }
    app.settle()?;

    app.phase = "滚轮每帧三格";
    for k in 0..30 {
        for _ in 0..3 {
            wheel(app, if k < 15 { 1.0 } else { -1.0 }, 0.7, 0.6);
        }
        step(app)?;
    }
    app.settle()?;

    app.phase = "滚轮隔 150 ms 一格";
    for k in 0..10 {
        wheel(app, if k < 5 { 1.0 } else { -1.0 }, 0.5, 0.5);
        app.pump_for(150)?;
    }
    app.settle()?;

    app.phase = "拖出屏幕一半再拖回";
    let c = app.pins[0].pin.rect();
    let moves = (0..150).map(|k| match k {
        0..50 => (-9, 0),
        50..100 => (9, 0),
        _ => (3, 5),
    });
    drag(app, (c.x + 20, c.y + 20), moves)?;
    app.settle()?;

    app.phase = "旋转翻转";
    for k in 0..6 {
        let turn = match k {
            4 => Turn::FlipHorizontal,
            5 => Turn::FlipVertical,
            _ => Turn::RotateClockwise,
        };
        app.pins[0].pin.turn(turn);
        app.update(0, false)?;
        app.pump_for(60)?;
    }
    app.settle()?;

    app.phase = "动画";
    let frames = (250.0 / sys::refresh_ms()).round().max(1.0) as i32;
    for round in 0..2 {
        let c = app.pins[0].pin.rect();
        let center = (
            f64::from(c.x) + f64::from(c.width) / 2.0,
            f64::from(c.y) + f64::from(c.height) / 2.0,
        );
        let anchor = ZoomAnchor::new(&app.pins[0].pin, center);
        let s0 = app.pins[0].pin.placement.scale;
        for i in 1..=frames {
            let t = f64::from(i) / f64::from(frames);
            let k = if round == 0 { 1.0 + t } else { 1.0 - t / 2.0 };
            anchor.zoom(&mut app.pins[0].pin, s0 * k);
            app.update(0, true)?;
            step(app)?;
        }
        app.update(0, false)?;
        app.settle()?;
    }

    app.phase = "比屏幕大时拖动与缩放";
    for _ in 0..30 {
        wheel(app, 1.0, 0.5, 0.5);
        step(app)?;
    }
    app.settle()?;
    let m = app.monitor;
    let mid = (m.x + m.width as i32 / 2, m.y + m.height as i32 / 2);
    drag(
        app,
        mid,
        (0..80).map(|k| if k < 40 { (11, 7) } else { (-11, -7) }),
    )?;
    let mem_big = (sys::private_mb(), sys::vram_mb());
    let quns_big = sys::quns();
    for _ in 0..30 {
        wheel(app, -1.0, 0.5, 0.5);
        step(app)?;
    }
    app.settle()?;

    app.phase = "透明度";
    for k in 0..20 {
        let o = if k < 10 {
            1.0 - 0.07 * f64::from(k)
        } else {
            0.3 + 0.07 * f64::from(k - 10)
        };
        app.pins[0].pin.set_opacity(o);
        app.update(0, false)?;
        step(app)?;
    }
    app.pins[0].pin.set_opacity(1.0);
    app.update(0, false)?;
    app.pump_for(400)?;

    let verdict = checker.map(|c| c.finish());
    let pass = verdict.as_ref().is_none_or(|v| v.checked > 0 && v.bad == 0);
    let mut out = String::new();
    let _ = writeln!(
        out,
        "显卡 {}\n显示器 {}×{}，刷新周期 {:.2} ms；模式 {}",
        app.render.describe(),
        m.width,
        m.height,
        sys::refresh_ms(),
        mode(app)
    );
    let _ = writeln!(
        out,
        "内存：开始 私有 {:.0} MB、显存 {:.0} MB；比屏幕大时 私有 {:.0} MB、显存 {:.0} MB；QUNS {quns_big}\n",
        mem0.0, mem0.1, mem_big.0, mem_big.1
    );
    write_timings(app, &mut out);
    if let Some(v) = &verdict {
        let _ = writeln!(out, "\n逐帧核对：\n{}", v.text);
        let _ = writeln!(out, "对不上的帧：{}（核对 {} 帧）", v.bad, v.checked);
    }
    let _ = writeln!(out, "\nQUNS（结束时）：{}", sys::quns());
    std::fs::write(report, &out).map_err(|e| e.to_string())?;
    print!("{out}");
    Ok(pass)
}

fn mode(app: &App) -> &'static str {
    match (app.opts.naive, app.opts.present_first) {
        (false, _) => "两槽换窗",
        (true, false) => "对照组：先改窗口再 Present",
        (true, true) => "对照组：先 Present 再改窗口",
    }
}

/// 各阶段的步骤数与耗时、换窗等待的分布、每条窗口消息的处理时间。
pub fn write_timings(app: &App, out: &mut String) {
    let mut phases: Vec<&str> = Vec::new();
    for r in &app.records {
        if !phases.contains(&r.phase) {
            phases.push(r.phase);
        }
    }
    let _ = writeln!(
        out,
        "| 阶段 | 重画 | 平移 | 换窗 | 对照 | 上屏中位 ms | p95 | 最大 |"
    );
    let _ = writeln!(out, "|---|---|---|---|---|---|---|---|");
    for ph in &phases {
        let rs: Vec<_> = app.records.iter().filter(|r| r.phase == *ph).collect();
        let n = |s: &str| rs.iter().filter(|r| r.step == s).count();
        let [m, p95, _, max] = stats(rs.iter().map(|r| r.total));
        let _ = writeln!(
            out,
            "| {ph} | {} | {} | {} | {} | {m:.2} | {p95:.2} | {max:.2} |",
            n("redraw"),
            n("move"),
            n("swap"),
            n("naive")
        );
    }
    let big = app
        .records
        .iter()
        .filter(|r| r.window_px >= 1_000_000)
        .count();
    let _ = writeln!(out, "（窗口 ≥ 1 MP 的上屏 {big} 次）\n");

    let [m, p95, p99, max] = stats(app.swap_call_ms.iter().copied());
    let _ = writeln!(
        out,
        "调 swap 本身：{} 次，中位 {m:.3} ms、p95 {p95:.3}、p99 {p99:.3}、最大 {max:.3}",
        app.swap_call_ms.len()
    );
    let [m, p95, p99, max] = stats(app.swap_wait_ms.iter().copied());
    let _ = writeln!(
        out,
        "swap → Swapped：{} 次，中位 {m:.2} ms、p95 {p95:.2}、p99 {p99:.2}、最大 {max:.2}",
        app.swap_wait_ms.len()
    );
    let edges = [4.0, 8.0, 12.0, 16.0, 25.0, 50.0, f64::INFINITY];
    let mut lo = 0.0;
    let mut hist = Vec::new();
    for hi in edges {
        let n = app
            .swap_wait_ms
            .iter()
            .filter(|&&w| w >= lo && w < hi)
            .count();
        hist.push(if hi.is_finite() {
            format!("{lo:.0}～{hi:.0} ms：{n}")
        } else {
            format!("≥{lo:.0} ms：{n}")
        });
        lo = hi;
    }
    let _ = writeln!(out, "  分布：{}", hist.join("，"));
    let [m, _, p99, max] = stats(app.dispatch_ms.iter().copied());
    let over = app.dispatch_ms.iter().filter(|&&d| d >= 2.0).count();
    let _ = writeln!(
        out,
        "界面线程每条消息：{} 条，中位 {m:.3} ms、p99 {p99:.3}、最大 {max:.3}；≥ 2 ms 的 {over} 条",
        app.dispatch_ms.len()
    );
    let _ = writeln!(out, "停手判定 {SETTLE_MS} ms");
}
