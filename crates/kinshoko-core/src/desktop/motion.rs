//! 覆盖窗口与钉图阴影的矩形（ADR 0011、#239）。
//!
//! 钉图菜单与截图框选是铺满一台显示器的 WebView 窗口，按 [`overlay_window`] 让出最下面一行；
//! 钉图自己的原生窗口盖满显示器时也同样让出（ADR 0013）。钉图四周的阴影那一圈算钉图的一部分
//! （[`pin_area`]）。

use super::ScreenRect;

/// 显示器 `monitor` 上的覆盖窗口（钉图菜单、截图框选，盖满显示器的钉图）：整台显示器，但让出最下面一行。
///
/// 只要有一个窗口整个盖住一台显示器，Windows 就当作有全屏程序在跑（`SHQueryUserNotificationState`
/// 报 `QUNS_BUSY`），与是否置顶、是否在前台、窗口区域多大都无关；少盖一行就不算。Wallpaper Engine
/// 等程序据此暂停（#230，ADR 0011）。
pub fn overlay_window(monitor: ScreenRect) -> ScreenRect {
    ScreenRect {
        height: monitor.height.saturating_sub(1),
        ..monitor
    }
}

/// 钉图四周阴影那一圈的宽度（物理像素，#239）。这一圈算钉图的一部分：显示阴影，也接点击和拖动。
pub const PIN_EDGE: u32 = 8;

/// 钉图占的范围：区域四周扩出 [`PIN_EDGE`]。超出坐标范围的部分截掉。
pub fn pin_area(region: ScreenRect) -> ScreenRect {
    let edge = i64::from(PIN_EDGE);
    let clamp = |v: i64| v.clamp(i64::from(i32::MIN), i64::from(i32::MAX));
    let left = clamp(i64::from(region.x) - edge);
    let top = clamp(i64::from(region.y) - edge);
    let right = clamp(i64::from(region.x) + i64::from(region.width) + edge);
    let bottom = clamp(i64::from(region.y) + i64::from(region.height) + edge);
    ScreenRect {
        x: left as i32,
        y: top as i32,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    }
}
