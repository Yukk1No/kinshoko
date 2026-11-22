//! 整组移动与缩放（#198）：桌面上的钉图都是桌面上那个参考组的成员，整组就是此刻开着的全部钉图。
//!
//! - 按着 Alt 拖动任意一张：整组一起移动；按着 Alt 滚滚轮：整组以光标为中心缩放；
//! - 钉图菜单“整组移动”（笔和触摸不方便按键）：下一次按下拖动时整组移动，Esc 取消；
//! - 按着 Alt 把光标停在钉图上、菜单“整组移动”之后、整组手势中：全部钉图画细边框；
//! - 锁定的钉图原地不动（[`GroupGrab`] 不记它们），贴边收起着的也不动。
//!
//! 每张钉图仍各自按 [`Orchestra::changed`] 上屏、保存；跨显示器的钉图是各自的窗口，不需要交接。

use kinshoko_core::desktop::frame::{GroupGrab, ZOOM_MS};
use pin_shell::{PinId, PinShell};

use super::super::port::RenderPort;
use super::Orchestra;

/// 整组操作的状态。
#[derive(Debug, Default)]
pub(super) struct Group {
    /// Alt 按着（键盘钩子报的，指针事件也带着）。
    alt: bool,
    /// 光标停在哪张钉图上（鼠标、笔悬停）。
    hover: Option<PinId>,
    /// 点过菜单“整组移动”，还没按下。
    armed: bool,
    /// 整组拖动中：按下的那张与开始时的样子。
    drag: Option<(PinId, GroupGrab)>,
    /// 整组滚轮缩放：取锚点时的光标、开始时的样子、累计的比例。光标挪了、松开 Alt、别的改动
    /// （按下、按键、单张滚轮、应用壳推来的帧）之后重新取，免得盖掉中间的改动。
    wheel: Option<((i32, i32), GroupGrab, f64)>,
}

impl Group {
    /// 要不要画同组的细边框。
    pub(super) fn outlined(&self) -> bool {
        self.armed || self.drag.is_some() || (self.alt && self.hover.is_some())
    }

    /// 这次按下要不要拖整组。
    pub(super) fn wants_drag(&self, alt: bool) -> bool {
        alt || self.armed
    }

    pub(super) fn dragging(&self) -> bool {
        self.drag.is_some()
    }

    /// 整组拖动是不是从 `pin` 上按下的。
    pub(super) fn dragged_by(&self, pin: PinId) -> bool {
        self.drag.as_ref().is_some_and(|(by, _)| *by == pin)
    }

    /// 别的改动之后，下一次 Alt+滚轮从此刻的样子重新开始。
    pub(super) fn forget_wheel(&mut self) {
        self.wheel = None;
    }
}

impl<S: PinShell, R: RenderPort> Orchestra<S, R> {
    /// Alt 按下或松开（键盘钩子、指针事件）。
    pub(super) fn alt_changed(&mut self, held: bool) {
        if self.group.alt != held {
            self.group.alt = held;
            if !held {
                self.group.forget_wheel();
            }
            self.refresh_outline();
        }
    }

    /// 光标停在 `pin` 上（`None`：离开了）。
    pub(super) fn hovered(&mut self, pin: Option<PinId>) {
        if self.group.hover != pin {
            self.group.hover = pin;
            self.refresh_outline();
        }
    }

    /// 菜单“整组移动”：下一次按下拖动整组。
    pub fn arm_group_move(&mut self, now: std::time::Instant) {
        self.now = now;
        self.group.armed = true;
        self.refresh_outline();
    }

    /// 取消菜单“整组移动”（Esc）。返回原来是不是在等。
    pub(super) fn disarm_group_move(&mut self) -> bool {
        let was = std::mem::replace(&mut self.group.armed, false);
        if was {
            self.refresh_outline();
        }
        was
    }

    /// 整组拖动开始（从 `pin` 上按下）：记下此刻开着的全部钉图。
    pub(super) fn start_group_drag(&mut self, pin: PinId, at: (i32, i32)) {
        let at = (f64::from(at.0), f64::from(at.1));
        // 从此刻看到的样子拖（缩放动画中途按下时，抓住的点留在指针下，与单张拖动相同）。
        let ms = self.ms(self.now);
        let shown: Vec<kinshoko_core::desktop::SavedPin> = self
            .pins
            .values()
            .filter(|l| !l.closing && !l.tucked)
            .map(|l| {
                let mut pin = l.pin.clone();
                let seen = l.motion.at(ms).snap();
                let home = pin.rect();
                if home.width > 0 && seen.width > 0 {
                    pin.placement.scale *= f64::from(seen.width) / f64::from(home.width);
                }
                pin.placement.x = seen.x;
                pin.placement.y = seen.y;
                pin
            })
            .collect();
        let grab = GroupGrab::new(&shown, at);
        self.group.armed = false;
        self.group.wheel = None;
        self.group.drag = Some((pin, grab));
        self.refresh_outline();
    }

    /// 整组拖到离按下处 `offset`。
    pub(super) fn group_dragged(&mut self, offset: (i32, i32)) {
        let Some((pin, grab)) = self.group.drag.take() else {
            return;
        };
        self.place_group(&grab, offset, 1.0, 0);
        self.group.drag = Some((pin, grab));
    }

    /// 整组拖动结束（松开、取消、开了菜单、按下的那张关了）。
    pub(super) fn end_group_drag(&mut self) {
        if self.group.drag.take().is_some() {
            self.refresh_outline();
        }
    }

    /// Alt+滚轮：整组以光标为中心缩放。
    pub(super) fn group_wheel(&mut self, at: (i32, i32), delta_y: f64) {
        let (grab, factor) = match self.group.wheel.take() {
            Some((cursor, grab, factor)) if cursor == at => (grab, factor),
            _ => {
                let anchor = (f64::from(at.0), f64::from(at.1));
                let grab = GroupGrab::new(self.members(), anchor);
                (grab, 1.0)
            }
        };
        // 与单张的滚轮缩放同一个步长（`wheel_zoom_scale`）。
        let factor = grab.clamp_factor(factor * 1.12f64.powf(-delta_y / 100.0));
        self.place_group(&grab, (0, 0), factor, ZOOM_MS);
        self.group.wheel = Some((at, grab, factor));
    }

    /// 跟着整组动的钉图：开着的，贴边收起着的除外（收起着的留在边上，回到原位时再说）。
    fn members(&self) -> impl Iterator<Item = &kinshoko_core::desktop::SavedPin> {
        self.pins
            .values()
            .filter(|l| !l.closing && !l.tucked)
            .map(|l| &l.pin)
    }

    fn place_group(&mut self, grab: &GroupGrab, offset: (i32, i32), factor: f64, ms: u32) {
        let ids: Vec<PinId> = self
            .pins
            .iter()
            .filter(|(_, l)| !l.closing && grab.ids().any(|k| k == l.key))
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            let live = self.pins.get_mut(&id).expect("上面找到");
            let mut next = live.pin.clone();
            if !grab.place(&mut next, offset, factor) || next.placement == live.pin.placement {
                continue;
            }
            live.pin.placement = next.placement;
            live.anchor = None;
            self.changed(id, ms, true);
        }
    }

    /// 细边框跟着状态画上或去掉。
    fn refresh_outline(&mut self) {
        let on = self.group.outlined();
        let ids: Vec<PinId> = self
            .pins
            .iter_mut()
            .filter(|(_, l)| !l.closing && l.outlined != on)
            .map(|(id, l)| {
                l.outlined = on;
                l.fresh = false;
                *id
            })
            .collect();
        for id in ids {
            let gesture = self.pins[&id].gesture_until.is_some();
            self.update(id, gesture);
        }
    }
}
