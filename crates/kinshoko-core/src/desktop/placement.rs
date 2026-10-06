//! 新钉图摆在哪里。

/// 屏幕上的矩形，物理像素。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
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
