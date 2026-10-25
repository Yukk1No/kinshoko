//! 指针落在钉图的哪里、按住多久开菜单。坐标一律是屏幕物理像素；前端按 CSS 像素定的尺寸
//! （缩放区、按住时允许的抖动）乘以指针所在显示器的缩放比例。从前端 `pixels.ts`、`motion.ts` 搬来。

use crate::desktop::{PIN_EDGE, ScreenRect};

/// 一台显示器：物理像素矩形与缩放比例（1.0 为 100%）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Monitor {
    pub rect: ScreenRect,
    pub scale: f64,
}

/// 屏幕上 `at` 所在显示器的缩放比例；不在任何显示器上时为 1。
pub fn scale_at(monitors: &[Monitor], at: (f64, f64)) -> f64 {
    monitors
        .iter()
        .find(|m| {
            let r = m.rect;
            at.0 >= f64::from(r.x)
                && at.1 >= f64::from(r.y)
                && at.0 < f64::from(r.x) + f64::from(r.width)
                && at.1 < f64::from(r.y) + f64::from(r.height)
        })
        .map_or(1.0, |m| m.scale)
}

/// 指针落在钉图的哪里。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hit {
    /// 钉图内容：按住拖动。
    Content,
    /// 四周阴影那一圈（[`PIN_EDGE`]，#239）：等于按在钉图边上，同样拖动。
    Edge,
    /// 右下角的缩放区：按住拖动缩放，悬停时换光标。
    ZoomCorner,
    /// 阴影以外：下面的程序。
    Outside,
}

/// 缩放区最大这么多 CSS 像素，小钉图按比例缩小（内容短边的 [`ZOOM_CORNER_SHARE`]）。
pub const ZOOM_CORNER: f64 = 24.0;
/// 小钉图的缩放区占内容短边的这一部分，留出拖动的地方。
pub const ZOOM_CORNER_SHARE: f64 = 0.3;

/// 屏幕上的 `at` 落在内容为 `content` 的钉图的哪里。`display_scale` 是指针所在显示器的缩放比例
/// （[`scale_at`]）。缩放区从内容右下角往里量，向右下一直到阴影外缘。
pub fn hit(content: ScreenRect, at: (f64, f64), display_scale: f64) -> Hit {
    let (left, top) = (f64::from(content.x), f64::from(content.y));
    let (w, h) = (f64::from(content.width), f64::from(content.height));
    let (right, bottom) = (left + w, top + h);
    let edge = f64::from(PIN_EDGE);
    let (x, y) = at;
    if x < left - edge || y < top - edge || x >= right + edge || y >= bottom + edge {
        return Hit::Outside;
    }
    let zone = (ZOOM_CORNER * display_scale).min(ZOOM_CORNER_SHARE * w.min(h));
    if x >= right - zone && y >= bottom - zone {
        return Hit::ZoomCorner;
    }
    if x >= left && y >= top && x < right && y < bottom {
        Hit::Content
    } else {
        Hit::Edge
    }
}

/// 笔或触摸按住多久打开钉图菜单（毫秒）。
pub const HOLD_MS: u32 = 500;
/// 按住时允许的抖动（CSS 像素），再动就是拖动。
pub const HOLD_SLOP: f64 = 4.0;

/// 指针的种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerKind {
    Mouse,
    Pen,
    Touch,
}

/// 指针的按键。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerButton {
    /// 鼠标左键、笔尖、触摸。
    Primary,
    /// 鼠标右键、笔的侧键、触摸的第二键。
    Secondary,
}

/// 按下就打开菜单：鼠标右键、笔的侧键、触摸的第二键。同一次按下只开一次由编排记住。
///
/// 前端的 `pressOpensMenu` 只管笔和触摸，鼠标右键走 WebView 的 contextmenu 事件；原生窗口没有那个
/// 事件，鼠标右键也在这里。
pub fn press_opens_menu(button: PointerButton) -> bool {
    button == PointerButton::Secondary
}

/// 笔或触摸按住不动 [`HOLD_MS`] 打开菜单；动出 [`HOLD_SLOP`]（乘以显示器缩放比例 `display_scale`）就是拖动。
/// 鼠标不用长按。`start`、`now` 为屏幕物理像素。
pub fn held_for_menu(
    kind: PointerKind,
    start: (f64, f64),
    now: (f64, f64),
    elapsed_ms: u32,
    display_scale: f64,
) -> bool {
    if kind == PointerKind::Mouse {
        return false;
    }
    let moved = (now.0 - start.0).hypot(now.1 - start.1);
    moved <= HOLD_SLOP * display_scale && elapsed_ms >= HOLD_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    // 与前端 inZoomCorner 的用例相同（100% 下 CSS 像素就是物理像素）。
    #[test]
    fn the_zoom_corner_matches_the_frontend() {
        let c = rect(0, 0, 200, 100);
        assert_eq!(hit(c, (195.0, 95.0), 1.0), Hit::ZoomCorner);
        assert_eq!(hit(c, (100.0, 95.0), 1.0), Hit::Content);
        let small = rect(0, 0, 20, 20);
        assert_eq!(hit(small, (5.0, 5.0), 1.0), Hit::Content);
        assert_eq!(hit(small, (18.0, 18.0), 1.0), Hit::ZoomCorner);
    }

    // 与前端 onPin 的用例相同：内容和阴影那一圈都算钉图，再往外不算。
    #[test]
    fn the_shadow_ring_belongs_to_the_pin() {
        let c = rect(1100, 600, 200, 100);
        let e = f64::from(PIN_EDGE);
        assert_eq!(hit(c, (1150.0, 650.0), 1.0), Hit::Content);
        assert_eq!(hit(c, (1100.0 - e, 600.0 - e), 1.0), Hit::Edge);
        assert_eq!(hit(c, (1150.0, 700.0 + e - 0.5), 1.0), Hit::Edge);
        assert_eq!(
            hit(c, (1300.0 + e - 0.5, 700.0 + e - 0.5), 1.0),
            Hit::ZoomCorner
        );
        assert_eq!(hit(c, (1100.0 - e - 0.5, 650.0), 1.0), Hit::Outside);
        assert_eq!(hit(c, (1150.0, 700.0 + e), 1.0), Hit::Outside);
    }

    #[test]
    fn the_shadow_is_physical_pixels_at_any_scale() {
        let c = rect(1100, 600, 200, 100);
        let e = f64::from(PIN_EDGE);
        assert_eq!(hit(c, (1100.0 - e, 650.0), 2.0), Hit::Edge);
        assert_eq!(hit(c, (1100.0 - e - 0.5, 650.0), 2.0), Hit::Outside);
    }

    #[test]
    fn the_zoom_corner_grows_with_the_display_scale() {
        let c = rect(0, 0, 400, 400);
        // 100%：24 物理像素；200%：48 物理像素。
        assert_eq!(hit(c, (360.0, 360.0), 1.0), Hit::Content);
        assert_eq!(hit(c, (360.0, 360.0), 2.0), Hit::ZoomCorner);
    }

    // 多显示器：钉图跨 100% 与 150% 两台显示器。内容尺寸是物理像素，与显示器无关；缩放区按
    // 右下角所在那台的比例。
    #[test]
    fn a_pin_across_monitors_uses_the_scale_under_the_pointer() {
        let monitors = [
            Monitor {
                rect: rect(0, 0, 2560, 1440),
                scale: 1.0,
            },
            Monitor {
                rect: rect(2560, 0, 3840, 2160),
                scale: 1.5,
            },
        ];
        let c = rect(2300, 300, 400, 300);
        let corner = (2700.0 - 30.0, 600.0 - 30.0);
        assert_eq!(scale_at(&monitors, corner), 1.5);
        assert_eq!(hit(c, corner, scale_at(&monitors, corner)), Hit::ZoomCorner);
        assert_eq!(hit(c, corner, 1.0), Hit::Content);
        assert_eq!(scale_at(&monitors, (2400.0, 400.0)), 1.0);
        assert_eq!(scale_at(&monitors, (-5.0, 0.0)), 1.0);
    }

    // 与前端 pressOpensMenu、heldForMenu 的用例相同。
    #[test]
    fn menus_open_on_the_secondary_button_or_a_long_hold() {
        assert!(press_opens_menu(PointerButton::Secondary));
        assert!(!press_opens_menu(PointerButton::Primary));
        let at = (10.0, 10.0);
        assert!(held_for_menu(
            PointerKind::Pen,
            at,
            (12.0, 11.0),
            HOLD_MS,
            1.0
        ));
        assert!(!held_for_menu(
            PointerKind::Pen,
            at,
            (12.0, 11.0),
            HOLD_MS - 1,
            1.0
        ));
        assert!(!held_for_menu(
            PointerKind::Pen,
            at,
            (20.0, 10.0),
            HOLD_MS,
            1.0
        ));
        assert!(held_for_menu(PointerKind::Touch, at, at, HOLD_MS, 1.0));
        assert!(!held_for_menu(
            PointerKind::Mouse,
            at,
            at,
            HOLD_MS * 10,
            1.0
        ));
        // 抖动按 CSS 像素：150% 下允许 6 物理像素。
        assert!(held_for_menu(
            PointerKind::Pen,
            at,
            (16.0, 10.0),
            HOLD_MS,
            1.5
        ));
        assert!(!held_for_menu(
            PointerKind::Pen,
            at,
            (16.0, 10.0),
            HOLD_MS,
            1.0
        ));
    }
}
