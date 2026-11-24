//! Windows 适配器的集成测试。窗口摆在所有显示器之外、没有内容，不占屏幕、不动鼠标键盘；
//! 画面、焦点与输入的验收在 `tools/pin-frame-check` 里做（要占用屏幕）。
#![cfg(windows)]
#![allow(unsafe_code)]

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use pin_shell::windows::{WinShell, dispatch_pending};
use pin_shell::{PinId, PinInput, PinShell, ScreenRect};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetWindowLongW, IsWindow, IsWindowVisible, WS_EX_APPWINDOW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_NOREDIRECTIONBITMAP, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_EX_TRANSPARENT,
};

const PIN: PinId = PinId(7);

/// 远在所有显示器之外。
fn off_screen(width: u32, height: u32) -> ScreenRect {
    ScreenRect {
        x: -30_000,
        y: -30_000,
        width,
        height,
    }
}

fn hwnd(shell: &WinShell, slot: usize) -> HWND {
    HWND(shell.hwnd(PIN, slot).expect("钉图存在") as *mut _)
}

fn ex_style(h: HWND) -> u32 {
    unsafe { GetWindowLongW(h, GWL_EXSTYLE) as u32 }
}

fn visible(h: HWND) -> bool {
    unsafe { IsWindowVisible(h).as_bool() }
}

/// 分发消息直到 `until` 从输入里找到想要的，或超时。
fn pump_until(
    shell: &mut WinShell,
    timeout: Duration,
    mut until: impl FnMut(&PinInput) -> bool,
) -> Option<PinInput> {
    let end = Instant::now() + timeout;
    while Instant::now() < end {
        dispatch_pending();
        if let Some(found) = shell.pump().into_iter().find(|i| until(i)) {
            return Some(found);
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    None
}

#[test]
fn slot_windows_never_activate_and_stay_out_of_the_taskbar() {
    let mut shell = WinShell::new(|| {}).unwrap();
    shell.create(PIN).unwrap();
    for slot in 0..2 {
        let ex = ex_style(hwnd(&shell, slot));
        for (bit, name) in [
            (WS_EX_NOREDIRECTIONBITMAP, "NOREDIRECTIONBITMAP"),
            (WS_EX_TOOLWINDOW, "TOOLWINDOW"),
            (WS_EX_TOPMOST, "TOPMOST"),
            (WS_EX_NOACTIVATE, "NOACTIVATE"),
        ] {
            assert_ne!(ex & bit.0, 0, "槽 {slot} 少了 WS_EX_{name}");
        }
        assert_eq!(ex & WS_EX_APPWINDOW.0, 0);
        assert!(!visible(hwnd(&shell, slot)), "建好时还看不见");
    }
}

#[test]
fn one_shell_per_thread() {
    let _shell = WinShell::new(|| {}).unwrap();
    assert!(WinShell::new(|| {}).is_err());
}

#[test]
fn swap_returns_at_once_and_completes_through_pump() {
    let woken = Rc::new(Cell::new(0));
    let w = woken.clone();
    let mut shell = WinShell::new(move || w.set(w.get() + 1)).unwrap();
    shell.create(PIN).unwrap();
    shell.show(PIN, off_screen(100, 100));
    assert!(visible(hwnd(&shell, 0)));
    shell.stage(PIN, off_screen(300, 200));
    assert!(visible(hwnd(&shell, 1)), "备用槽摆好（不透明度 0）");

    let t = Instant::now();
    shell.swap(PIN);
    let call = t.elapsed();
    assert!(call < Duration::from_millis(2), "swap 不等合成器：{call:?}");
    assert_eq!(shell.visible_slot(PIN), 0, "报出 Swapped 之前还是原来的槽");

    let swapped = pump_until(&mut shell, Duration::from_secs(2), |i| {
        matches!(i, PinInput::Swapped { .. })
    });
    let Some(PinInput::Swapped { pin, waited_ms }) = swapped else {
        panic!("2 秒内没有 Swapped");
    };
    assert_eq!(pin, PIN);
    assert!(waited_ms > 0.0 && waited_ms < 200.0, "等了 {waited_ms} ms");
    assert_eq!(shell.visible_slot(PIN), 1);
    assert!(woken.get() > 0, "有通知时唤醒宿主");

    // 换下的槽过两个刷新周期收起。
    let old = hwnd(&shell, 0);
    let end = Instant::now() + Duration::from_secs(1);
    while visible(old) && Instant::now() < end {
        dispatch_pending();
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(!visible(old), "换下的槽没有收起");
    assert!(visible(hwnd(&shell, 1)));
}

#[test]
fn staging_again_cancels_a_pending_swap() {
    let mut shell = WinShell::new(|| {}).unwrap();
    shell.create(PIN).unwrap();
    shell.show(PIN, off_screen(100, 100));
    shell.stage(PIN, off_screen(200, 200));
    shell.swap(PIN);
    shell.stage(PIN, off_screen(300, 300));
    let early = pump_until(&mut shell, Duration::from_millis(300), |i| {
        matches!(i, PinInput::Swapped { .. })
    });
    assert_eq!(early, None, "作废的 swap 不该换上");
    assert_eq!(shell.visible_slot(PIN), 0);
    shell.swap(PIN);
    assert!(
        pump_until(&mut shell, Duration::from_secs(2), |i| matches!(
            i,
            PinInput::Swapped { .. }
        ))
        .is_some()
    );
    assert_eq!(shell.visible_slot(PIN), 1);
}

#[test]
fn swaps_back_and_forth() {
    let mut shell = WinShell::new(|| {}).unwrap();
    shell.create(PIN).unwrap();
    shell.show(PIN, off_screen(100, 100));
    for round in 1..=4u32 {
        shell.stage(PIN, off_screen(100 + round * 10, 100));
        shell.swap(PIN);
        assert!(
            pump_until(&mut shell, Duration::from_secs(2), |i| matches!(
                i,
                PinInput::Swapped { .. }
            ))
            .is_some(),
            "第 {round} 次"
        );
        assert_eq!(shell.visible_slot(PIN), (round % 2) as usize);
    }
}

#[test]
fn click_through_toggles_layered_transparent_on_both_slots() {
    let mut shell = WinShell::new(|| {}).unwrap();
    shell.create(PIN).unwrap();
    let bits = (WS_EX_LAYERED | WS_EX_TRANSPARENT).0;
    shell.set_click_through(PIN, true);
    for slot in 0..2 {
        assert_eq!(ex_style(hwnd(&shell, slot)) & bits, bits);
    }
    shell.set_click_through(PIN, false);
    for slot in 0..2 {
        assert_eq!(ex_style(hwnd(&shell, slot)) & bits, 0);
        assert_ne!(ex_style(hwnd(&shell, slot)) & WS_EX_NOACTIVATE.0, 0);
    }
}

#[test]
fn translate_moves_only_the_visible_slot() {
    let mut shell = WinShell::new(|| {}).unwrap();
    shell.create(PIN).unwrap();
    shell.show(PIN, off_screen(100, 100));
    let moved = ScreenRect {
        x: -29_000,
        ..off_screen(100, 100)
    };
    shell.translate(PIN, moved);
    let mut r = Default::default();
    unsafe {
        windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd(&shell, 0), &mut r).unwrap()
    };
    assert_eq!(
        (r.left, r.top, r.right - r.left, r.bottom - r.top),
        (-29_000, -30_000, 100, 100)
    );
}

#[test]
fn retarget_gives_new_targets_for_the_same_windows() {
    let mut shell = WinShell::new(|| {}).unwrap();
    let first = shell.create(PIN).unwrap();
    let before = (hwnd(&shell, 0), hwnd(&shell, 1));
    let again = shell.retarget(PIN).unwrap();
    assert_eq!((hwnd(&shell, 0), hwnd(&shell, 1)), before);
    let raw = |t: &wgpu::SurfaceTargetUnsafe| match t {
        wgpu::SurfaceTargetUnsafe::CompositionVisual(p) => *p,
        _ => panic!("不是 DComp visual"),
    };
    for slot in 0..2 {
        assert!(!raw(&again[slot]).is_null());
        assert_ne!(raw(&first[slot]), raw(&again[slot]));
    }
}

#[test]
fn close_destroys_both_windows_and_frees_the_id() {
    let mut shell = WinShell::new(|| {}).unwrap();
    shell.create(PIN).unwrap();
    let (a, b) = (hwnd(&shell, 0), hwnd(&shell, 1));
    shell.close(PIN);
    unsafe {
        assert!(!IsWindow(Some(a)).as_bool());
        assert!(!IsWindow(Some(b)).as_bool());
    }
    assert!(shell.hwnd(PIN, 0).is_none());
    shell.create(PIN).unwrap();
}

#[test]
fn displays_are_physical_rects_with_scales() {
    let shell = WinShell::new(|| {}).unwrap();
    let displays = shell.displays();
    assert!(!displays.is_empty());
    for d in &displays {
        assert!(d.id.starts_with(r"\\.\"), "设备名 {}", d.id);
        assert!(d.rect.width > 0 && d.rect.height > 0);
        assert!(d.scale >= 1.0 && d.scale <= 5.0, "缩放 {}", d.scale);
        if let Some(icc) = &d.profile {
            assert_eq!(&icc[36..40], b"acsp", "配置文件不是 ICC");
        }
    }
}

#[test]
fn dropping_the_shell_destroys_its_windows() {
    let mut shell = WinShell::new(|| {}).unwrap();
    shell.create(PIN).unwrap();
    let a = hwnd(&shell, 0);
    drop(shell);
    assert!(!unsafe { IsWindow(Some(a)) }.as_bool());
    // 同一线程可以再建。
    let _again = WinShell::new(|| {}).unwrap();
}
