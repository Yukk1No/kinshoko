//! 钉图的槽窗口与宿主窗口。
//!
//! 槽窗口：`WS_POPUP`，`WS_EX_NOREDIRECTIONBITMAP`（只有 DComp 内容）、`WS_EX_TOOLWINDOW`（不进
//! 任务栏和 Alt+Tab，Chromium 的遮挡判定也跳过它，#275）、`WS_EX_TOPMOST`、`WS_EX_NOACTIVATE`。
//! 不经 tao 建：tao 的窗口带自己的样式与重定向位图。在界面线程上 `CreateWindowExW`，由同一线程的
//! 消息循环（Tauri 里是 tao 的）分发。
//!
//! 宿主窗口：看不见的顶层窗口（不是 message-only，否则收不到 `WM_DISPLAYCHANGE` 这类广播），收
//! 时钟线程、钩子线程投来的消息。

use std::cell::Cell;

use windows::Win32::Foundation::{ERROR_CLASS_ALREADY_EXISTS, GetLastError, HWND};
use windows::Win32::Graphics::DirectComposition::{
    IDCompositionDesktopDevice, IDCompositionTarget, IDCompositionVisual3,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, GWLP_USERDATA, GetClassNameW, GetWindowLongPtrW, HCURSOR,
    IDC_ARROW, IDC_SIZEALL, IDC_SIZENWSE, LoadCursorW, RegisterClassExW, SetWindowLongPtrW,
    WNDCLASSEXW, WNDPROC, WS_EX_NOACTIVATE, WS_EX_NOREDIRECTIONBITMAP, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_POPUP,
};
use windows::core::{Interface, PCWSTR, w};

use crate::PointerButton;
use crate::types::{PinCursor, PinId};

pub(super) const SLOT_CLASS: PCWSTR = w!("KinshokoPinSlot");
pub(super) const HOST_CLASS: PCWSTR = w!("KinshokoPinHost");

/// 每个槽窗口自己的数据，指针放在 `GWLP_USERDATA`，窗口销毁时释放。只用 `Cell`：窗口过程可能在
/// 平台层的方法里被同步调用（`SetWindowPos`、`SetCapture` 发出的消息），不能借用平台层的状态。
pub(super) struct SlotData {
    pub pin: PinId,
    pub cursor: Cell<HCURSOR>,
    /// 有指针按在这个槽上（鼠标捕获、笔或触摸接触中）：换下后要等松开才收起。
    pub pressed: Cell<bool>,
    /// 按下时是哪个键，松开时照报。
    pub button: Cell<PointerButton>,
    /// 已请求 `WM_MOUSELEAVE`。
    pub tracking: Cell<bool>,
}

/// 一个槽：窗口与它的 DComp 目标、根 visual。
pub(super) struct Slot {
    pub hwnd: HWND,
    pub target: IDCompositionTarget,
    pub visual: IDCompositionVisual3,
    /// 窗口当前是显示着的（不透明度为 0 时也算）。
    pub shown: bool,
}

impl Slot {
    pub fn surface_target(&self) -> wgpu::SurfaceTargetUnsafe {
        wgpu::SurfaceTargetUnsafe::CompositionVisual(self.visual.as_raw())
    }
}

/// 注册两个窗口类；已注册过不算错。
pub(super) fn register(slot_proc: WNDPROC, host_proc: WNDPROC) -> windows::core::Result<()> {
    // SAFETY：类名是静态串，窗口过程是本模块的 `extern "system"` 函数。
    unsafe {
        let instance = GetModuleHandleW(None)?;
        for (name, proc) in [(SLOT_CLASS, slot_proc), (HOST_CLASS, host_proc)] {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: proc,
                hInstance: instance.into(),
                hCursor: LoadCursorW(None, IDC_ARROW)?,
                lpszClassName: name,
                ..Default::default()
            };
            if RegisterClassExW(&class) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS {
                return Err(windows::core::Error::from_thread());
            }
        }
        Ok(())
    }
}

pub(super) fn create_host() -> windows::core::Result<HWND> {
    // SAFETY：窗口类已注册；不带创建参数。
    unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            HOST_CLASS,
            w!("Kinshoko pins"),
            WS_POPUP,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(GetModuleHandleW(None)?.into()),
            None,
        )
    }
}

/// 建一个槽：窗口（还不显示）、DComp 目标与根 visual。`opacity` 是 visual 的初始不透明度。
pub(super) fn create_slot(
    dcomp: &IDCompositionDesktopDevice,
    pin: PinId,
    opacity: f32,
) -> windows::core::Result<Slot> {
    let data = Box::new(SlotData {
        pin,
        cursor: Cell::new(cursor(PinCursor::Arrow)),
        pressed: Cell::new(false),
        button: Cell::new(PointerButton::Primary),
        tracking: Cell::new(false),
    });
    // SAFETY：窗口类已注册。建好之后再把 `data` 的所有权交给窗口（GWLP_USERDATA，WM_NCDESTROY
    // 收回）；在那之前窗口过程看到的是空指针，按普通窗口处理。
    unsafe {
        let hwnd = CreateWindowExW(
            WS_EX_NOREDIRECTIONBITMAP | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE,
            SLOT_CLASS,
            w!("Kinshoko pin"),
            WS_POPUP,
            0,
            0,
            1,
            1,
            None,
            None,
            Some(GetModuleHandleW(None)?.into()),
            None,
        )?;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(data) as isize);
        let composed = dcomp
            .CreateTargetForHwnd(hwnd, true)
            .and_then(|target| Ok((new_visual(dcomp, &target, opacity)?, target)));
        match composed {
            Ok((visual, target)) => Ok(Slot {
                hwnd,
                target,
                visual,
                shown: false,
            }),
            Err(e) => {
                let _ = DestroyWindow(hwnd);
                Err(e)
            }
        }
    }
}

/// 新建根 visual 挂到 `target` 上（不提交）。
pub(super) fn new_visual(
    dcomp: &IDCompositionDesktopDevice,
    target: &IDCompositionTarget,
    opacity: f32,
) -> windows::core::Result<IDCompositionVisual3> {
    // SAFETY：设备与目标都有效；改动在下一次 Commit 时生效。
    unsafe {
        let visual: IDCompositionVisual3 = dcomp.CreateVisual()?.cast()?;
        visual.SetOpacity2(opacity)?;
        target.SetRoot(&visual)?;
        Ok(visual)
    }
}

/// 槽窗口的数据；刚建好、还没交出数据时为 None。
///
/// # Safety
/// `hwnd` 是本线程的槽窗口。返回的引用在窗口销毁（WM_NCDESTROY）前有效，调用方不能留到那之后。
pub(super) unsafe fn slot_data<'a>(hwnd: HWND) -> Option<&'a SlotData> {
    // SAFETY：槽窗口的 GWLP_USERDATA 是 `create_slot` 交出的 Box 指针，或 0。
    unsafe { (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const SlotData).as_ref() }
}

/// 任意窗口（例如光标下的那个）是不是本线程的槽窗口；是就给出它的数据。
///
/// # Safety
/// 同 [`slot_data`]。
pub(super) unsafe fn any_slot_data<'a>(hwnd: HWND) -> Option<&'a SlotData> {
    let mut class = [0u16; 32];
    // SAFETY：缓冲区由本函数持有；句柄无效时返回 0。
    let n = unsafe { GetClassNameW(hwnd, &mut class) } as usize;
    // SAFETY：静态类名。
    let name = unsafe { SLOT_CLASS.as_wide() };
    // SAFETY：类名对上，就是槽窗口（类只在本模块注册）。
    (n == name.len() && class[..n] == *name)
        .then(|| unsafe { slot_data(hwnd) })
        .flatten()
}

pub(super) fn cursor(c: PinCursor) -> HCURSOR {
    let id = match c {
        PinCursor::Arrow => IDC_ARROW,
        PinCursor::Move => IDC_SIZEALL,
        PinCursor::ResizeNwse => IDC_SIZENWSE,
    };
    // SAFETY：系统光标，不用释放。
    unsafe { LoadCursorW(None, id) }.unwrap_or_default()
}
