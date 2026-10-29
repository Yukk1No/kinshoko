//! 每一帧怎么上屏（ADR 0013，[0 错位](../../../../../docs/discovery/pin-gpu-design/zero-mismatch.md)）。
//!
//! 看得见的窗口只许平移，不许改尺寸：
//! - 窗口没变：只重画（[`Step::Redraw`]），一次 Present 本身是原子的；
//! - 内容与窗口一起平移、像素不变（拖动）：只挪窗口（[`Step::Move`]）；
//! - 其余（尺寸要变）：在看不见的备用窗口上摆好、画好，再一次提交换上（[`Step::Swap`]）；
//! - 钉图不在任何显示器上：什么都不做（[`Step::Hidden`]）。
//!
//! 手势中换上来的是包络（[`envelope`]），之后放大约两倍以内、任意缩小都只需重画；停手后再换一次，
//! 收成刚好盖住钉图（[`window_for`]）。任何窗口都不整个盖住一台显示器（ADR 0011）。

use crate::desktop::{ScreenRect, pin_area};

/// 这一帧怎么上屏。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// 窗口不动，只重画内容。
    Redraw,
    /// 只把看得见的窗口平移到这里，内容像素不变。
    Move(ScreenRect),
    /// 在备用窗口上用这个矩形画好，再一次提交换上来。
    Swap(ScreenRect),
    /// 钉图不在任何显示器上，什么都不用画（窗口留着不动）。
    Hidden,
}

/// 钉图内容 `content` 需要的窗口：内容四周扩出 [`PIN_EDGE`](crate::desktop::PIN_EDGE)，裁到它碰到的
/// 显示器的外接矩形里；整个盖住某台显示器时让出一行或一列（[`uncover`]）。一台显示器都不碰时为
/// `None`。
pub fn window_for(content: ScreenRect, monitors: &[ScreenRect]) -> Option<ScreenRect> {
    let area = pin_area(content);
    let window = area.intersect(&bounds_of_touched(area, monitors)?)?;
    Some(uncover(window, None, monitors))
}

/// 手势中换窗口用的包络：以 `need` 为中心放大到两倍，夹在 `need` 碰到的显示器的外接矩形里，
/// 总是盖住 `need`，也不整个盖住任何一台显示器。
pub fn envelope(need: ScreenRect, monitors: &[ScreenRect]) -> ScreenRect {
    let (w, h) = (i64::from(need.width), i64::from(need.height));
    let grown = rect_from_edges(
        i64::from(need.x) - w / 2,
        i64::from(need.y) - h / 2,
        i64::from(need.x) + w + w / 2,
        i64::from(need.y) + h + h / 2,
    );
    let window = bounds_of_touched(need, monitors)
        .and_then(|b| grown.intersect(&b))
        .map_or(need, |e| e.union(&need));
    uncover(window, Some(need), monitors)
}

/// 这一帧怎么上屏。`window` 是当前看得见的窗口，`drawn` 是上一次画进它的内容矩形，`content` 是
/// 这一帧的内容矩形。`gesture` 为真时（滚轮、动画、拖动，停手前）要换窗口就换到包络，
/// 为假时窗口收成刚好盖住钉图。
pub fn plan(
    window: ScreenRect,
    drawn: ScreenRect,
    content: ScreenRect,
    monitors: &[ScreenRect],
    gesture: bool,
) -> Step {
    let Some(need) = window_for(content, monitors) else {
        return Step::Hidden;
    };
    if need == window {
        return Step::Redraw;
    }
    // 纯平移：内容尺寸不变，窗口尺寸不变（没被屏幕边裁得不一样），内容在窗口里的位置不变。
    let same_size = |a: ScreenRect, b: ScreenRect| a.width == b.width && a.height == b.height;
    let dx = i64::from(content.x) - i64::from(drawn.x);
    let dy = i64::from(content.y) - i64::from(drawn.y);
    if same_size(content, drawn)
        && same_size(need, window)
        && i64::from(need.x) - i64::from(window.x) == dx
        && i64::from(need.y) - i64::from(window.y) == dy
    {
        return Step::Move(need);
    }
    if gesture && window.contains(&need) {
        return Step::Redraw;
    }
    Step::Swap(if gesture {
        envelope(need, monitors)
    } else {
        need
    })
}

/// `window` 整个盖住某台显示器时，把它的一条边收进那台显示器一行（或一列），直到一台都不盖满。
///
/// 先选最下面一行（ADR 0011），其次上、右、左；窗口下边伸到别的显示器上（例如左屏矮、右屏高）时，
/// 收下边会裁掉那台显示器上的一大块，于是改收与这台显示器重合的另一条边；优先只损失那台显示器一行的边（窗口的这条边正好
/// 与显示器的边重合），收边时不切掉 `keep`。`keep` 本身不盖满任何显示器时总有可收的边。
/// 宽或高不到 2 像素的显示器不算。
pub fn uncover(
    mut window: ScreenRect,
    keep: Option<ScreenRect>,
    monitors: &[ScreenRect],
) -> ScreenRect {
    while let Some(m) = monitors
        .iter()
        .find(|m| m.width >= 2 && m.height >= 2 && window.contains(m))
    {
        let (left, top, right, bottom) = edges(window);
        let (ml, mt, mr, mb) = edges(*m);
        // 每条边：收边后的窗口，以及这条边是否正好与显示器的边重合（只损失一行或一列）。
        let candidates = [
            (rect_from_edges(left, top, right, mb - 1), bottom == mb),
            (rect_from_edges(left, mt + 1, right, bottom), top == mt),
            (rect_from_edges(left, top, mr - 1, bottom), right == mr),
            (rect_from_edges(ml + 1, top, right, bottom), left == ml),
        ];
        let keeps = |r: &ScreenRect| keep.is_none_or(|k| r.contains(&k));
        window = candidates
            .iter()
            .find(|(r, flush)| *flush && keeps(r))
            .or_else(|| candidates.iter().find(|(r, _)| keeps(r)))
            .unwrap_or(&candidates[0])
            .0;
    }
    window
}

/// `area` 碰到的显示器的外接矩形；一台都不碰时为 `None`。
fn bounds_of_touched(area: ScreenRect, monitors: &[ScreenRect]) -> Option<ScreenRect> {
    monitors
        .iter()
        .filter(|m| m.intersect(&area).is_some())
        .copied()
        .reduce(|a, b| a.union(&b))
}

fn edges(r: ScreenRect) -> (i64, i64, i64, i64) {
    (
        i64::from(r.x),
        i64::from(r.y),
        i64::from(r.x) + i64::from(r.width),
        i64::from(r.y) + i64::from(r.height),
    )
}

/// 由左、上、右、下得到矩形，夹在 `i32` 坐标范围里。
fn rect_from_edges(left: i64, top: i64, right: i64, bottom: i64) -> ScreenRect {
    let clamp = |v: i64| v.clamp(i64::from(i32::MIN), i64::from(i32::MAX));
    let (left, top) = (clamp(left), clamp(top));
    let (right, bottom) = (clamp(right).max(left), clamp(bottom).max(top));
    ScreenRect {
        x: left as i32,
        y: top as i32,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::PIN_EDGE;
    use crate::desktop::frame::test_rng::Rng;

    const fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    /// 左、上、右、下。
    fn sides(r: ScreenRect) -> (i64, i64, i64, i64) {
        let (x, y) = (i64::from(r.x), i64::from(r.y));
        (x, y, x + i64::from(r.width), y + i64::from(r.height))
    }

    const SCREEN: ScreenRect = rect(0, 0, 2560, 1440);
    const ONE: &[ScreenRect] = &[SCREEN];

    fn covers_a_monitor(window: ScreenRect, monitors: &[ScreenRect]) -> bool {
        monitors.iter().any(|m| window.contains(m))
    }

    #[test]
    fn the_window_is_the_pin_plus_its_shadow() {
        let c = rect(100, 100, 400, 600);
        let e = PIN_EDGE as i32;
        assert_eq!(
            window_for(c, ONE),
            Some(rect(
                100 - e,
                100 - e,
                400 + 2 * PIN_EDGE,
                600 + 2 * PIN_EDGE
            ))
        );
    }

    #[test]
    fn a_pin_off_every_monitor_has_no_window() {
        assert_eq!(window_for(rect(3000, 100, 100, 100), ONE), None);
        assert_eq!(
            plan(
                rect(0, 0, 10, 10),
                rect(0, 0, 10, 10),
                rect(3000, 0, 10, 10),
                ONE,
                true
            ),
            Step::Hidden
        );
    }

    // 原型 8 个场景之一：停手后窗口刚好盖住钉图，再来一帧只重画。
    #[test]
    fn settled_window_hugs_the_pin() {
        let c = rect(100, 100, 400, 600);
        let w = window_for(c, ONE).unwrap();
        assert_eq!(plan(w, c, c, ONE, false), Step::Redraw);
        assert_eq!(plan(w, c, c, ONE, true), Step::Redraw);
    }

    // 原型场景：在屏幕内拖动只挪窗口。
    #[test]
    fn dragging_on_screen_only_moves_the_window() {
        let c = rect(100, 100, 400, 600);
        let w = window_for(c, ONE).unwrap();
        let to = rect(107, 95, 400, 600);
        assert_eq!(
            plan(w, c, to, ONE, true),
            Step::Move(rect(99, 87, 416, 616))
        );
        assert_eq!(
            plan(w, c, to, ONE, false),
            Step::Move(rect(99, 87, 416, 616))
        );
    }

    // 原型场景：拖出屏幕边时窗口被裁得不一样，不能只挪窗口。
    #[test]
    fn dragging_past_the_screen_edge_redraws_or_swaps() {
        let c = rect(-20, 100, 400, 600);
        let w = window_for(c, ONE).unwrap();
        // 再往左拖：窗口被裁得更窄；内容还在窗口里，手势中重画即可。
        let to = rect(-50, 100, 400, 600);
        assert_eq!(plan(w, c, to, ONE, true), Step::Redraw);
        // 拖回来时需要更宽的窗口：换窗口。
        let back = rect(-10, 100, 400, 600);
        assert!(matches!(plan(w, to, back, ONE, true), Step::Swap(_)));
        // 停手时收成刚好盖住钉图。
        assert_eq!(
            plan(w, c, to, ONE, false),
            Step::Swap(window_for(to, ONE).unwrap())
        );
    }

    // 原型场景：一格一格放大，第一格换到包络，之后都在包络里重画；停手收回。
    #[test]
    fn zooming_in_swaps_once_then_redraws_inside_the_envelope() {
        let content = |k: u32| {
            // 以 (1100, 550) 为中心每格 ×1.1。
            let s = 1.1f64.powi(k as i32);
            let (w, h) = (200.0 * s, 300.0 * s);
            rect(
                (1100.0 - w / 2.0).round() as i32,
                (550.0 - h / 2.0).round() as i32,
                w.round() as u32,
                h.round() as u32,
            )
        };
        let mut window = window_for(content(0), ONE).unwrap();
        let mut drawn = content(0);
        let mut swaps = 0;
        for k in 1..=7 {
            match plan(window, drawn, content(k), ONE, true) {
                Step::Swap(r) => {
                    swaps += 1;
                    window = r;
                }
                Step::Redraw => {}
                s => panic!("{s:?}"),
            }
            assert!(window.contains(&window_for(content(k), ONE).unwrap()));
            drawn = content(k);
        }
        // 1.1^7 ≈ 1.95：第一格换到两倍大的包络，之后都在包络里。
        assert_eq!(swaps, 1);
        let settled = window_for(content(7), ONE).unwrap();
        assert_eq!(
            plan(window, drawn, content(7), ONE, false),
            Step::Swap(settled)
        );
    }

    // 原型场景：钉图比屏幕大时窗口是整台显示器让出最下面一行，之后平移、缩放都只重画。
    #[test]
    fn a_pin_bigger_than_the_screen_uses_the_screen_less_a_row_and_redraws() {
        let big = rect(-3000, -5000, 8000, 12000);
        let w = window_for(big, ONE).unwrap();
        assert_eq!(w, crate::desktop::overlay_window(SCREEN));
        let zoomed = rect(-3300, -5500, 8800, 13200);
        assert_eq!(plan(w, big, zoomed, ONE, true), Step::Redraw);
        assert_eq!(plan(w, big, zoomed, ONE, false), Step::Redraw);
        let dragged = rect(-2990, -4990, 8000, 12000);
        assert_eq!(plan(w, big, dragged, ONE, true), Step::Redraw);
    }

    // 原型场景：包络不出显示器。
    #[test]
    fn the_envelope_stays_on_the_monitor() {
        let need = rect(2000, 1000, 500, 400);
        let e = envelope(need, ONE);
        assert!(SCREEN.contains(&e));
        assert!(e.contains(&need));
        assert!(!covers_a_monitor(e, ONE));
        // 放大到两倍：中心不动，各边外扩一半。
        let small = rect(1000, 600, 100, 80);
        assert_eq!(envelope(small, ONE), rect(950, 560, 200, 160));
    }

    #[test]
    fn the_envelope_of_a_pin_on_the_bottom_row_gives_up_another_edge() {
        // 钉图碰到显示器最下面一行，两倍包络盖满显示器：让出别的边，不切掉钉图。
        let need = rect(100, 400, 2000, 1040);
        let e = envelope(need, ONE);
        assert!(e.contains(&need));
        assert!(!covers_a_monitor(e, ONE));
    }

    // 多显示器：左边 100%（2560×1440），右边 150%（3840×2160），顶端对齐。
    const LEFT: ScreenRect = rect(0, 0, 2560, 1440);
    const RIGHT: ScreenRect = rect(2560, 0, 3840, 2160);
    const TWO: &[ScreenRect] = &[LEFT, RIGHT];

    #[test]
    fn a_pin_across_two_monitors_has_one_window_over_both() {
        let c = rect(2400, 300, 400, 300);
        let w = window_for(c, TWO).unwrap();
        assert_eq!(w, pin_area(c));
        // 从左屏拖到右屏：窗口尺寸不变，只挪窗口；缩放比例不同也不改尺寸（物理像素）。
        let to = rect(2700, 300, 400, 300);
        assert_eq!(plan(w, c, to, TWO, true), Step::Move(pin_area(to)));
    }

    #[test]
    fn a_pin_across_two_monitors_is_clipped_to_the_desktop() {
        // 左屏比右屏矮：钉图伸到左屏下面的空白处，那一块不在任何显示器上，但窗口是一个矩形，
        // 裁到两台显示器的外接矩形。
        let c = rect(2000, 1300, 1000, 1000);
        let w = window_for(c, TWO).unwrap();
        let (_, _, right, bottom) = sides(w);
        assert_eq!(w.x, 2000 - PIN_EDGE as i32);
        assert_eq!(bottom, 2160);
        assert_eq!(right, 3000 + i64::from(PIN_EDGE));
        // 只碰左屏时裁到左屏。
        let only_left = window_for(rect(2400, 1300, 100, 1000), TWO).unwrap();
        assert_eq!(sides(only_left).3, 1440);
    }

    #[test]
    fn a_huge_pin_over_two_monitors_leaves_a_row_on_each() {
        let big = rect(-1000, -1000, 9000, 4000);
        let w = window_for(big, TWO).unwrap();
        assert!(!covers_a_monitor(w, TWO));
        // 每台显示器最多让出一行或一列。
        for m in TWO {
            assert!(w.contains(&rect(m.x + 1, m.y + 1, m.width - 2, m.height - 2)));
        }
    }

    #[test]
    fn a_short_monitor_beside_a_tall_one_gives_up_its_top_row() {
        // 左屏比右屏矮、顶端对齐，钉图盖满左屏并伸进右屏：窗口下边在右屏里，收到左屏最下面一行
        // 会把右屏那一块裁掉。让出左屏最上面一行只损失一行（右屏顶行也随之让出），仍不盖满。
        let w = window_for(rect(-50, -50, 3000, 3000), TWO).unwrap();
        assert_eq!(w, rect(0, 1, 2560 + 3000 - 50 - 2560 + PIN_EDGE, 2159));
        assert!(!covers_a_monitor(w, TWO));
    }

    #[test]
    fn monitors_side_by_side_of_equal_height_lose_only_the_bottom_row() {
        let a = rect(0, 0, 1920, 1080);
        let b = rect(1920, 0, 1920, 1080);
        let w = window_for(rect(-50, -50, 4000, 2000), &[a, b]).unwrap();
        assert_eq!(w, rect(0, 0, 3840, 1079));
    }

    /// 随机的显示器排布：1～3 台，横排、竖排或错开。
    fn monitors(rng: &mut Rng) -> Vec<ScreenRect> {
        let n = rng.range(1, 4) as usize;
        let mut out = Vec::new();
        let mut x = rng.range(-4000, 4000) as i32;
        let mut y = rng.range(-3000, 3000) as i32;
        for _ in 0..n {
            let m = rect(x, y, rng.range(2, 4000) as u32, rng.range(2, 3000) as u32);
            out.push(m);
            if rng.range(0, 2) == 0 {
                x += m.width as i32;
                y += rng.range(-(m.height as i64), m.height as i64) as i32;
            } else {
                y += m.height as i32;
                x += rng.range(-(m.width as i64), m.width as i64) as i32;
            }
        }
        out
    }

    fn content(rng: &mut Rng) -> ScreenRect {
        rect(
            rng.range(-12000, 12000) as i32,
            rng.range(-12000, 12000) as i32,
            rng.range(1, 20000) as u32,
            rng.range(1, 20000) as u32,
        )
    }

    // 性质：任何输入下 window_for、envelope、plan 给出的窗口都不整个盖住一台显示器。
    #[test]
    fn no_window_ever_covers_a_whole_monitor() {
        let mut rng = Rng::new(0x5eed_0281);
        for _ in 0..20_000 {
            let ms = monitors(&mut rng);
            let c = content(&mut rng);
            let Some(need) = window_for(c, &ms) else {
                assert!(ms.iter().all(|m| m.intersect(&pin_area(c)).is_none()));
                continue;
            };
            assert!(!covers_a_monitor(need, &ms), "{c:?} {ms:?} -> {need:?}");
            assert!(pin_area(c).contains(&need));
            let e = envelope(need, &ms);
            assert!(!covers_a_monitor(e, &ms), "{need:?} {ms:?} -> {e:?}");
            assert!(e.contains(&need));
            let window = window_for(content(&mut rng), &ms).unwrap_or(need);
            for gesture in [false, true] {
                match plan(window, c, content(&mut rng), &ms, gesture) {
                    Step::Move(r) | Step::Swap(r) => {
                        assert!(!covers_a_monitor(r, &ms), "{r:?} {ms:?}");
                    }
                    Step::Redraw | Step::Hidden => {}
                }
            }
        }
    }

    // 边界穷举：钉图四条边分别落在显示器边缘附近（±PIN_EDGE±1）的所有组合。
    #[test]
    fn no_window_covers_a_monitor_at_any_edge_combination() {
        let e = PIN_EDGE as i32;
        let near = |lo: i32, hi: i32| {
            let mut v = Vec::new();
            for base in [lo, hi] {
                for d in [-e - 1, -e, -e + 1, -1, 0, 1, e - 1, e, e + 1] {
                    v.push(base + d);
                }
            }
            v
        };
        for ms in [ONE.to_vec(), TWO.to_vec()] {
            let all = ms.iter().copied().reduce(|a, b| a.union(&b)).unwrap();
            let (l, t, r, b) = sides(all);
            for &x0 in &near(l as i32, r as i32) {
                for &x1 in &near(l as i32, r as i32) {
                    for &y0 in &near(t as i32, b as i32) {
                        for &y1 in &near(t as i32, b as i32) {
                            if x1 <= x0 || y1 <= y0 {
                                continue;
                            }
                            let c = rect(x0, y0, (x1 - x0) as u32, (y1 - y0) as u32);
                            if let Some(w) = window_for(c, &ms) {
                                assert!(!covers_a_monitor(w, &ms), "{c:?} -> {w:?}");
                                assert!(!covers_a_monitor(envelope(w, &ms), &ms));
                            }
                        }
                    }
                }
            }
        }
    }
}
