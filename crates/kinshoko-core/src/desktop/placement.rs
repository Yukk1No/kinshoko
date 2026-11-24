//! 新钉图摆在哪里。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 屏幕上的矩形，物理像素。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl ScreenRect {
    fn right(&self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    fn bottom(&self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }

    fn from_edges(left: i64, top: i64, right: i64, bottom: i64) -> ScreenRect {
        ScreenRect {
            x: left as i32,
            y: top as i32,
            width: (right - left).max(0) as u32,
            height: (bottom - top).max(0) as u32,
        }
    }

    /// 同时盖住两者的最小矩形。
    pub fn union(&self, other: &ScreenRect) -> ScreenRect {
        ScreenRect::from_edges(
            i64::from(self.x.min(other.x)),
            i64::from(self.y.min(other.y)),
            self.right().max(other.right()),
            self.bottom().max(other.bottom()),
        )
    }

    /// 两者重叠的部分；不重叠时为 `None`。
    pub fn intersect(&self, other: &ScreenRect) -> Option<ScreenRect> {
        let left = i64::from(self.x.max(other.x));
        let top = i64::from(self.y.max(other.y));
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());
        (right > left && bottom > top).then(|| ScreenRect::from_edges(left, top, right, bottom))
    }

    /// `other` 整个在这个矩形里。
    pub fn contains(&self, other: &ScreenRect) -> bool {
        other.x >= self.x
            && other.y >= self.y
            && other.right() <= self.right()
            && other.bottom() <= self.bottom()
    }
}

/// 最多错开几步；再挤也不会无休止地找下去。
const MAX_STEPS: i32 = 32;

/// 新钉图左上角的位置（外框，物理像素）。
///
/// `origin` 是图片原本在屏幕上的位置（截图选区，或剪贴板钉图时光标处）。新钉图向右下错开
/// `step`，让画师一眼看出钉上了（#7 反馈）；与已有钉图的左上角相距不到一步时再错开一步，
/// 不会完全重叠；整张留在 `monitor` 内，放不下时贴着显示器左上角。右下角挤满时改向左上错开。
pub fn place_new_pin(
    origin: ScreenRect,
    monitor: ScreenRect,
    pins: &[ScreenRect],
    step: i32,
) -> (i32, i32) {
    let step = step.max(1);
    let clamp = |x: i32, y: i32| {
        let right = monitor.x + monitor.width as i32 - origin.width as i32;
        let bottom = monitor.y + monitor.height as i32 - origin.height as i32;
        (x.min(right).max(monitor.x), y.min(bottom).max(monitor.y))
    };
    let crowded = |(x, y): (i32, i32)| {
        pins.iter()
            .any(|p| (p.x - x).abs() < step && (p.y - y).abs() < step)
    };
    let candidates = (1..=MAX_STEPS)
        .map(|k| clamp(origin.x + k * step, origin.y + k * step))
        .chain((1..=MAX_STEPS).map(|k| clamp(origin.x - k * step, origin.y - k * step)));
    let first = clamp(origin.x + step, origin.y + step);
    candidates
        .into_iter()
        .find(|&at| !crowded(at))
        .unwrap_or(first)
}
