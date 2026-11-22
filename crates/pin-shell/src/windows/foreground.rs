//! 看前台切换：前台换成权限比本进程高的程序（例如以管理员身份运行）时，系统不把按键交给低级键盘
//! 钩子，钉图的快捷键都收不到（Esc 有时关不掉钉图）。只报给编排写日志，不改行为。

use std::cell::Cell;
use std::collections::VecDeque;
use std::ffi::c_void;
use std::sync::Mutex;

use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use windows::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation};
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
use windows::Win32::UI::WindowsAndMessaging::{
    EVENT_SYSTEM_FOREGROUND, GetWindowThreadProcessId, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS,
};
use windows::core::PWSTR;

/// 已投出的“前台换成权限更高的程序”消息各自的程序名，按投出的顺序；界面线程每收到一条取走最前面的。
static EXE: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

thread_local! {
    /// 前台换成权限更高的程序时调它（在装了观察的线程上），参数是程序文件名。
    static ON_ELEVATED: Cell<Option<fn(String)>> = const { Cell::new(None) };
    /// 上一次报过的进程，同一个程序反复回到前台不重复报。
    static LAST: Cell<u32> = const { Cell::new(0) };
}

/// 投消息之前记下这条消息的程序文件名。
pub(super) fn queue_exe(exe: String) {
    if let Ok(mut q) = EXE.lock() {
        q.push_back(exe);
    }
}

/// 取走最早一条消息的程序文件名。
pub(super) fn take_exe() -> String {
    EXE.lock()
        .ok()
        .and_then(|mut q| q.pop_front())
        .unwrap_or_default()
}

pub(super) struct Watch(HWINEVENTHOOK);

impl Watch {
    /// 在当前线程（要有消息循环）上看前台切换。本进程自己已提权时不用看，返回 None。
    pub fn start(on_elevated: fn(String)) -> Option<Watch> {
        // SAFETY：当前进程的伪句柄，不用关。
        if elevated(unsafe { GetCurrentProcess() }) != Some(false) {
            return None;
        }
        ON_ELEVATED.with(|f| f.set(Some(on_elevated)));
        // SAFETY：回调是本模块的 `extern "system"` 函数；进程外观察不需要模块句柄。
        let hook = unsafe {
            SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(on_foreground),
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            )
        };
        (!hook.is_invalid()).then_some(Watch(hook))
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        // SAFETY：`self.0` 是本线程装的观察。
        let _ = unsafe { UnhookWinEvent(self.0) };
    }
}

unsafe extern "system" fn on_foreground(
    _: HWINEVENTHOOK,
    _: u32,
    hwnd: HWND,
    _: i32,
    _: i32,
    _: u32,
    _: u32,
) {
    let mut pid = 0;
    // SAFETY：`pid` 由本函数持有。
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 || LAST.with(|l| l.replace(pid)) == pid {
        return;
    }
    // SAFETY：只查询；打不开（受保护或权限更高）时按权限更高算。
    let (higher, exe) = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
    {
        Ok(process) => {
            let out = (elevated(process) != Some(false), image_name(process));
            // SAFETY：上面打开的句柄。
            let _ = unsafe { CloseHandle(process) };
            out
        }
        Err(_) => (true, String::new()),
    };
    if !higher {
        return;
    }
    if let Some(f) = ON_ELEVATED.with(Cell::get) {
        f(exe);
    }
}

/// 进程是否已提权；查不到时 None。
fn elevated(process: HANDLE) -> Option<bool> {
    let mut token = HANDLE::default();
    // SAFETY：`token` 由本函数持有，用完关掉。
    unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.ok()?;
    let mut e = TOKEN_ELEVATION::default();
    let mut len = 0;
    // SAFETY：缓冲区是 `e`，大小与 TOKEN_ELEVATION 一致。
    let got = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            Some((&raw mut e).cast::<c_void>()),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
    };
    // SAFETY：上面打开的令牌。
    let _ = unsafe { CloseHandle(token) };
    got.ok()?;
    Some(e.TokenIsElevated != 0)
}

/// 程序名（不含目录和扩展名：运行日志把带扩展名的词当文件名抹掉）；查不到时为空。
fn image_name(process: HANDLE) -> String {
    let mut buf = [0u16; 260];
    let mut len = buf.len() as u32;
    // SAFETY：`buf` 由本函数持有，`len` 是它的长度。
    let ok = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
    };
    if ok.is_err() {
        return String::new();
    }
    let path = String::from_utf16_lossy(&buf[..len as usize]);
    std::path::Path::new(&path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default()
}
