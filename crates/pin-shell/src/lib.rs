//! 桌面钉图的平台层（ADR 0013）：唯一按平台写的部分，`unsafe` 只在各平台适配器里。
//!
//! 每张钉图两个窗口槽，同一时刻只有一个看得见。看得见的槽只平移（[`PinShell::translate`]）；尺寸要变时，
//! 编排把备用槽摆好（[`PinShell::stage`]）、让渲染层往它 Present，再 [`PinShell::swap`]：平台等合成器
//! 收下备用槽，用一次合成器提交让它看得见、让原来那个看不见，完成后 [`PinShell::pump`] 报
//! [`PinInput::Swapped`]。每一帧走哪条路由 `kinshoko_core::desktop::frame::plan` 决定。
//!
//! 接口里只有屏幕物理像素的矩形、可见性、输入和显示器描述，不出现 DPI 换算、颜色转换、图片。
//!
//! 适配器：
//! - [`windows::WinShell`]：Windows（DComp＋`WS_EX_NOREDIRECTIONBITMAP` 窗口，低级键盘钩子）；
//! - [`fake::FakeShell`]：记录调用顺序的假实现，给编排层的测试用。
//!
//! 与平台无关的规则（槽的状态、键盘钩子拦不拦、显示器变没变）放在 `slots`、`keys`、`displays`，
//! 两个适配器共用，单元测试覆盖。

mod displays;
pub mod fake;
mod keys;
mod slots;
mod types;
#[cfg(windows)]
#[allow(unsafe_code)]
pub mod windows;

pub use displays::{Display, scale_from_dpi};
pub use keys::{Key, PinKeys};
pub use kinshoko_core::desktop::ScreenRect;
pub use kinshoko_core::desktop::frame::{PointerButton, PointerKind};
pub use types::{HookEvent, PinCursor, PinId, PinInput, Pointer, PointerEvent, ShellError};

/// 平台层。所有方法都在界面线程上调（Windows 上是 Tauri 的主线程，窗口由它的消息循环分发）。
///
/// 实现保证：同一时刻只有一个槽看得见；看得见的槽只平移；`stage` 之后渲染层往备用槽的 Present
/// 与 `swap` 的可见性切换在同一帧生效。
pub trait PinShell {
    /// 新建一张钉图的两个槽（都还看不见），返回给渲染层建 Surface 用的目标，下标就是槽号。
    ///
    /// 目标在 [`PinShell::close`] 或 [`PinShell::retarget`] 之前有效。
    fn create(&mut self, pin: PinId) -> Result<[wgpu::SurfaceTargetUnsafe; 2], ShellError>;

    /// 设备丢失、渲染层重建之后，给同一对窗口换新的 Surface 目标。调用前先丢掉旧的 Surface；之后
    /// 往可见槽画一帧，再 [`PinShell::show`] 一次才会显示出来。
    fn retarget(&mut self, pin: PinId) -> Result<[wgpu::SurfaceTargetUnsafe; 2], ShellError>;

    /// 把看得见的槽放到 `rect` 并提交（第一次显示，或 `retarget` 之后）。渲染层先往它画好一帧。
    fn show(&mut self, pin: PinId, rect: ScreenRect);

    /// 平移看得见的槽；`rect` 的尺寸必须与它现在的相同。
    fn translate(&mut self, pin: PinId, rect: ScreenRect);

    /// 把备用槽摆到 `rect`、保持看不见，之后渲染层往它 Present。还没完成的 `swap` 随之作废，
    /// Present 之后要再 `swap` 一次。
    fn stage(&mut self, pin: PinId, rect: ScreenRect);

    /// 立即返回；合成器收下备用槽之后一次提交换上，[`PinShell::pump`] 报 [`PinInput::Swapped`]。
    /// 报出之前 [`PinShell::visible_slot`] 仍是原来的槽。
    fn swap(&mut self, pin: PinId);

    /// 看得见的槽号（0 或 1）；备用槽是另一个。
    fn visible_slot(&self, pin: PinId) -> usize;

    /// 放到所有钉图的最上面。
    fn raise(&mut self, pin: PinId);

    /// 点击穿透：打开时指针和键盘钩子都落到下面的程序，画面不变。
    fn set_click_through(&mut self, pin: PinId, on: bool);

    /// 指针在这张钉图上时的光标。
    fn set_cursor(&mut self, pin: PinId, cursor: PinCursor);

    /// 光标在某张钉图（含阴影）上时拦下哪些键；其余放行。菜单打开时传 [`PinKeys::none`]。
    fn set_keys(&mut self, keys: PinKeys);

    /// 现在的显示器（物理像素矩形、缩放比例、颜色配置文件）。
    fn displays(&self) -> Vec<Display>;

    /// 取出排队的输入与通知：指针、滚轮、按键、换窗完成、显示器变化。换下的槽也在这前后收起。
    fn pump(&mut self) -> Vec<PinInput>;

    /// 关掉这张钉图的两个槽。之后这个 `pin` 可以再 `create`。
    fn close(&mut self, pin: PinId);
}
