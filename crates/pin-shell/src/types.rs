//! 接口上的数据：钉图编号、输入、光标、错误。

use std::fmt;

use kinshoko_core::desktop::frame::{PointerButton, PointerKind};

use crate::keys::Key;

/// 编排给每张钉图分的编号；平台层只拿它区分窗口组。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PinId(pub u64);

/// 平台报给编排的输入与通知。坐标一律是屏幕物理像素。
#[derive(Debug, Clone, PartialEq)]
pub enum PinInput {
    Pointer(Pointer),
    /// 滚轮。`notches` 向上（远离自己）为正，一格为 1，触控板可有小数。
    Wheel {
        pin: PinId,
        at: (i32, i32),
        notches: f64,
        ctrl: bool,
    },
    /// 光标在钉图上时按下了 [`PinShell::set_keys`](crate::PinShell::set_keys) 里的键（已拦下，前台程序收不到）。
    /// 按住不放的自动重复 `repeat` 为真。
    Key {
        pin: PinId,
        key: Key,
        shift: bool,
        repeat: bool,
    },
    /// [`PinShell::swap`](crate::PinShell::swap) 完成：备用槽已换上。`waited_ms` 是从调用 `swap` 到换上的时间。
    Swapped {
        pin: PinId,
        waited_ms: f64,
    },
    /// 显示器的数量、位置、缩放比例或颜色配置文件变了；重新取 [`PinShell::displays`](crate::PinShell::displays)。
    DisplaysChanged,
    /// 键盘钩子的状况，编排写进运行日志。
    KeyHook(HookEvent),
}

/// 鼠标、笔、触摸的一个事件。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pointer {
    pub pin: PinId,
    pub kind: PointerKind,
    pub at: (i32, i32),
    pub event: PointerEvent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerEvent {
    /// 按下：鼠标左右键、笔尖（按着侧键时为 [`PointerButton::Secondary`]）、触摸。
    Down(PointerButton),
    /// 移动：按着拖动，或悬停（鼠标、笔）。
    Move,
    Up(PointerButton),
    /// 按着的指针被系统收走（别的窗口抢了捕获、触摸被取消）：当作松开但不算点击。
    Cancel,
    /// 悬停的指针离开了钉图。
    Leave,
}

/// 指针在钉图上时的光标。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PinCursor {
    #[default]
    Arrow,
    /// 拖动移动。
    Move,
    /// 右下角缩放区。
    ResizeNwse,
}

/// 键盘钩子的状况。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    /// 回调送达得太晚（系统可能已把钩子移除），已重新安装。
    Reinstalled { late_ms: u32 },
    /// 装不上钩子：钉图的快捷键不可用。`code` 是系统错误码。
    Failed { code: u32 },
}

/// 平台层建窗口、建合成目标失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellError(pub String);

impl fmt::Display for ShellError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "钉图窗口：{}", self.0)
    }
}

impl std::error::Error for ShellError {}
