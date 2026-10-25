//! 钉图的动画：缩放（[`ZOOM_MS`]）、贴边滑动（[`SLIDE_MS`]）与出现时的提示框（[`APPEAR_MS`]），
//! 都按时间求值。从前端 `motion.ts` 与 `desktop.css` 的 `pin-appear` 搬来。

use crate::desktop::ScreenRect;

/// 缩放动画的时长（毫秒）。滚轮连续几格时从当前位置接着动。
pub const ZOOM_MS: u32 = 140;
/// 贴边收起、滑出与回到原位的时长（毫秒）。
pub const SLIDE_MS: u32 = 200;
/// 新钉图出现时描一圈强调色的边，在这么久里渐隐（毫秒，#7 反馈）。
pub const APPEAR_MS: u32 = 900;

/// 缓出曲线：前快后慢，两端固定在 0 和 1。与前端 `easeOutCubic` 相同。
pub fn ease_out_cubic(t: f64) -> f64 {
    let u = 1.0 - t.clamp(0.0, 1.0);
    1.0 - u * u * u
}

/// 小数的屏幕矩形（物理像素），动画中途的位置。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RectF {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl RectF {
    /// 四条边各自取整到物理像素：相邻两帧的边不会因宽度取整差出一像素的抖动。
    pub fn snap(&self) -> ScreenRect {
        let left = self.x.round();
        let top = self.y.round();
        let right = (self.x + self.width).round();
        let bottom = (self.y + self.height).round();
        ScreenRect {
            x: left as i32,
            y: top as i32,
            width: (right - left).max(1.0) as u32,
            height: (bottom - top).max(1.0) as u32,
        }
    }
}

impl From<ScreenRect> for RectF {
    fn from(r: ScreenRect) -> RectF {
        RectF {
            x: f64::from(r.x),
            y: f64::from(r.y),
            width: f64::from(r.width),
            height: f64::from(r.height),
        }
    }
}

/// 钉图内容在屏幕上的位置随时间的变化。换目标时从此刻看到的位置接着动，不跳。
/// 与前端 `ContentMotion` 相同；时间是毫秒，起点任意。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContentMotion {
    from: RectF,
    to: RectF,
    start: f64,
    duration: f64,
}

impl ContentMotion {
    pub fn new(at: RectF, now: f64) -> ContentMotion {
        ContentMotion {
            from: at,
            to: at,
            start: now,
            duration: 0.0,
        }
    }

    pub fn retarget(&mut self, to: RectF, now: f64, duration: f64) {
        self.from = self.at(now);
        self.to = to;
        self.start = now;
        self.duration = duration;
    }

    pub fn at(&self, now: f64) -> RectF {
        if self.done(now) {
            return self.to;
        }
        let t = ease_out_cubic((now - self.start) / self.duration);
        let lerp = |a: f64, b: f64| a + (b - a) * t;
        RectF {
            x: lerp(self.from.x, self.to.x),
            y: lerp(self.from.y, self.to.y),
            width: lerp(self.from.width, self.to.width),
            height: lerp(self.from.height, self.to.height),
        }
    }

    pub fn done(&self, now: f64) -> bool {
        self.duration <= 0.0 || now - self.start >= self.duration
    }

    pub fn target(&self) -> RectF {
        self.to
    }
}

/// 出现提示框的不透明度：从 1 渐隐到 0，曲线同 CSS 的 `ease-out`（`cubic-bezier(0, 0, 0.58, 1)`）。
pub fn appear_ring(elapsed_ms: f64) -> f64 {
    1.0 - css_ease_out(elapsed_ms / f64::from(APPEAR_MS))
}

/// CSS `ease-out`：三次贝塞尔 (0,0)、(0,0)、(0.58,1)、(1,1)，按横坐标 `x` 求纵坐标。
fn css_ease_out(x: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    let bezier = |t: f64, p1: f64, p2: f64| {
        let u = 1.0 - t;
        3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t
    };
    // 横坐标随 t 单调，二分求 t。
    let (mut low, mut high) = (0.0, 1.0);
    for _ in 0..50 {
        let mid = (low + high) / 2.0;
        if bezier(mid, 0.0, 0.58) < x {
            low = mid;
        } else {
            high = mid;
        }
    }
    bezier((low + high) / 2.0, 0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> RectF {
        RectF {
            x,
            y,
            width,
            height,
        }
    }

    // 与前端 motion.test.ts 的 ContentMotion、easeOutCubic 用例相同。
    #[test]
    fn eases_out_to_the_target_and_stays() {
        let mut m = ContentMotion::new(rect(0.0, 0.0, 100.0, 50.0), 0.0);
        m.retarget(rect(100.0, 0.0, 200.0, 100.0), 0.0, 100.0);
        assert_eq!(m.at(0.0), rect(0.0, 0.0, 100.0, 50.0));
        let mid = m.at(50.0);
        assert!(mid.x > 50.0 && mid.x < 100.0);
        assert_eq!(m.at(100.0), rect(100.0, 0.0, 200.0, 100.0));
        assert_eq!(m.at(500.0), rect(100.0, 0.0, 200.0, 100.0));
        assert!(!m.done(99.0));
        assert!(m.done(100.0));
        assert_eq!(m.target(), rect(100.0, 0.0, 200.0, 100.0));
    }

    #[test]
    fn retargeting_mid_way_continues_from_what_is_seen() {
        let mut m = ContentMotion::new(rect(0.0, 0.0, 100.0, 100.0), 0.0);
        m.retarget(rect(100.0, 0.0, 100.0, 100.0), 0.0, 100.0);
        let seen = m.at(40.0);
        m.retarget(rect(-100.0, 0.0, 100.0, 100.0), 40.0, 100.0);
        assert_eq!(m.at(40.0), seen);
        assert_eq!(m.at(140.0), rect(-100.0, 0.0, 100.0, 100.0));
    }

    #[test]
    fn no_duration_jumps_to_the_target() {
        let mut m = ContentMotion::new(rect(0.0, 0.0, 100.0, 100.0), 0.0);
        m.retarget(rect(30.0, 40.0, 10.0, 10.0), 5.0, 0.0);
        assert_eq!(m.at(5.0), rect(30.0, 40.0, 10.0, 10.0));
        assert!(m.done(5.0));
    }

    #[test]
    fn ease_out_cubic_matches_the_frontend() {
        assert_eq!(ease_out_cubic(0.0), 0.0);
        assert_eq!(ease_out_cubic(1.0), 1.0);
        assert!((ease_out_cubic(0.5) - 0.875).abs() < 1e-12);
    }

    #[test]
    fn snapping_rounds_each_edge() {
        assert_eq!(
            rect(10.4, 20.6, 100.4, 50.2).snap(),
            ScreenRect {
                x: 10,
                y: 21,
                width: 101,
                height: 50
            }
        );
        assert_eq!(rect(5.0, 5.0, 0.1, 0.1).snap().width, 1);
    }

    #[test]
    fn the_appear_ring_fades_out_with_css_ease_out() {
        assert!((appear_ring(0.0) - 1.0).abs() < 1e-9);
        assert!(appear_ring(f64::from(APPEAR_MS)).abs() < 1e-9);
        assert!(appear_ring(f64::from(APPEAR_MS) * 2.0).abs() < 1e-9);
        // ease-out 前快后慢：一半时间时已褪去一大半；cubic-bezier(0,0,0.58,1) 在 x=0.5 处约 0.6846（x(t)=1.74t²-0.74t³=0.5 时 t≈0.6257，y=3t²-2t³）。
        assert!((appear_ring(f64::from(APPEAR_MS) / 2.0) - (1.0 - 0.6846)).abs() < 1e-3);
    }
}
