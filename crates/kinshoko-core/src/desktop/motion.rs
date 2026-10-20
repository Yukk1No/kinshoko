//! 钉图窗口与窗口区域的矩形（#64、#193）。
//!
//! #7 原型每 12 毫秒改一次原生窗口的位置和尺寸，缩放一抖一抖、贴边滑动也生硬；#64 改成动画只在
//! 窗口里变换内容（页面上的 CSS 变换，跟着显示器刷新），但放大时窗口原点仍要往左上移。原生窗口
//! 立刻到位，WebView2 却要晚 1～2 帧才按新原点重画，两个进程之间没有同步手段，于是每格滚轮都先
//! 抽搐（旧图整张往左上跳）、再闪烁（新位置被裁在旧尺寸里，#193）。
//!
//! 所以钉图窗口静止时就是它所在显示器那么大（[`pin_surface`]），显示和点击用窗口区域限定在钉图
//! 本身。缩放、贴边滑动、拖动和翻转都只在窗口里移动内容，同时改窗口区域：页面画到新位置之前先
//! 扩到旧区域与新内容的并集（[`Stage::during`]），页面画完以后再缩回内容（[`settle`]）。区域只裁
//! 显示，不移动画面，所以扩大和缩小的先后错开一两帧也不会把画面裁掉或挪动。
//!
//! 只有钉图碰到新的显示器时才要换窗口：拖动时当场换（[`Change::Drag`]），动画中只扩不缩，
//! 静止时只在不挪原点时缩回，免得静止的画面跳一下。

use super::ScreenRect;

/// 钉图窗口静止时的矩形：内容碰到的显示器的外接矩形，但不整个盖住任何一台显示器
/// （[`short_of_full_screen`]）。内容不在任何显示器上时就是内容本身。
pub fn pin_surface(content: ScreenRect, monitors: &[ScreenRect]) -> ScreenRect {
    monitors
        .iter()
        .filter(|m| m.intersect(&content).is_some())
        .copied()
        .reduce(|a, b| a.union(&b))
        .map_or(content, |w| short_of_full_screen(w, monitors))
}

/// 置顶窗口整个盖住一台显示器时，Windows 就当作有全屏程序在跑（`SHQueryUserNotificationState`
/// 报 `QUNS_BUSY`，通知被压下），窗口区域再小也一样；少盖一个像素就不算。先让出最下面一行
/// （通常在任务栏下面），多台显示器拼成的窗口还盖住某一台时再让出最上面一行，然后是左右两列。
fn short_of_full_screen(mut window: ScreenRect, monitors: &[ScreenRect]) -> ScreenRect {
    let covers = |w: &ScreenRect| monitors.iter().any(|m| w.contains(m));
    let trims: [fn(&mut ScreenRect); 4] = [
        |w| w.height = w.height.saturating_sub(1),
        |w| {
            w.y += 1;
            w.height = w.height.saturating_sub(1);
        },
        |w| w.width = w.width.saturating_sub(1),
        |w| {
            w.x += 1;
            w.width = w.width.saturating_sub(1);
        },
    ];
    for trim in trims {
        if !covers(&window) {
            break;
        }
        trim(&mut window);
    }
    window
}

/// 钉图内容怎样到新位置。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    /// 拖动：碰到新的显示器或离开一台时当场换窗口，换窗口的那一下落在拖动当中。
    Drag,
    /// 缩放、贴边滑动与翻转旋转：窗口装不下新位置时才扩大，等静止后再看能不能缩回。
    Stay,
}

/// 一次变化里的窗口与窗口区域（屏幕物理像素；区域为 `None` 时什么都不显示、不接点击）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stage {
    /// 原生窗口。等于当前窗口时不用改。
    pub window: ScreenRect,
    /// 页面画到新位置之前的窗口区域：盖住旧区域与新内容，过渡中的画面不会被裁掉。
    pub during: Option<ScreenRect>,
}

/// 内容要从当前位置（窗口 `window`、区域 `region`）变到 `to`。
pub fn stage(
    window: ScreenRect,
    region: Option<ScreenRect>,
    to: ScreenRect,
    change: Change,
    monitors: &[ScreenRect],
) -> Stage {
    let needed = pin_surface(to, monitors);
    let window = match change {
        Change::Drag => needed,
        Change::Stay if window.contains(&needed) => window,
        Change::Stay => window.union(&needed),
    };
    let during = region.map_or(to, |r| r.union(&to)).intersect(&window);
    Stage { window, during }
}

/// 静止以后的窗口与区域：区域缩回内容在窗口里的部分。窗口能缩回 [`pin_surface`] 且原点不动时
/// 缩回；要挪原点时留着大的，等下次拖动再换，免得静止的画面跳一下。
pub fn settle(
    window: ScreenRect,
    content: ScreenRect,
    monitors: &[ScreenRect],
) -> (ScreenRect, Option<ScreenRect>) {
    let fitted = pin_surface(content, monitors);
    let window = if !window.contains(&fitted) {
        window.union(&fitted)
    } else if (fitted.x, fitted.y) == (window.x, window.y) {
        fitted
    } else {
        window
    };
    (window, content.intersect(&window))
}

/// 窗口区域换成相对窗口左上角的坐标（`SetWindowRgn` 要的）：左、上、右、下。
pub fn region_in_window(window: ScreenRect, region: ScreenRect) -> (i32, i32, i32, i32) {
    let (x, y) = (region.x - window.x, region.y - window.y);
    (
        x,
        y,
        x.saturating_add(region.width.min(i32::MAX as u32) as i32),
        y.saturating_add(region.height.min(i32::MAX as u32) as i32),
    )
}
