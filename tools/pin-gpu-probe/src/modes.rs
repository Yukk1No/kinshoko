//! 其他测量模式：停留（内存、QUNS、Edge）与真实鼠标的输入测试。

use super::*;
/// 钉住一段时间（配合 Edge 探针与显存读数）。`--fill` 时放到盖满屏幕。
pub(crate) fn hold(app: &mut App, ms: u64) -> Result<(), String> {
    app.pump_for(200.0)?;
    if app.opts.fill {
        let m = app.monitor;
        for id in 0..app.pins.len() {
            let v = &mut app.pins[id].view;
            let (w, h) = (f64::from(v.src_w), f64::from(v.src_h));
            v.scale = (f64::from(m.w) / w).max(f64::from(m.h) / h) * 1.05;
            v.x = f64::from(m.x) - 10.0;
            v.y = f64::from(m.y) - 10.0;
            app.update(id, false)?;
        }
    }
    app.pump_for(300.0)?;
    let windows: Vec<String> = app.pins.iter().map(|p| format!("{:?}", p.window)).collect();
    println!(
        "钉住 {} 张；窗口 {}；私有 {:.0} MB，显存 {:.0} MB；QUNS {}",
        app.pins.len(),
        windows.join(" "),
        sys::private_mb(),
        sys::vram_mb(),
        sys::quns()
    );
    app.pump_for(ms as f64)?;
    println!("结束前 QUNS {}", sys::quns());
    Ok(())
}

/// 真实输入（会动真实鼠标，先确认没人在用电脑）：前台先放别的程序，在钉图上拖动、滚轮，看前台变没变。
pub(crate) fn input_test(app: &mut App) -> Result<(), String> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetCursorPos, GetForegroundWindow, SetCursorPos, WindowFromPoint};
    let mouse = |flags: MOUSE_EVENT_FLAGS, data: i32| INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dwFlags: flags, mouseData: data as u32, ..Default::default() },
        },
    };
    let send = |i: &[INPUT]| unsafe {
        SendInput(i, std::mem::size_of::<INPUT>() as i32);
    };
    let name = |h: windows::Win32::Foundation::HWND| {
        let mut b = [0u16; 128];
        let n = unsafe { GetClassNameW(h, &mut b) };
        String::from_utf16_lossy(&b[..n.max(0) as usize])
    };
    app.pump_for(300.0)?;
    let mut saved = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut saved);
    }
    let fg0 = unsafe { GetForegroundWindow() };
    println!("开始时前台：{}", name(fg0));
    let c = app.pins[0].view.content();
    let (cx, cy) = (c.x + c.w / 2, c.y + c.h / 2);
    unsafe {
        let _ = SetCursorPos(cx, cy);
    }
    app.pump_for(50.0)?;
    let under = unsafe { WindowFromPoint(POINT { x: cx, y: cy }) };
    println!("光标下：{}（{}）", name(under), if under == app.shell.hwnd(0, app.shell.visible_slot(0)) { "钉图" } else { "别的" });
    let o0 = app.pins[0].view.content();
    send(&[mouse(MOUSEEVENTF_LEFTDOWN, 0)]);
    app.pump_for(30.0)?;
    for k in 1..=12 {
        unsafe {
            let _ = SetCursorPos(cx + k * 5, cy);
        }
        send(&[mouse(MOUSEEVENTF_MOVE, 0)]);
        app.pump_for(8.0)?;
    }
    send(&[mouse(MOUSEEVENTF_LEFTUP, 0)]);
    app.pump_for(200.0)?;
    let o1 = app.pins[0].view.content();
    let fg = unsafe { GetForegroundWindow() };
    println!("拖动：挪了 ({}, {})；前台 {}", o1.x - o0.x, o1.y - o0.y, if fg == fg0 { "没变" } else { "变了！" });
    let s0 = app.pins[0].view.scale;
    for _ in 0..3 {
        send(&[mouse(MOUSEEVENTF_WHEEL, 120)]);
        app.pump_for(30.0)?;
    }
    app.pump_for(300.0)?;
    let fg = unsafe { GetForegroundWindow() };
    println!("滚轮 3 格：缩放 {:.3} → {:.3}；前台 {}（换窗 {} 次）", s0, app.pins[0].view.scale, if fg == fg0 { "没变" } else { "变了！" },
        app.records.iter().filter(|r| r.step == "swap").count());
    // 透明处与阴影外：窗口外一列不应命中钉图。
    let w = app.pins[0].window;
    let outside = unsafe { WindowFromPoint(POINT { x: w.x - 1, y: w.y + w.h / 2 }) };
    let edge = unsafe { WindowFromPoint(POINT { x: w.x, y: w.y + w.h / 2 }) };
    let pin_hwnds = [app.shell.hwnd(0, 0), app.shell.hwnd(0, 1)];
    println!("阴影最外一列命中钉图：{}；窗口外一列命中钉图：{}", pin_hwnds.contains(&edge), pin_hwnds.contains(&outside));
    // 点击穿透。
    app.shell.set_click_through(0, true);
    app.pump_for(100.0)?;
    let c = app.pins[0].view.content();
    let through = unsafe { WindowFromPoint(POINT { x: c.x + c.w / 2, y: c.y + c.h / 2 }) };
    println!("穿透后光标下：{}（{}）", name(through), if pin_hwnds.contains(&through) { "仍是钉图！" } else { "别的窗口" });
    app.shell.set_click_through(0, false);
    // 穿透开关后内容还在（分层样式会不会影响 DComp 内容）：再画一帧。
    app.update(0, false)?;
    unsafe {
        let _ = SetCursorPos(saved.x, saved.y);
    }
    Ok(())
}
