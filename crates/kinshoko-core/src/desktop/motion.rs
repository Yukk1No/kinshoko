//! 钉图层与窗口区域的矩形（#64、#193）。
//!
//! #7 原型每 12 毫秒改一次原生窗口的位置和尺寸，缩放一抖一抖、贴边滑动也生硬；#64 改成动画只在
//! 窗口里变换内容，但放大时窗口原点仍要往左上移。原生窗口立刻到位，WebView2 却要晚 1～2 帧才按
//! 新原点重画，两个进程之间没有同步手段，于是每格滚轮都先抽搐、再闪烁（#193）。
//!
//! 所以钉图不再各有窗口：每台有钉图的显示器只有一个铺满屏幕的透明窗口（钉图层，[`layer_window`]），
//! 全部钉图都是层里的页面元素；层的窗口区域是各钉图区域的并集，把显示和点击限定在钉图本身。
//! 层的原生窗口一旦建好就不再动。缩放、贴边滑动、拖动和翻转都只在页面里移动内容，同时改钉图的
//! 区域：页面画到新位置之前先扩到旧区域与新内容的并集（[`widen`]），页面画完以后再缩回内容。
//! 区域只裁显示，不移动画面，所以扩大和缩小的先后错开一两帧也不会把画面裁掉或挪动。
//!
//! 钉图跨两台显示器时两个层都画它，各自只露出自己显示器上的部分（[`layers_for`]）；拖到另一台
//! 显示器上就是在拖动当中由另一个层接着画，不用换窗口。

use super::ScreenRect;

/// 钉图层要铺的显示器：区域碰到的每一台。区域不在任何显示器上时没有层，钉图看不见。
pub fn layers_for(region: ScreenRect, monitors: &[ScreenRect]) -> Vec<ScreenRect> {
    monitors
        .iter()
        .copied()
        .filter(|m| m.intersect(&region).is_some())
        .collect()
}

/// 显示器 `monitor` 上钉图层的窗口：整台显示器，但让出最下面一行。
///
/// 置顶窗口整个盖住一台显示器时，Windows 就当作有全屏程序在跑（`SHQueryUserNotificationState`
/// 报 `QUNS_BUSY`，通知被压下），窗口区域再小、窗口不在前台也一样；少盖一个像素就不算（本机实测）。
pub fn layer_window(monitor: ScreenRect) -> ScreenRect {
    ScreenRect {
        height: monitor.height.saturating_sub(1),
        ..monitor
    }
}

/// 钉图要变到 `to` 时，页面画到新位置之前的区域：盖住旧区域与新内容，过渡中的画面不会被裁掉。
/// 页面画完（动画结束、手势结束）后区域缩回内容。
pub fn widen(region: ScreenRect, to: ScreenRect) -> ScreenRect {
    region.union(&to)
}

/// 层的窗口区域：各钉图区域在层窗口里的部分，换成相对窗口左上角的左、上、右、下
/// （`SetWindowRgn` 要的）。不在窗口里的不算；一个都没有时为空。
pub fn layer_region(window: ScreenRect, regions: &[ScreenRect]) -> Vec<(i32, i32, i32, i32)> {
    regions
        .iter()
        .filter_map(|r| r.intersect(&window))
        .map(|r| {
            let (x, y) = (r.x - window.x, r.y - window.y);
            (
                x,
                y,
                x.saturating_add(r.width.min(i32::MAX as u32) as i32),
                y.saturating_add(r.height.min(i32::MAX as u32) as i32),
            )
        })
        .collect()
}
