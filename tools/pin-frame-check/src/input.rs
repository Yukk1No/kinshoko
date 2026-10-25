//! 真实输入与焦点（会动真实鼠标键盘，先确认没人在用电脑）。
//!
//! 前台放一个“收键窗口”（本程序以 `--key-sink` 起的子进程，记下自己收到的键），在钉图上用
//! SendInput 拖动、滚轮、按 H/V/R，看前台变没变、键归谁；光标移开再按，键应进前台程序；
//! 再看阴影一圈与窗口外的命中、点击穿透。

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::Duration;

use pin_shell::{Key, PinInput, PinKeys, PinShell};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP, MOUSE_EVENT_FLAGS,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_WHEEL, MOUSEINPUT,
    SendInput, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CW_USEDEFAULT, CreateWindowExW, DefWindowProcW, DispatchMessageW, FindWindowW, GetCursorPos,
    GetForegroundWindow, GetMessageW, KillTimer, MSG, PostMessageW, PostQuitMessage,
    RegisterClassExW, SW_SHOW, SetCursorPos, SetForegroundWindow, SetTimer, ShowWindow,
    TranslateMessage, WINDOW_EX_STYLE, WM_CLOSE, WM_DESTROY, WM_KEYDOWN, WM_TIMER, WNDCLASSEXW,
    WS_OVERLAPPEDWINDOW, WindowFromPoint,
};
use windows::core::w;

use crate::app::App;

static mut SINK_KEYS: [u32; 256] = [0; 256];

unsafe extern "system" fn sink_proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_KEYDOWN => unsafe {
            SINK_KEYS[wp.0 & 0xff] += 1;
            LRESULT(0)
        },
        WM_TIMER | WM_CLOSE => unsafe {
            let _ = KillTimer(Some(h), 1);
            let keys = &*std::ptr::addr_of!(SINK_KEYS);
            let n = |vk: u8| keys[vk as usize];
            println!("H={} V={} R={}", n(b'H'), n(b'V'), n(b'R'));
            PostQuitMessage(0);
            LRESULT(0)
        },
        WM_DESTROY => LRESULT(0),
        _ => unsafe { DefWindowProcW(h, msg, wp, lp) },
    }
}

/// 子进程：一个普通的前台窗口，记下自己收到的 H/V/R，关窗或 `seconds` 秒后打印并退出。
pub fn key_sink(seconds: u32) {
    unsafe {
        let instance = GetModuleHandleW(None).unwrap_or_default();
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(sink_proc),
            hInstance: instance.into(),
            lpszClassName: w!("KinshokoKeySink"),
            ..Default::default()
        };
        RegisterClassExW(&class);
        let Ok(h) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("KinshokoKeySink"),
            w!("收键窗口"),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            480,
            320,
            None,
            None,
            Some(instance.into()),
            None,
        ) else {
            return;
        };
        let _ = ShowWindow(h, SW_SHOW);
        let _ = SetForegroundWindow(h);
        SetTimer(Some(h), 1, seconds * 1000, None);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn send(inputs: &[INPUT]) {
    unsafe {
        SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

fn mouse(flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: flags,
                mouseData: data as u32,
                ..Default::default()
            },
        },
    }
}

fn key(vk: u8) {
    let k = |up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(u16::from(vk)),
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                ..Default::default()
            },
        },
    };
    send(&[k(false), k(true)]);
}

fn cursor(x: i32, y: i32) {
    unsafe {
        let _ = SetCursorPos(x, y);
    }
    send(&[mouse(MOUSEEVENTF_MOVE, 0)]);
}

pub fn input_test(app: &mut App) -> Result<bool, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut sink = Command::new(exe)
        .args(["--key-sink", "60"])
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    app.pump_for(1500)?;
    let sink_hwnd =
        unsafe { FindWindowW(w!("KinshokoKeySink"), None) }.map_err(|e| e.to_string())?;
    let fg0 = unsafe { GetForegroundWindow() };
    let mut ok = fg0 == sink_hwnd;
    println!("前台是收键窗口：{ok}");
    let mut saved = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut saved);
    }
    app.shell.set_keys(PinKeys::new([
        Key::Letter('H'),
        Key::Letter('V'),
        Key::Letter('R'),
        Key::Escape,
    ]));
    let id = app.pins[0].id;
    let ours = |app: &App, p: POINT| {
        let h = unsafe { WindowFromPoint(p) }.0 as isize;
        [app.shell.hwnd(id, 0), app.shell.hwnd(id, 1)].contains(&Some(h))
    };
    let mut check = |what: &str, good: bool| {
        println!("{what}：{}", if good { "通过" } else { "不通过！" });
        ok &= good;
    };
    let fg_same = || unsafe { GetForegroundWindow() } == fg0;

    let c = app.pins[0].pin.rect();
    let center = (c.x + c.width as i32 / 2, c.y + c.height as i32 / 2);
    cursor(center.0, center.1);
    app.pump_for(80)?;
    check(
        "光标下是钉图",
        ours(
            app,
            POINT {
                x: center.0,
                y: center.1,
            },
        ),
    );

    let o0 = app.pins[0].pin.rect();
    send(&[mouse(MOUSEEVENTF_LEFTDOWN, 0)]);
    app.pump_for(30)?;
    for k in 1..=12 {
        cursor(center.0 + k * 5, center.1);
        app.pump_for(8)?;
    }
    send(&[mouse(MOUSEEVENTF_LEFTUP, 0)]);
    app.settle()?;
    let o1 = app.pins[0].pin.rect();
    check(
        &format!("拖动 60 px（挪了 {}）且前台没变", o1.x - o0.x),
        o1.x - o0.x == 60 && fg_same(),
    );

    let s0 = app.pins[0].pin.placement.scale;
    let swaps0 = app.swap_wait_ms.len();
    let c = app.pins[0].pin.rect();
    cursor(c.x + c.width as i32 / 2, c.y + c.height as i32 / 2);
    for _ in 0..3 {
        send(&[mouse(MOUSEEVENTF_WHEEL, 120)]);
        app.pump_for(30)?;
    }
    app.settle()?;
    let s1 = app.pins[0].pin.placement.scale;
    check(
        &format!(
            "滚轮 3 格（缩放 {s0:.3} → {s1:.3}，换窗 {} 次）且前台没变",
            app.swap_wait_ms.len() - swaps0
        ),
        s1 > s0 && fg_same(),
    );

    app.keys.clear();
    for vk in [b'H', b'V', b'R'] {
        key(vk);
        app.pump_for(60)?;
    }
    let got: Vec<Key> = app
        .keys
        .iter()
        .filter_map(|k| match k {
            PinInput::Key {
                key, repeat: false, ..
            } => Some(*key),
            _ => None,
        })
        .collect();
    check(
        &format!("光标在钉图上按 H/V/R：钉图收到 {got:?}，前台没变"),
        got == [Key::Letter('H'), Key::Letter('V'), Key::Letter('R')] && fg_same(),
    );

    let w = app.pins[0].window;
    let mid = w.y + w.height as i32 / 2;
    check("阴影最外一列命中钉图", ours(app, POINT { x: w.x, y: mid }));
    check(
        "窗口外一列不命中钉图",
        !ours(app, POINT { x: w.x - 1, y: mid }),
    );

    // 光标移到钉图外再按 H：键进前台程序。
    cursor(w.x + w.width as i32 + 200, mid);
    app.pump_for(60)?;
    app.keys.clear();
    key(b'H');
    app.pump_for(100)?;
    check("光标不在钉图上按 H：钉图没收到", app.keys.is_empty());

    app.shell.set_click_through(id, true);
    let c = app.pins[0].pin.rect();
    let center = (c.x + c.width as i32 / 2, c.y + c.height as i32 / 2);
    cursor(center.0, center.1);
    app.pump_for(100)?;
    check(
        "穿透打开时光标下是后面的程序",
        !ours(
            app,
            POINT {
                x: center.0,
                y: center.1,
            },
        ),
    );
    key(b'V');
    app.pump_for(100)?;
    check("穿透打开时按 V：钉图没收到", app.keys.is_empty());
    app.shell.set_click_through(id, false);
    app.redraw_visible(0)?;
    app.pump_for(100)?;
    check(
        "穿透关掉后光标下又是钉图",
        ours(
            app,
            POINT {
                x: center.0,
                y: center.1,
            },
        ),
    );

    unsafe {
        let _ = SetCursorPos(saved.x, saved.y);
        let _ = PostMessageW(Some(sink_hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
    }
    let mut out = String::new();
    if let Some(mut s) = sink.stdout.take() {
        let _ = s.read_to_string(&mut out);
    }
    let _ = sink.wait_timeout_or_kill(Duration::from_secs(5));
    let out = out.trim();
    // 钉图外按的 H、穿透时按的 V 进了前台；钉图上按的 H/V/R 没进。
    check(
        &format!("收键窗口收到 {out}（应为 H=1 V=1 R=0）"),
        out == "H=1 V=1 R=0",
    );
    Ok(ok)
}

trait WaitOrKill {
    fn wait_timeout_or_kill(&mut self, t: Duration) -> std::io::Result<()>;
}

impl WaitOrKill for std::process::Child {
    fn wait_timeout_or_kill(&mut self, t: Duration) -> std::io::Result<()> {
        let end = std::time::Instant::now() + t;
        while std::time::Instant::now() < end {
            if self.try_wait()?.is_some() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.kill()
    }
}
