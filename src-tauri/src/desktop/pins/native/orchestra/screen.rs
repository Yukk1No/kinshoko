//! 每一帧怎么上屏：按钉图此刻的状态走一次 [`plan`]，交给平台层与渲染层。
//!
//! 每张钉图同一时刻最多一件事在路上：一次绘制（渲染线程上），或一次换窗（等合成器）。路上有事时
//! 来的更新先记下（`Live::dirty`），做完再按最新的状态走一次 [`plan`]：
//! - 换窗：备用槽 `stage` 之后画它，画完才 `swap`；`Swapped` 之前不往两个槽里画，画面不会倒退；
//! - 重画看得见的槽时不平移它：平移会先于还没 Present 的那一帧生效，露出一帧没提交过的画面。

use std::time::Duration;

use kinshoko_core::desktop::ScreenRect;
use kinshoko_core::desktop::frame::{
    APPEAR_MS, RectF, Step, appear_ring, plan, veil_left, window_for,
};
use pin_shell::{PinId, PinShell};

use super::super::caption::Caption;
use super::super::port::{DrawJob, RenderPort};
use super::{ANIM_FRAME, Effect, Live, MISSING, Orchestra, Reveal, SETTLE_MS, Screen, Submit};

/// 淡到这么浅就当作没有了（不到 1/255 的一半）。
const FADED: f64 = 1e-3;

/// 路上的事。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Pending {
    /// 渲染层在往某个槽画；画完之后 `then`。
    Draw {
        window: ScreenRect,
        content: ScreenRect,
        then: Then,
    },
    /// 已 `swap`，等 `Swapped`。
    Swap {
        window: ScreenRect,
        content: ScreenRect,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Then {
    /// 第一次显示。
    Show,
    /// 画的是备用槽：换上。
    Swap,
    /// 画的是看得见的槽：完了。
    Keep,
}

impl Live {
    /// 此刻还剩多少遮蔽（0～1）。
    fn veil(&self, at: f64) -> f64 {
        match self.reveal {
            _ if self.look.veiled => 1.0,
            Reveal::Waiting => 1.0,
            Reveal::Fading(start) => veil_left(at - start).clamp(0.0, 1.0),
            Reveal::Idle => 0.0,
        }
    }

    /// 出现提示框此刻的不透明度。
    fn appear(&self, at: f64) -> f64 {
        self.appeared
            .filter(|start| at - start < f64::from(APPEAR_MS))
            .map_or(0.0, |start| appear_ring(at - start))
    }

    /// 还在动：内容在过渡，遮蔽在淡出，或出现提示框在渐隐。
    fn animating(&self, at: f64) -> bool {
        !self.motion.done(at)
            || matches!(self.reveal, Reveal::Fading(s) if veil_left(at - s) > 0.0)
            || self.appeared.is_some()
    }

    fn caption(&self) -> Caption {
        Caption {
            lock: self.look.veiled,
            reason: self
                .look
                .unavailable
                .clone()
                .or_else(|| self.placeholder.then(|| MISSING.to_owned())),
            notice: self.notice.as_ref().map(|(text, _)| text.clone()),
        }
    }
}

impl<S: PinShell, R: RenderPort> Orchestra<S, R> {
    /// 输入或应用壳改了钉图：静止位置跟着改（收起着的除外），内容用 `duration_ms` 从此刻看到的位置
    /// 过渡过去（0 为直接到；静止位置没变时不打断正在走的动画），手势延长到动画结束后
    /// [`SETTLE_MS`]，上屏。`save` 时写回 `pins.json`。
    pub(super) fn changed(&mut self, pin: PinId, duration_ms: u32, save: bool) {
        let (now, at) = (self.now, self.ms(self.now));
        let live = self.pins.get_mut(&pin).expect("调用方已找到");
        if !live.tucked {
            live.target = live.pin.rect();
        }
        let target = RectF::from(live.target);
        if live.motion.target() != target {
            live.motion.retarget(target, at, f64::from(duration_ms));
        }
        let until = now + Duration::from_millis(u64::from(duration_ms) + SETTLE_MS);
        live.gesture_until = Some(live.gesture_until.map_or(until, |t| t.max(until)));
        if save {
            self.effects.push(Effect::Saved(live.pin.clone()));
        }
        self.update(pin, true);
    }

    /// 按钉图现在的状态走一次 [`plan`]。路上有事时先记下。
    pub(super) fn update(&mut self, pin: PinId, gesture: bool) {
        let (now, at) = (self.now, self.ms(self.now));
        let monitors: Vec<ScreenRect> = self.screens.iter().map(|s| s.rect).collect();
        let Some(live) = self.pins.get_mut(&pin).filter(|l| !l.closing) else {
            return;
        };
        if live.pending.is_some() {
            // 只留最新的：停手之后的更新要盖掉路上记下的“手势中”。
            live.dirty = Some(gesture);
            return;
        }
        if !live.loaded {
            return;
        }
        let content = live.motion.at(at).snap();
        let mut veil = live.veil(at);
        live.frame_due = live.animating(at).then(|| now + ANIM_FRAME);
        let screen = screen_at(&self.screens, content);
        let profile = screen.and_then(|s| s.profile.clone());
        let display_scale = screen.map_or(1.0, |s| s.scale);
        if profile != live.profile {
            live.fresh = false;
        }
        // 遮蔽在淡出、提示框在渐隐：每一帧都要重画。
        if matches!(live.reveal, Reveal::Fading(_)) {
            live.fresh = false;
            if veil < FADED {
                veil = 0.0;
                live.reveal = Reveal::Idle;
            }
        }
        // 还没显示：第一帧按提示框最浓画好（设备丢失后重新显示的除外）。
        let mut appear = if live.window.is_none() && live.restoring.is_none() {
            1.0
        } else {
            live.appear(at)
        };
        if live.appeared.is_some() {
            live.fresh = false;
            // 曲线的尾巴（毫秒换算的误差）当作已经渐隐完。
            if appear < FADED {
                appear = 0.0;
                live.appeared = None;
            }
        }
        let visible = self.shell.visible_slot(pin);
        let (slot, window, then) = match live.window {
            None => match window_for(content, &monitors) {
                Some(w) => (visible, w, Then::Show),
                None => return,
            },
            Some(window) => match plan(window, live.drawn, content, &monitors, gesture) {
                Step::Hidden => return,
                Step::Redraw if live.fresh && live.drawn == content => return,
                Step::Redraw => (visible, window, Then::Keep),
                Step::Move(to) => {
                    let submit = submit(pin, live, content, to);
                    live.window = Some(to);
                    live.drawn = content;
                    self.submit(&submit);
                    self.shell.translate(pin, to);
                    // 同时还有别的变化（透明度）：平移之后在新位置重画。
                    let live = self.pins.get_mut(&pin).expect("上面找到");
                    if live.fresh {
                        return;
                    }
                    (visible, to, Then::Keep)
                }
                Step::Swap(to) => {
                    let submit = submit(pin, live, content, to);
                    self.submit(&submit);
                    self.shell.stage(pin, to);
                    (1 - visible, to, Then::Swap)
                }
            },
        };
        let live = self.pins.get_mut(&pin).expect("上面找到");
        live.fresh = true;
        live.profile.clone_from(&profile);
        live.pending = Some(Pending::Draw {
            window,
            content,
            then,
        });
        let job = DrawJob {
            pin,
            slot,
            window,
            content,
            state: live.pin.clone(),
            display: profile,
            display_scale,
            veil: veil as f32,
            ring: live.look.edge_contrast,
            appear: appear as f32,
            dark: live.look.dark,
            placeholder: live.placeholder,
            caption: live.caption(),
        };
        if then != Then::Swap {
            let submit = submit(pin, live, content, window);
            self.submit(&submit);
        }
        self.render.draw(job);
    }

    fn submit(&mut self, s: &Submit) {
        if let Some(f) = &mut self.on_submit {
            f(s);
        }
    }

    pub(super) fn drawn(&mut self, pin: PinId, result: Result<(), String>) {
        let (now, self_ms) = (self.now, self.ms(self.now));
        let Some(live) = self.pins.get_mut(&pin) else {
            return;
        };
        let Some(Pending::Draw {
            window,
            content,
            then,
        }) = live.pending.take()
        else {
            return;
        };
        if let Err(e) = result {
            // 没画上：窗口不动，下一次更新重来。
            live.fresh = false;
            self.effects.push(Effect::Warn("原生钉图画不上", e));
            if matches!(then, Then::Show) {
                self.give_up_unshown(pin);
            } else {
                self.replay(pin);
            }
            return;
        }
        if live.closing {
            return;
        }
        match then {
            Then::Show => {
                live.window = Some(window);
                live.drawn = content;
                // 出现提示框从显示出来的这一刻起渐隐（第一帧按 1 画好了）。
                if let Some(lost) = live.restoring.take() {
                    let ms = now.saturating_duration_since(lost).as_millis();
                    self.effects.push(Effect::Warn(
                        "原生钉图设备丢失后重新显示",
                        format!("{ms} ms"),
                    ));
                } else {
                    live.appeared = Some(self_ms);
                    live.frame_due = Some(now + ANIM_FRAME);
                }
                let key = live.key.clone();
                self.shell.show(pin, window);
                self.effects.push(Effect::Shown(key));
            }
            Then::Swap => {
                live.pending = Some(Pending::Swap { window, content });
                self.shell.swap(pin);
                return;
            }
            Then::Keep => live.drawn = content,
        }
        self.replay(pin);
    }

    /// 还没显示过的钉图出错了：不会自己好，收掉，免得留下一张看不见、等不到显示的钉图。
    pub(super) fn give_up_unshown(&mut self, pin: PinId) {
        let Some(live) = self.pins.get_mut(&pin) else {
            return;
        };
        if live.window.is_some() || std::mem::replace(&mut live.closing, true) {
            return;
        }
        self.effects.push(Effect::Failed(live.key.clone()));
        self.render.detach(pin);
    }

    pub(super) fn swapped(&mut self, pin: PinId) {
        let Some(live) = self.pins.get_mut(&pin) else {
            return;
        };
        if let Some(Pending::Swap { window, content }) = live.pending {
            live.pending = None;
            live.window = Some(window);
            live.drawn = content;
            self.replay(pin);
        }
    }

    fn replay(&mut self, pin: PinId) {
        if let Some(gesture) = self.pins.get_mut(&pin).and_then(|l| l.dirty.take()) {
            self.update(pin, gesture);
        }
    }
}

/// 这一帧显示的缩放比例：动画中途按内容与静止尺寸之比折算。
fn submit(pin: PinId, live: &Live, content: ScreenRect, window: ScreenRect) -> Submit {
    let ratio = f64::from(content.width) / f64::from(live.target.width.max(1));
    Submit {
        pin,
        content,
        window,
        scale: live.pin.placement.scale * ratio,
        opacity: live.pin.opacity,
    }
}

/// 钉图中心所在的显示器；中心不在任何显示器上时取第一台碰到的。
fn screen_at(screens: &[Screen], content: ScreenRect) -> Option<&Screen> {
    let centre = ScreenRect {
        x: content.x.saturating_add((content.width / 2) as i32),
        y: content.y.saturating_add((content.height / 2) as i32),
        width: 1,
        height: 1,
    };
    screens
        .iter()
        .find(|s| s.rect.contains(&centre))
        .or_else(|| {
            screens
                .iter()
                .find(|s| s.rect.intersect(&content).is_some())
        })
}

/// 测试用：内容此刻的位置。
#[cfg(test)]
impl<S: PinShell, R: RenderPort> Orchestra<S, R> {
    pub(super) fn shown(&self, pin: PinId, now: std::time::Instant) -> ScreenRect {
        self.pins[&pin].motion.at(self.ms(now)).snap()
    }
}
