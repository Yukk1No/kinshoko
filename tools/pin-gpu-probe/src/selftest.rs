//! 自测脚本与报告（按阶段、按窗口大小统计，附逐帧核对结论）。

use super::*;
/// 自测：按刷新节奏把滚轮消息投进钉图窗口（不动真实鼠标），拖动、旋转、动画直接改状态。
pub(crate) fn selftest(app: &mut App, report: &Path) -> Result<(), String> {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_MOUSEWHEEL};
    let checker = app
        .opts
        .verify
        .then(|| verify::start(app.log.clone(), app.monitor));
    app.measure_gpu = true;
    app.pump_for(300.0)?;
    let id = 0;
    let mem0 = (sys::private_mb(), sys::vram_mb());

    let wheel = |app: &mut App, notches: f64, fx: f64, fy: f64| {
        let c = app.pins[id].view.content();
        let x = c.x + (f64::from(c.w) * fx) as i32;
        let y = c.y + (f64::from(c.h) * fy) as i32;
        // 夹到屏幕里（放得很大时取屏幕上的点）。
        let x = x.clamp(app.monitor.x + 50, app.monitor.right() - 50);
        let y = y.clamp(app.monitor.y + 50, app.monitor.bottom() - 50);
        let slot = app.shell.visible_slot(id);
        let hwnd = app.shell.hwnd(id, slot);
        let delta = ((notches * 120.0) as i16 as u16 as usize) << 16;
        let lp = ((y as u16 as isize) << 16) | (x as u16 as isize);
        unsafe {
            let _ = PostMessageW(Some(hwnd), WM_MOUSEWHEEL, WPARAM(delta), LPARAM(lp));
        }
    };
    let settle = |app: &mut App| app.pump_for(SETTLE_MS + 80.0);

    // 1. 一格一帧：放大到盖满屏幕以上，再缩回来。
    app.phase = "滚轮一格一帧";
    for k in 0..90 {
        wheel(app, if k < 45 { 1.0 } else { -1.0 }, 0.4, 0.3);
        app.tick()?;
        frame();
    }
    settle(app)?;
    // 2. 快速连滚：每帧三格。
    app.phase = "滚轮每帧三格";
    for k in 0..30 {
        for _ in 0..3 {
            wheel(app, if k < 15 { 1.0 } else { -1.0 }, 0.7, 0.6);
        }
        app.tick()?;
        frame();
    }
    settle(app)?;
    // 3. 慢滚：每格隔几帧，手势在两格之间结束又开始。
    app.phase = "滚轮隔 150 ms 一格";
    for k in 0..10 {
        wheel(app, if k < 5 { 1.0 } else { -1.0 }, 0.5, 0.5);
        app.pump_for(150.0)?;
    }
    settle(app)?;
    // 4. 拖动：向左拖出屏幕一半，再拖回来，再往下。
    app.phase = "拖动";
    let start = app.pins[id].view.content();
    let (sx, sy) = (start.x + 20, start.y + 20);
    app.handle(Input::Down { pin: id, x: sx, y: sy })?;
    let mut pos = (sx, sy);
    for k in 0..150 {
        pos = match k {
            0..50 => (pos.0 - 9, pos.1),
            50..100 => (pos.0 + 9, pos.1),
            _ => (pos.0 + 3, pos.1 + 5),
        };
        app.handle(Input::Move { pin: id, x: pos.0, y: pos.1 })?;
        app.tick()?;
        frame();
    }
    app.handle(Input::Up { pin: id, x: pos.0, y: pos.1 })?;
    settle(app)?;
    // 5. 旋转与翻转：每次是一次离散的尺寸变化（不在手势里）。
    app.phase = "旋转翻转";
    for k in 0..6 {
        let v = &mut app.pins[id].view;
        match k {
            4 => v.flip_h = !v.flip_h,
            5 => v.flip_v = !v.flip_v,
            _ => v.rotate_cw(),
        }
        app.update(id, false)?;
        app.pump_for(60.0)?;
    }
    settle(app)?;
    // 6. 动画：250 ms 放大到 2 倍再回来（以中心为锚）。
    app.phase = "动画";
    for round in 0..2 {
        let v0 = app.pins[id].view;
        let c = v0.content();
        let (cx, cy) = (f64::from(c.x) + f64::from(c.w) / 2.0, f64::from(c.y) + f64::from(c.h) / 2.0);
        let n = (250.0 / sys::refresh_ms()).round() as i32;
        for i in 1..=n {
            let t = f64::from(i) / f64::from(n);
            let k = if round == 0 { 1.0 + t } else { 2.0 - t };
            let mut v = v0;
            v.zoom_at(cx, cy, k / if round == 0 { 1.0 } else { 2.0 });
            app.pins[id].view = v;
            app.update(id, true)?;
            frame();
        }
        app.update(id, false)?;
        app.pump_for(60.0)?;
    }
    settle(app)?;
    // 7. 比屏幕大：放到盖满屏幕，拖着平移，再缩回。
    app.phase = "比屏幕大时拖动与缩放";
    for _ in 0..30 {
        wheel(app, 1.0, 0.5, 0.5);
        app.tick()?;
        frame();
    }
    let mid = (app.monitor.x + app.monitor.w / 2, app.monitor.y + app.monitor.h / 2);
    app.handle(Input::Down { pin: id, x: mid.0, y: mid.1 })?;
    let mut pos = mid;
    for k in 0..80 {
        pos = if k < 40 { (pos.0 + 11, pos.1 + 7) } else { (pos.0 - 11, pos.1 - 7) };
        app.handle(Input::Move { pin: id, x: pos.0, y: pos.1 })?;
        app.tick()?;
        frame();
    }
    app.handle(Input::Up { pin: id, x: pos.0, y: pos.1 })?;
    let mem_big = (sys::private_mb(), sys::vram_mb());
    for _ in 0..30 {
        wheel(app, -1.0, 0.5, 0.5);
        app.tick()?;
        frame();
    }
    settle(app)?;
    // 8. 透明度（核对跳过）。
    app.phase = "透明度";
    for k in 0..20 {
        app.pins[id].view.opacity = if k < 10 { 1.0 - 0.07 * k as f32 } else { 0.3 + 0.07 * (k - 10) as f32 };
        app.update(id, false)?;
        frame();
    }
    app.pins[id].view.opacity = 1.0;
    app.update(id, false)?;
    app.pump_for(400.0)?;

    let verdict = checker.map(|c| c.finish());
    write_report(app, report, mem0, mem_big, verdict)
}

pub(crate) fn write_report(
    app: &App,
    path: &Path,
    mem0: (f64, f64),
    mem_big: (f64, f64),
    verdict: Option<String>,
) -> Result<(), String> {
    let mut out = String::new();
    let (mon, dpi) = sys::primary_monitor();
    let _ = writeln!(
        out,
        "显卡 {}\n显示器 {}×{}，DPI {dpi}，刷新周期 {:.2} ms；模式 {}\n",
        app.gpu.describe(),
        mon.w,
        mon.h,
        sys::refresh_ms(),
        if app.opts.naive {
            if app.opts.present_first { "对照组：先 Present 再 SetWindowPos" } else { "对照组：先 SetWindowPos 再 Present" }
        } else {
            "两槽换窗"
        }
    );
    let _ = writeln!(
        out,
        "内存：开始 私有 {:.0} MB、显存 {:.0} MB；盖满屏幕时 私有 {:.0} MB、显存 {:.0} MB；钉图 {} 张\n",
        mem0.0,
        mem0.1,
        mem_big.0,
        mem_big.1,
        app.pins.len()
    );
    // 每个阶段的步骤计数。
    let mut phases: Vec<&str> = Vec::new();
    for r in &app.records {
        if !phases.contains(&r.phase) {
            phases.push(r.phase);
        }
    }
    let _ = writeln!(out, "阶段\t重画\t挪窗\t换窗\t对照\t中位 ms\tp95 ms\t最大 ms");
    for ph in &phases {
        let rs: Vec<&Record> = app.records.iter().filter(|r| r.phase == *ph).collect();
        let c = |s: &str| rs.iter().filter(|r| r.step == s).count();
        let (m, p95, max) = stats(rs.iter().map(|r| r.total));
        let _ = writeln!(
            out,
            "{ph}\t{}\t{}\t{}\t{}\t{m:.2}\t{p95:.2}\t{max:.2}",
            c("redraw"),
            c("move"),
            c("swap"),
            c("naive")
        );
    }
    let _ = writeln!(out, "\n按窗口大小（只看重画与换窗，单位 ms）：");
    let _ = writeln!(out, "步骤\t窗口像素\t帧数\t总 中位/p95/最大\t取缓冲 中位\t提交+Present 中位/最大\t改交换链 中位/最大\t等合成 中位/最大\tGPU 完成 中位/最大");
    let buckets = [(0, 500_000), (500_000, 1_000_000), (1_000_000, 2_000_000), (2_000_000, 3_000_000), (3_000_000, i64::MAX)];
    for step in ["redraw", "swap", "naive", "move"] {
        for (lo, hi) in buckets {
            let rs: Vec<&Record> = app
                .records
                .iter()
                .filter(|r| r.step == step && r.window_px >= lo && r.window_px < hi)
                .collect();
            if rs.is_empty() {
                continue;
            }
            let t = stats(rs.iter().map(|r| r.total));
            let a = stats(rs.iter().map(|r| r.acquire));
            let s = stats(rs.iter().map(|r| r.submit));
            let cf = stats(rs.iter().map(|r| r.configure));
            let w = stats(rs.iter().map(|r| r.wait));
            let g = stats(rs.iter().map(|r| r.gpu_done));
            let label = if hi == i64::MAX {
                format!("≥{:.1} MP", lo as f64 / 1e6)
            } else {
                format!("{:.1}～{:.1} MP", lo as f64 / 1e6, hi as f64 / 1e6)
            };
            let _ = writeln!(
                out,
                "{step}\t{label}\t{}\t{:.2}/{:.2}/{:.2}\t{:.2}\t{:.2}/{:.2}\t{:.2}/{:.2}\t{:.2}/{:.2}\t{:.2}/{:.2}",
                rs.len(),
                t.0, t.1, t.2, a.0, s.0, s.2, cf.0, cf.2, w.0, w.2, g.0, g.2
            );
        }
    }
    if let Some(v) = verdict {
        let _ = writeln!(out, "\n逐帧核对：\n{v}");
    }
    let _ = writeln!(out, "\nQUNS（结束时）：{}", sys::quns());
    std::fs::write(path, &out).map_err(|e| e.to_string())?;
    let mut csv = String::from("phase,step,window_px,total,configure,acquire,submit,wait,gpu_done\n");
    for r in &app.records {
        let _ = writeln!(
            csv,
            "{},{},{},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3}",
            r.phase, r.step, r.window_px, r.total, r.configure, r.acquire, r.submit, r.wait, r.gpu_done
        );
    }
    std::fs::write(path.with_extension("csv"), csv).map_err(|e| e.to_string())?;
    print!("{out}");
    Ok(())
}

pub(crate) fn stats(v: impl Iterator<Item = f64>) -> (f64, f64, f64) {
    let mut v: Vec<f64> = v.collect();
    if v.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    v.sort_by(|a, b| a.total_cmp(b));
    let at = |p: f64| v[((v.len() - 1) as f64 * p).round() as usize];
    (at(0.5), at(0.95), v[v.len() - 1])
}
