//! 其他验收模式：停留（内存、QUNS、配合 Edge 探针）、窗口区域裁输入的实验、设备丢失后重建。
//! 真实输入与焦点见 `input.rs`。

use std::time::Instant;

use kinshoko_core::desktop::PIN_EDGE;
use pin_render::LutData;
use pin_shell::PinShell;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::Graphics::Gdi::{CreateRectRgn, GetDC, GetPixel, ReleaseDC, SetWindowRgn};
use windows::Win32::UI::WindowsAndMessaging::WindowFromPoint;

use crate::app::{App, MARKER};
use crate::sys;

/// 钉住一段时间。`--fill` 时放到盖满屏幕（窗口按 ADR 0011 让出一行）。
pub fn hold(app: &mut App, ms: u64) -> Result<(), String> {
    app.pump_for(200)?;
    if app.opts.fill {
        let m = app.monitor;
        for i in 0..app.pins.len() {
            let p = &mut app.pins[i].pin;
            let (w, h) = (f64::from(MARKER.0), f64::from(MARKER.1));
            p.placement.scale = (f64::from(m.width) / w).max(f64::from(m.height) / h) * 1.05;
            p.placement.x = m.x - 10;
            p.placement.y = m.y - 10;
            app.update(i, false)?;
        }
        app.settle()?;
    }
    app.pump_for(300)?;
    let windows: Vec<String> = app.pins.iter().map(|p| format!("{:?}", p.window)).collect();
    println!(
        "钉住 {} 张；窗口 {}；私有 {:.0} MB，显存 {:.0} MB；QUNS {}",
        app.pins.len(),
        windows.join(" "),
        sys::private_mb(),
        sys::vram_mb(),
        sys::quns()
    );
    app.pump_for(ms)?;
    println!("结束前 QUNS {}", sys::quns());
    Ok(())
}

fn screen_pixel(x: i32, y: i32) -> (u8, u8, u8) {
    unsafe {
        let dc = GetDC(None);
        let c = GetPixel(dc, x, y).0;
        ReleaseDC(None, dc);
        (
            (c & 0xff) as u8,
            ((c >> 8) & 0xff) as u8,
            ((c >> 16) & 0xff) as u8,
        )
    }
}

fn is_magenta((r, g, b): (u8, u8, u8)) -> bool {
    r >= 250 && b >= 250 && g <= 6
}

/// 试“窗口区域只裁输入”（#283）：给看得见的槽设一个比内容小的窗口区域，看区域外的 DComp 内容
/// 还在不在、区域外还接不接点击。只读一个屏幕像素，不截图。
pub fn region_test(app: &mut App) -> Result<(), String> {
    app.pump_for(300)?;
    let p = &app.pins[0];
    let c = p.pin.rect();
    let w = p.window;
    // 左边框中间：在内容里、在下面设的区域外。
    let probe = (c.x + 2, c.y + c.height as i32 / 2);
    let hwnd = HWND(
        app.shell
            .hwnd(p.id, app.shell.visible_slot(p.id))
            .unwrap_or_default() as *mut _,
    );
    let before = screen_pixel(probe.0, probe.1);
    let hit_before = unsafe {
        WindowFromPoint(POINT {
            x: probe.0,
            y: probe.1,
        })
    } == hwnd;
    // 区域：窗口坐标，去掉左边 PIN_EDGE＋边框宽度的一半。
    let cut = PIN_EDGE as i32 + c.width as i32 / 4;
    unsafe {
        let rgn = CreateRectRgn(cut, 0, w.width as i32, w.height as i32);
        SetWindowRgn(hwnd, Some(rgn), true);
    }
    app.pump_for(300)?;
    let after = screen_pixel(probe.0, probe.1);
    let hit_after = unsafe {
        WindowFromPoint(POINT {
            x: probe.0,
            y: probe.1,
        })
    } == hwnd;
    unsafe {
        SetWindowRgn(hwnd, None, true);
    }
    app.pump_for(100)?;
    println!(
        "区域外的一点 {probe:?}：设区域前 品红={} 命中钉图={hit_before}；设区域后 品红={} 命中钉图={hit_after}",
        is_magenta(before),
        is_magenta(after)
    );
    println!(
        "结论：窗口区域{}裁掉 DComp 内容，{}裁掉输入",
        if is_magenta(after) { "不" } else { "也" },
        if hit_after { "没" } else { "" }
    );
    Ok(())
}

/// 设备丢失后重建：渲染层整个重建、重新上传，平台层给同一对窗口新的 Surface 目标，量多久重新显示。
pub fn device_loss(app: &mut App) -> Result<f64, String> {
    app.pump_for(300)?;
    let t = Instant::now();
    app.render.simulate_device_loss();
    let lost = app.redraw_visible(0).is_err() || app.render.is_lost();
    app.render.rebuild().map_err(|e| e.to_string())?;
    app.lut = app
        .render
        .lut(LutData::Identity)
        .map_err(|e| e.to_string())?;
    app.reupload(0)?;
    let id = app.pins[0].id;
    // 先丢掉旧 Surface，再要新目标。
    app.drop_surfaces(0);
    let [a, b] = app.shell.retarget(id).map_err(|e| e.to_string())?;
    // SAFETY：目标在钉图关掉或再次 retarget 之前有效。
    unsafe {
        app.set_surfaces(
            0,
            [
                app.render.surface(a).map_err(|e| e.to_string())?,
                app.render.surface(b).map_err(|e| e.to_string())?,
            ],
        );
    }
    app.redraw_visible(0)?;
    let window = app.pins[0].window;
    app.shell.show(id, window);
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    app.pump_for(300)?;
    let c = app.pins[0].pin.rect();
    let shown = is_magenta(screen_pixel(c.x + 2, c.y + c.height as i32 / 2));
    println!("设备丢失（检测到={lost}）→ 重新显示 {ms:.0} ms；之后屏幕上看得见钉图边框={shown}");
    Ok(ms)
}
