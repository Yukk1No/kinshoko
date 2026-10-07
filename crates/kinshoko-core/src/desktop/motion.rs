//! 钉图动画时窗口的矩形（#64）。
//!
//! #7 原型每 12 毫秒改一次原生窗口的位置和尺寸，缩放一抖一抖、贴边滑动也生硬。这里的做法是：
//! 动画只在窗口里变换内容（页面上的 CSS 变换，跟着显示器刷新），原生窗口一次动画最多改两次——
//! 开始时（需要的话）放大到装得下整个过渡，结束时改成静止时的矩形。
//!
//! 屏幕外的部分本来看不见，过渡时窗口不为它们放大。

use super::ScreenRect;

/// 一次动画里窗口的矩形。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stage {
    /// 动画进行中。等于当前窗口时开始时不用改窗口。
    pub during: ScreenRect,
    /// 动画结束后，即静止时的矩形：平时等于钉图本身；收起时见 [`EdgeHide::tuck`](super::EdgeHide::tuck)。
    pub after: ScreenRect,
}

/// 钉图内容要从窗口 `window` 里的当前位置动到 `to`，结束后窗口停在 `rest`。
/// `monitors` 是全部显示器，用来去掉屏幕外看不见的部分。
///
/// 当前窗口已经盖住 `to` 在屏幕上的部分时，动画中不改窗口；否则放大到同时盖住两者在屏幕上的部分。
/// 内容的当前位置总在当前窗口里，所以放大后的窗口也装得下整个过渡。
pub fn stage(
    window: ScreenRect,
    to: ScreenRect,
    rest: ScreenRect,
    monitors: &[ScreenRect],
) -> Stage {
    let screen = monitors.iter().copied().reduce(|a, b| a.union(&b));
    let visible = |r: ScreenRect| match screen {
        Some(s) => r.intersect(&s),
        None => Some(r),
    };
    let during = match visible(to) {
        Some(needed) if !window.contains(&needed) => {
            visible(window).map_or(needed, |w| w.union(&needed))
        }
        _ => window,
    };
    Stage {
        during,
        after: rest,
    }
}
