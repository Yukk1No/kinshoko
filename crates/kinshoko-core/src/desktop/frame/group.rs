//! 整组移动与缩放（#198）：桌面上的参考组的钉图一起动。
//!
//! 手势开始时记下每张没锁定的钉图的位置与缩放（[`GroupGrab::new`]），之后每一步都从开始时算：
//! 位置只能是整数像素，每步各自取整，误差不会累积。锁定的钉图不在里面，原地不动。
//!
//! 缩放以屏幕上的一点为锚点（滚轮取光标），各钉图的位置和大小按同一比例变；比例限制在每张钉图
//! 都还在 [`SavedPin::clamp_scale`] 以内，碰到限制时整组一起停住，不会只有一张不跟着变。

use crate::desktop::SavedPin;

#[derive(Debug, Clone, PartialEq)]
struct Start {
    id: String,
    x: f64,
    y: f64,
    scale: f64,
    /// 这张钉图允许的缩放比例范围（相对开始时）。
    factor: (f64, f64),
}

/// 一次整组手势开始时的样子。
#[derive(Debug, Clone, PartialEq)]
pub struct GroupGrab {
    anchor: (f64, f64),
    members: Vec<Start>,
}

impl GroupGrab {
    /// 以屏幕上的 `anchor`（物理像素）为缩放锚点，记下 `pins` 里没锁定的钉图。
    pub fn new<'a>(pins: impl IntoIterator<Item = &'a SavedPin>, anchor: (f64, f64)) -> GroupGrab {
        let members = pins
            .into_iter()
            .filter(|p| !p.locked)
            .map(|p| {
                let s = p.placement.scale;
                let lo = p.clamp_scale(0.0) / s;
                let hi = p.clamp_scale(f64::MAX) / s;
                Start {
                    id: p.id.clone(),
                    x: f64::from(p.placement.x),
                    y: f64::from(p.placement.y),
                    scale: s,
                    // 开始时已在限制以外（旧数据）的也能原样不动。
                    factor: (lo.min(1.0), hi.max(1.0)),
                }
            })
            .collect();
        GroupGrab { anchor, members }
    }

    /// 跟着动的钉图（没锁定的）。
    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.members.iter().map(|m| m.id.as_str())
    }

    pub fn is_empty(&self) -> bool {
        self.members.is_empty()
    }

    /// 整组能缩放到的比例：`factor` 限制在每张钉图都还能缩放的范围里。
    pub fn clamp_factor(&self, factor: f64) -> f64 {
        let (lo, hi) = self.members.iter().fold((0.0f64, f64::MAX), |(lo, hi), m| {
            (lo.max(m.factor.0), hi.min(m.factor.1))
        });
        if factor.is_nan() {
            return 1.0;
        }
        factor.clamp(lo.min(hi), hi)
    }

    /// 把 `pin` 摆到整组平移 `offset`、以锚点缩放 `factor`（先用 [`Self::clamp_factor`]）后的位置。
    /// 不在这次手势里（锁定、手势开始后才钉上）的不动，返回 false。
    pub fn place(&self, pin: &mut SavedPin, offset: (i32, i32), factor: f64) -> bool {
        if pin.locked {
            return false;
        }
        let Some(m) = self.members.iter().find(|m| m.id == pin.id) else {
            return false;
        };
        let (ax, ay) = self.anchor;
        pin.placement.scale = m.scale * factor;
        pin.placement.x = (ax + (m.x - ax) * factor).round() as i32 + offset.0;
        pin.placement.y = (ay + (m.y - ay) * factor).round() as i32 + offset.1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::{MAX_SCALE, PinContent, Placement};

    fn pin(id: &str, x: i32, y: i32, scale: f64) -> SavedPin {
        SavedPin {
            id: id.into(),
            content: PinContent::Capture {
                capture_id: "C".into(),
            },
            crop: None,
            width: 200,
            height: 100,
            placement: Placement {
                x,
                y,
                scale,
                ..Placement::default()
            },
            opacity: 1.0,
            locked: false,
            member: None,
        }
    }

    #[test]
    fn moving_shifts_every_unlocked_pin_by_the_same_offset() {
        let mut pins = [pin("a", 0, 0, 1.0), pin("b", 500, 300, 0.5)];
        pins[1].locked = true;
        let grab = GroupGrab::new(&pins, (10.0, 10.0));
        assert_eq!(grab.ids().collect::<Vec<_>>(), ["a"]);
        for p in &mut pins {
            grab.place(p, (30, -20), 1.0);
        }
        assert_eq!((pins[0].placement.x, pins[0].placement.y), (30, -20));
        assert_eq!((pins[1].placement.x, pins[1].placement.y), (500, 300));
    }

    #[test]
    fn zooming_keeps_the_anchor_still_and_scales_positions_and_sizes_alike() {
        let mut pins = [pin("a", 100, 100, 1.0), pin("b", 300, 200, 0.5)];
        let grab = GroupGrab::new(&pins, (200.0, 150.0));
        for p in &mut pins {
            assert!(grab.place(p, (0, 0), 2.0));
        }
        assert_eq!((pins[0].placement.x, pins[0].placement.y), (0, 50));
        assert_eq!((pins[1].placement.x, pins[1].placement.y), (400, 250));
        assert_eq!(pins[0].placement.scale, 2.0);
        assert_eq!(pins[1].placement.scale, 1.0);
        // 锚点在 a 内容上的相对位置不变：开始时 (0.5, 0.5)，2 倍后 a 是 400×200、左上角 (0, 50)。
        let (w, h) = pins[0].exact_size();
        assert_eq!((200.0 - 0.0) / w, 0.5);
        assert_eq!((150.0 - 50.0) / h, 0.5);
    }

    #[test]
    fn each_step_starts_from_the_grab_so_rounding_does_not_build_up() {
        let mut p = pin("a", 7, 7, 1.0);
        let grab = GroupGrab::new([&p], (0.0, 0.0));
        for f in [1.12, 1.2544, 1.404928, 1.0] {
            grab.place(&mut p, (0, 0), f);
        }
        assert_eq!(
            (p.placement.x, p.placement.y, p.placement.scale),
            (7, 7, 1.0)
        );
    }

    #[test]
    fn the_group_stops_together_at_the_tightest_limit() {
        let pins = [pin("a", 0, 0, 1.0), pin("b", 0, 0, MAX_SCALE / 2.0)];
        let grab = GroupGrab::new(&pins, (0.0, 0.0));
        assert_eq!(grab.clamp_factor(4.0), 2.0);
        // 最小：200 px 宽的图较长边不小于 24 px，即缩放不小于 0.12。b 从 5 倍可缩到 0.024 倍。
        assert!((grab.clamp_factor(0.0) - 0.12).abs() < 1e-12);
        assert_eq!(grab.clamp_factor(f64::NAN), 1.0);
    }

    #[test]
    fn a_pin_already_past_its_limit_does_not_jump() {
        let pins = [pin("a", 0, 0, MAX_SCALE * 2.0)];
        let grab = GroupGrab::new(&pins, (0.0, 0.0));
        assert_eq!(grab.clamp_factor(1.0), 1.0);
        assert_eq!(grab.clamp_factor(3.0), 1.0);
        assert!(grab.clamp_factor(0.5) < 1.0);
    }

    #[test]
    fn pins_outside_the_grab_and_locked_pins_stay() {
        let pins = [pin("a", 0, 0, 1.0)];
        let grab = GroupGrab::new(&pins, (0.0, 0.0));
        let mut late = pin("late", 5, 5, 1.0);
        assert!(!grab.place(&mut late, (10, 10), 1.0));
        let mut a = pins[0].clone();
        a.locked = true;
        assert!(!grab.place(&mut a, (10, 10), 1.0));
        assert_eq!((a.placement.x, late.placement.x), (0, 5));
        assert!(GroupGrab::new(&[a], (0.0, 0.0)).is_empty());
    }
}
