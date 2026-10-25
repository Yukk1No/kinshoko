//! 指针、滚轮与按键（与钉图层的 `PinView` 相同）：鼠标、笔、触摸走同一套，按住拖动移动，按住右下角
//! 缩放区拖动缩放（左上角不动），锁定时都不动、只等按住开菜单；滚轮以光标为中心缩放，Ctrl+滚轮调
//! 透明度；H/V 翻转，R/Shift+R 旋转，Esc 关闭。菜单：鼠标右键、笔的侧键，或笔与触摸按住不动约半秒
//! （同一次按下只开一次）。按下的钉图到最上层。
//!
//! 坐标都是屏幕物理像素；以 CSS 像素定的阈值（按住的容差、缩放区）按光标所在显示器的缩放比例换算。

use std::time::{Duration, Instant};

use kinshoko_core::desktop::frame::{
    HOLD_MS, HOLD_SLOP, Hit, PointerKind, ZOOM_MS, ZoomAnchor, ZoomStart, corner_zoom_scale,
    held_for_menu, hit, press_opens_menu, scale_at, wheel_opacity, wheel_zoom_scale,
};
use kinshoko_core::desktop::{ScreenRect, Turn};
use pin_shell::{Key, PinCursor, PinId, PinKeys, PinShell, Pointer, PointerEvent};

use super::super::port::RenderPort;
use super::{Effect, KEYS, Orchestra, SETTLE_MS};

/// 同一次按下引出的几个开菜单的事件（按下、长按）只开一次（钉图层的 `MENU_DEDUPE_MS`）。
const MENU_DEDUPE: Duration = Duration::from_millis(800);

/// 按着的指针。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Gesture {
    kind: PointerKind,
    /// 按下处与最近一次的位置，按下的时刻。
    down: (i32, i32),
    last: (i32, i32),
    at: Instant,
    /// 移动曾经超过按住的容差：这一笔是拖动，回到起点也不再算按住。
    dragged: bool,
    /// 已经判断过按住开菜单。
    held: bool,
    grab: Grab,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Grab {
    /// 拖动：按下时内容的左上角。
    Move { origin: (i32, i32) },
    /// 拖右下角缩放：按下时的缩放与尺寸，左上角不动。
    Zoom {
        origin: (i32, i32),
        start: ZoomStart,
    },
    /// 锁定的钉图：只等按住开菜单。
    Hold,
}

impl Gesture {
    /// 笔与触摸按住多久后判断要不要开菜单。
    pub(super) fn hold_due(&self) -> Option<Instant> {
        (self.kind != PointerKind::Mouse && !self.dragged && !self.held)
            .then(|| self.at + Duration::from_millis(u64::from(HOLD_MS)))
    }
}

impl<S: PinShell, R: RenderPort> Orchestra<S, R> {
    pub(super) fn pointer(&mut self, p: Pointer) {
        let scale = scale_at(&self.monitors(), (f64::from(p.at.0), f64::from(p.at.1)));
        let at = self.ms(self.now);
        let now = self.now;
        let Some(live) = self.live(p.pin) else { return };
        let shown = live.motion.at(at).snap();
        let place = hit(shown, (f64::from(p.at.0), f64::from(p.at.1)), scale);
        match p.event {
            PointerEvent::Down(button) => {
                // 窗口在手势中盖着钉图以外的透明处：那里的按下不算。
                if place == Hit::Outside {
                    return;
                }
                if live.look.veiled && on_lock(shown, p.at, scale) && !press_opens_menu(button) {
                    self.open_menu(p.pin, true);
                    return;
                }
                if press_opens_menu(button) {
                    self.open_menu(p.pin, false);
                    return;
                }
                let target = live.target;
                let grab = if live.pin.locked {
                    Grab::Hold
                } else if place == Hit::ZoomCorner {
                    let (width, height) = live.pin.window_size();
                    Grab::Zoom {
                        origin: (target.x, target.y),
                        start: ZoomStart {
                            scale: live.pin.placement.scale,
                            width,
                            height,
                        },
                    }
                } else {
                    // 从此刻看到的位置拖（贴边滑动中途抓住时抓住的点留在指针下）。
                    Grab::Move {
                        origin: (shown.x, shown.y),
                    }
                };
                live.gesture = Some(Gesture {
                    kind: p.kind,
                    down: p.at,
                    last: p.at,
                    at: now,
                    dragged: false,
                    held: false,
                    grab,
                });
                self.shell.raise(p.pin);
            }
            PointerEvent::Move => {
                let Some(g) = live.gesture.as_mut() else {
                    let cursor = if place == Hit::ZoomCorner && !live.pin.locked {
                        PinCursor::ResizeNwse
                    } else {
                        PinCursor::Arrow
                    };
                    if std::mem::replace(&mut live.cursor, cursor) != cursor {
                        self.shell.set_cursor(p.pin, cursor);
                    }
                    return;
                };
                g.last = p.at;
                let (dx, dy) = (p.at.0 - g.down.0, p.at.1 - g.down.1);
                if f64::from(dx).hypot(f64::from(dy)) > HOLD_SLOP * scale {
                    g.dragged = true;
                }
                match g.grab {
                    Grab::Hold => {}
                    Grab::Move { origin } => {
                        let to = (origin.0 + dx, origin.1 + dy);
                        self.untuck(p.pin);
                        let live = self.pins.get_mut(&p.pin).expect("上面找到");
                        let placement = (live.pin.placement.x, live.pin.placement.y);
                        if to != placement && live.pin.move_to(to.0, to.1) {
                            self.changed(p.pin, 0, true);
                        }
                    }
                    Grab::Zoom { origin, start } => {
                        let scale = corner_zoom_scale(start, f64::from(dx), f64::from(dy));
                        self.untuck(p.pin);
                        let live = self.pins.get_mut(&p.pin).expect("上面找到");
                        let before = live.pin.placement;
                        let anchor =
                            ZoomAnchor::new(&live.pin, (f64::from(origin.0), f64::from(origin.1)));
                        if anchor.zoom(&mut live.pin, scale) && live.pin.placement != before {
                            self.changed(p.pin, ZOOM_MS, true);
                        }
                    }
                }
            }
            PointerEvent::Up(_) | PointerEvent::Cancel => {
                if live.gesture.take().is_some() && live.gesture_until.is_some() {
                    // 松开后重新计时收尾（拖动中途停着不动时不收）。
                    let until = now + Duration::from_millis(SETTLE_MS);
                    live.gesture_until = live.gesture_until.map(|t| t.max(until));
                }
            }
            PointerEvent::Leave => {}
        }
    }

    pub(super) fn wheel(&mut self, pin: PinId, at: (i32, i32), notches: f64, ctrl: bool) {
        let Some(live) = self.live(pin) else { return };
        // 前端的 deltaY：向下为正，一格 100。按着指针时不缩放。
        let delta_y = -notches * 100.0;
        if live.gesture.is_some() || delta_y == 0.0 {
            return;
        }
        if ctrl {
            let before = live.pin.opacity;
            live.pin.set_opacity(wheel_opacity(before, delta_y));
            if live.pin.opacity == before {
                return;
            }
            live.fresh = false;
            self.changed(pin, 0, true);
            return;
        }
        if live.pin.locked {
            return;
        }
        self.untuck(pin);
        let live = self.pins.get_mut(&pin).expect("上面找到");
        let anchor = match live.anchor {
            Some((cursor, anchor)) if cursor == at => anchor,
            _ => ZoomAnchor::new(&live.pin, (f64::from(at.0), f64::from(at.1))),
        };
        live.anchor = Some((at, anchor));
        let scale = wheel_zoom_scale(live.pin.placement.scale, delta_y);
        let before = live.pin.placement;
        if anchor.zoom(&mut live.pin, scale) && live.pin.placement != before {
            self.changed(pin, ZOOM_MS, true);
        }
    }

    pub(super) fn key(&mut self, pin: PinId, key: Key, shift: bool) {
        let Some(live) = self.live(pin) else { return };
        let turn = match (key, shift) {
            (Key::Escape, _) => {
                let key = live.key.clone();
                live.gesture = None;
                self.effects.push(Effect::CloseRequested(key));
                return;
            }
            (Key::Letter('H'), false) => Turn::FlipHorizontal,
            (Key::Letter('V'), false) => Turn::FlipVertical,
            (Key::Letter('R'), false) => Turn::RotateClockwise,
            (Key::Letter('R'), true) => Turn::RotateCounterClockwise,
            _ => return,
        };
        self.untuck(pin);
        let live = self.pins.get_mut(&pin).expect("上面找到");
        live.pin.turn(turn);
        live.fresh = false;
        self.changed(pin, 0, true);
    }

    /// 打开菜单（`reveal`：确认显示被遮蔽的图）：键盘钩子不再拦键（菜单窗口要收键），按着的手势
    /// 作废。同一次按下只开一次。
    pub(super) fn open_menu(&mut self, pin: PinId, reveal: bool) {
        let now = self.now;
        if self.menu_at.is_some_and(|t| now < t + MENU_DEDUPE) {
            return;
        }
        let Some(live) = self.live(pin) else { return };
        live.gesture = None;
        let key = live.key.clone();
        self.menu_at = Some(now);
        if !std::mem::replace(&mut self.menu_open, true) {
            self.shell.set_keys(PinKeys::none());
        }
        self.effects.push(if reveal {
            Effect::RevealAsked(key)
        } else {
            Effect::Menu(key)
        });
    }

    /// 菜单关掉了（或没打开）：键盘钩子恢复拦键。
    pub fn menu_closed(&mut self) {
        if std::mem::replace(&mut self.menu_open, false) {
            self.shell.set_keys(PinKeys::new(KEYS));
        }
    }

    /// 笔与触摸按住到时：没怎么动就开菜单。
    pub(super) fn check_holds(&mut self, now: Instant) {
        let monitors = self.monitors();
        let due: Vec<PinId> = self
            .pins
            .iter()
            .filter(|(_, l)| !l.closing)
            .filter(|(_, l)| {
                l.gesture
                    .as_ref()
                    .and_then(Gesture::hold_due)
                    .is_some_and(|t| now >= t)
            })
            .map(|(id, _)| *id)
            .collect();
        for id in due {
            let g = self.pins.get_mut(&id).and_then(|l| l.gesture.as_mut());
            let Some(g) = g else { continue };
            g.held = true;
            let at = (f64::from(g.down.0), f64::from(g.down.1));
            let scale = scale_at(&monitors, at);
            let elapsed = u32::try_from(now.duration_since(g.at).as_millis()).unwrap_or(u32::MAX);
            let last = (f64::from(g.last.0), f64::from(g.last.1));
            if held_for_menu(g.kind, at, last, elapsed, scale) {
                self.open_menu(id, false);
            }
        }
    }

    /// 收起着的钉图被就地改：原位挪到此刻的位置，不再收起，不再点击穿透（钉图层的 `change_here`）。
    fn untuck(&mut self, pin: PinId) {
        let live = self.pins.get_mut(&pin).expect("调用方已找到");
        if !live.tucked {
            return;
        }
        let ScreenRect { x, y, .. } = live.target;
        live.pin.placement.x = x;
        live.pin.placement.y = y;
        live.tucked = false;
        if std::mem::replace(&mut live.click_through, false) {
            self.shell.set_click_through(pin, false);
        }
        let key = live.key.clone();
        self.effects.push(Effect::Released(key));
    }
}

/// 小圆锁（直径 28 CSS 像素，在内容正中）。
fn on_lock(content: ScreenRect, at: (i32, i32), scale: f64) -> bool {
    let cx = f64::from(content.x) + f64::from(content.width) / 2.0;
    let cy = f64::from(content.y) + f64::from(content.height) / 2.0;
    (f64::from(at.0) - cx).hypot(f64::from(at.1) - cy) <= 14.0 * scale
}
