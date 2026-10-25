//! 原生钉图的编排（#277、ADR 0013）：输入（[`PinShell::pump`]）→ 改 [`SavedPin`] → [`plan`] →
//! 平台层与渲染层。不认识 Tauri，也不认识具体的平台层与渲染层：测试用假平台层（`FakeShell`）和
//! 一个只记录的假渲染层。
//!
//! 每张钉图同一时刻最多一件事在路上：一次绘制（渲染线程上），或一次换窗（等合成器）。路上有事时
//! 来的更新先记下（[`Live::dirty`]），做完再按最新的状态走一次 [`plan`]：
//! - 换窗：备用槽 `stage` 之后画它，画完才 `swap`；`Swapped` 之前不往两个槽里画，画面不会倒退；
//! - 重画看得见的槽时不平移它：平移会先于还没 Present 的那一帧生效，露出一帧没提交过的画面。
//!
//! 手势（滚轮、拖动）在最后一次输入后 [`SETTLE_MS`] 结束（[`Orchestra::tick`]）：窗口收回刚好盖住
//! 钉图，再按显示尺寸要一张派生图（[`source_size`]）。

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use kinshoko_core::desktop::frame::{
    PointerButton, SourceSize, Step, ZoomAnchor, plan, source_size, wheel_opacity,
    wheel_zoom_scale, window_for,
};
use kinshoko_core::desktop::{SavedPin, ScreenRect};
use pin_shell::{
    Display, HookEvent, Key, PinId, PinInput, PinKeys, PinShell, Pointer, PointerEvent,
};

use super::port::{DrawJob, RenderEvent, RenderPort};

/// 停手多久算手势结束（ADR 0005、#281）。
pub const SETTLE_MS: u64 = 120;

/// 编排要应用壳做的事。
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// 钉图状态改了，写回 `pins.json`。
    Saved(SavedPin),
    /// 钉图第一次显示出来。
    Shown(String),
    /// 画师要关掉它（Esc）：走应用的关闭流程，流程里再调 [`Orchestra::close`]。
    CloseRequested(String),
    /// 钉图的窗口已关。
    Closed(String),
    /// 第一帧之前读不到图或画不上：钉图已在收掉，应用收掉本次运行的记录，状态留到下次启动。
    Failed(String),
    /// 写进运行日志的警告。
    Warn(&'static str, String),
}

/// 一次提交：给逐帧核对（`tools/pin-frame-check`）记录屏幕上应当出现的画面。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Submit {
    pub pin: PinId,
    pub content: ScreenRect,
    pub window: ScreenRect,
    pub scale: f64,
    pub opacity: f64,
}

type OnSubmit = Box<dyn FnMut(&Submit)>;

/// 路上的事。
#[derive(Debug, Clone, Copy, PartialEq)]
enum Pending {
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
enum Then {
    /// 第一次显示。
    Show,
    /// 画的是备用槽：换上。
    Swap,
    /// 画的是看得见的槽：完了。
    Keep,
}

/// 一张打开着的钉图。
struct Live {
    key: String,
    pin: SavedPin,
    /// 看得见的槽的窗口；还没显示为 `None`。
    window: Option<ScreenRect>,
    /// 上一次画进看得见的槽的内容矩形。
    drawn: ScreenRect,
    /// 上一次绘制之后，除了位置还有没有别的变化（透明度、换了源图）。
    fresh: bool,
    pending: Option<Pending>,
    /// 路上有事时来的更新：是否手势中。
    dirty: Option<bool>,
    gesture_until: Option<Instant>,
    /// 滚轮缩放的锚点与取锚点时的光标。
    anchor: Option<((i32, i32), ZoomAnchor)>,
    /// 拖动：按下时的指针与钉图左上角。
    drag: Option<((i32, i32), (i32, i32))>,
    /// 最近一次要的源图，与它到了没有。
    requested: SourceSize,
    loaded: bool,
    closing: bool,
}

pub struct Orchestra<S: PinShell, R: RenderPort> {
    shell: S,
    render: R,
    pins: BTreeMap<PinId, Live>,
    next: u64,
    displays: Vec<(ScreenRect, Option<Arc<[u8]>>)>,
    effects: Vec<Effect>,
    on_submit: Option<OnSubmit>,
}

impl<S: PinShell, R: RenderPort> Orchestra<S, R> {
    pub fn new(mut shell: S, render: R) -> Self {
        shell.set_keys(PinKeys::new([Key::Escape]));
        let displays = to_displays(shell.displays());
        Orchestra {
            shell,
            render,
            pins: BTreeMap::new(),
            next: 1,
            displays,
            effects: Vec::new(),
            on_submit: None,
        }
    }

    /// 每次提交前调用（逐帧核对要在画面上屏之前知道它）。
    pub fn on_submit(&mut self, f: impl FnMut(&Submit) + 'static) {
        self.on_submit = Some(Box::new(f));
    }

    /// 打开一张钉图：建窗口槽，要源图；图到了以后画好再显示。已经开着时什么都不做。
    pub fn open(&mut self, pin: SavedPin) -> Result<(), String> {
        if self.id_of(&pin.id).is_some() {
            return Ok(());
        }
        let id = PinId(self.next);
        self.next += 1;
        let targets = self.shell.create(id).map_err(|e| e.to_string())?;
        self.render.attach(id, targets);
        let size = source_size(&pin, false);
        self.render.load(id, &pin, size);
        self.pins.insert(
            id,
            Live {
                key: pin.id.clone(),
                drawn: pin.rect(),
                pin,
                window: None,
                fresh: false,
                pending: None,
                dirty: None,
                gesture_until: None,
                anchor: None,
                drag: None,
                requested: size,
                loaded: false,
                closing: false,
            },
        );
        Ok(())
    }

    /// 关掉一张钉图：先让渲染层丢掉 Surface，报完再关窗口（[`Effect::Closed`]）。
    pub fn close(&mut self, key: &str) {
        let Some(id) = self.id_of(key) else { return };
        let live = self.pins.get_mut(&id).expect("刚找到");
        if !std::mem::replace(&mut live.closing, true) {
            self.render.detach(id);
        }
    }

    /// 没有打开着的钉图了：应用壳可以丢掉整个编排（平台层与渲染层）。
    pub fn is_empty(&self) -> bool {
        self.pins.is_empty()
    }

    pub fn take_effects(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    /// 最早一个手势在什么时候结束；到时调 [`Orchestra::tick`]。
    pub fn next_deadline(&self) -> Option<Instant> {
        self.pins.values().filter_map(|l| l.gesture_until).min()
    }

    /// 取出平台层排着的输入并处理。
    pub fn pump(&mut self, now: Instant) {
        for input in self.shell.pump() {
            self.input(input, now);
        }
    }

    /// 到时的手势收尾：窗口收回刚好盖住钉图，按显示尺寸换源图。
    pub fn tick(&mut self, now: Instant) {
        let due: Vec<PinId> = self
            .pins
            .iter()
            .filter(|(_, l)| l.gesture_until.is_some_and(|t| now >= t))
            .map(|(id, _)| *id)
            .collect();
        for id in due {
            let live = self.pins.get_mut(&id).expect("刚列出");
            live.gesture_until = None;
            live.anchor = None;
            let size = source_size(&live.pin, false);
            if size != live.requested && !live.closing {
                live.requested = size;
                self.render.load(id, &live.pin, size);
            }
            self.update(id, false);
        }
    }

    pub fn input(&mut self, input: PinInput, now: Instant) {
        match input {
            PinInput::Swapped { pin, .. } => self.swapped(pin),
            PinInput::Wheel {
                pin,
                at,
                notches,
                ctrl,
            } => self.wheel(pin, at, notches, ctrl, now),
            PinInput::Pointer(p) => self.pointer(p, now),
            PinInput::Key { pin, key, .. } => {
                if key == Key::Escape
                    && let Some(live) = self.live(pin)
                {
                    let key = live.key.clone();
                    self.effects.push(Effect::CloseRequested(key));
                }
            }
            PinInput::DisplaysChanged => {
                self.displays = to_displays(self.shell.displays());
                let ids: Vec<PinId> = self.pins.keys().copied().collect();
                for id in ids {
                    self.update(id, false);
                }
            }
            PinInput::KeyHook(event) => self.effects.push(hook_warning(event)),
        }
    }

    pub fn render_event(&mut self, event: RenderEvent) {
        match event {
            RenderEvent::Drawn { pin, result } => self.drawn(pin, result),
            RenderEvent::Loaded { pin, size } => {
                let Some(live) = self.live(pin) else { return };
                if size != live.requested {
                    return;
                }
                live.loaded = true;
                live.fresh = false;
                let gesture = live.gesture_until.is_some();
                self.update(pin, gesture);
            }
            RenderEvent::LoadFailed { pin, reason } => {
                if self.live(pin).is_some() {
                    self.effects.push(Effect::Warn("原生钉图读不到图", reason));
                    self.give_up_unshown(pin);
                }
            }
            RenderEvent::Detached { pin } => {
                if let Some(live) = self.pins.remove(&pin) {
                    self.shell.close(pin);
                    self.effects.push(Effect::Closed(live.key));
                }
            }
        }
    }

    fn id_of(&self, key: &str) -> Option<PinId> {
        self.pins
            .iter()
            .find(|(_, l)| l.key == key)
            .map(|(id, _)| *id)
    }

    /// 打开着、没在关的钉图。
    fn live(&mut self, pin: PinId) -> Option<&mut Live> {
        self.pins.get_mut(&pin).filter(|l| !l.closing)
    }

    fn wheel(&mut self, pin: PinId, at: (i32, i32), notches: f64, ctrl: bool, now: Instant) {
        let Some(live) = self.live(pin) else { return };
        // 前端的 deltaY：向下为正，一格 100。
        let delta_y = -notches * 100.0;
        if ctrl {
            let before = live.pin.opacity;
            live.pin.set_opacity(wheel_opacity(before, delta_y));
            if live.pin.opacity == before {
                return;
            }
            live.fresh = false;
        } else {
            let anchor = match live.anchor {
                Some((cursor, anchor)) if cursor == at => anchor,
                _ => ZoomAnchor::new(&live.pin, (f64::from(at.0), f64::from(at.1))),
            };
            live.anchor = Some((at, anchor));
            let scale = wheel_zoom_scale(live.pin.placement.scale, delta_y);
            if !anchor.zoom(&mut live.pin, scale) {
                return;
            }
        }
        self.changed(pin, now);
    }

    fn pointer(&mut self, p: Pointer, now: Instant) {
        let Some(live) = self.live(p.pin) else { return };
        match p.event {
            PointerEvent::Down(PointerButton::Primary) => {
                live.drag = Some((p.at, (live.pin.placement.x, live.pin.placement.y)));
                self.shell.raise(p.pin);
            }
            PointerEvent::Move => {
                let Some((start, origin)) = live.drag else {
                    return;
                };
                let (x, y) = (origin.0 + p.at.0 - start.0, origin.1 + p.at.1 - start.1);
                if (x, y) == (live.pin.placement.x, live.pin.placement.y) || !live.pin.move_to(x, y)
                {
                    return;
                }
                self.changed(p.pin, now);
            }
            PointerEvent::Up(_) | PointerEvent::Cancel => {
                live.drag = None;
            }
            PointerEvent::Down(PointerButton::Secondary) | PointerEvent::Leave => {}
        }
    }

    /// 输入改了钉图：保存，手势延长到 [`SETTLE_MS`] 之后，上屏。
    fn changed(&mut self, pin: PinId, now: Instant) {
        let live = self.pins.get_mut(&pin).expect("调用方已找到");
        live.gesture_until = Some(now + Duration::from_millis(SETTLE_MS));
        self.effects.push(Effect::Saved(live.pin.clone()));
        self.update(pin, true);
    }

    /// 按钉图现在的状态走一次 [`plan`]。路上有事时先记下。
    fn update(&mut self, pin: PinId, gesture: bool) {
        let monitors: Vec<ScreenRect> = self.displays.iter().map(|(r, _)| *r).collect();
        let Some(live) = self.pins.get_mut(&pin).filter(|l| !l.closing) else {
            return;
        };
        if live.pending.is_some() {
            live.dirty = Some(live.dirty.unwrap_or(false) || gesture);
            return;
        }
        if !live.loaded {
            return;
        }
        let content = live.pin.rect();
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
                    let submit = submit(pin, live, to);
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
                    let submit = submit(pin, live, to);
                    self.submit(&submit);
                    self.shell.stage(pin, to);
                    (1 - visible, to, Then::Swap)
                }
            },
        };
        let live = self.pins.get_mut(&pin).expect("上面找到");
        live.fresh = true;
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
            display: display_at(&self.displays, content),
        };
        if then != Then::Swap {
            let submit = submit(pin, live, window);
            self.submit(&submit);
        }
        self.render.draw(job);
    }

    fn submit(&mut self, s: &Submit) {
        if let Some(f) = &mut self.on_submit {
            f(s);
        }
    }

    fn drawn(&mut self, pin: PinId, result: Result<(), String>) {
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
    fn give_up_unshown(&mut self, pin: PinId) {
        let Some(live) = self.pins.get_mut(&pin) else {
            return;
        };
        if live.window.is_some() || std::mem::replace(&mut live.closing, true) {
            return;
        }
        self.effects.push(Effect::Failed(live.key.clone()));
        self.render.detach(pin);
    }

    fn swapped(&mut self, pin: PinId) {
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

#[cfg(test)]
impl<S: PinShell, R: RenderPort> Orchestra<S, R> {
    pub fn shell(&mut self) -> &mut S {
        &mut self.shell
    }

    pub fn render(&mut self) -> &mut R {
        &mut self.render
    }
}

fn submit(pin: PinId, live: &Live, window: ScreenRect) -> Submit {
    Submit {
        pin,
        content: live.pin.rect(),
        window,
        scale: live.pin.placement.scale,
        opacity: live.pin.opacity,
    }
}

fn to_displays(displays: Vec<Display>) -> Vec<(ScreenRect, Option<Arc<[u8]>>)> {
    displays
        .into_iter()
        .map(|d| (d.rect, d.profile.map(Arc::from)))
        .collect()
}

/// 钉图中心所在的显示器的配置文件；中心不在任何显示器上时取第一台碰到的。
fn display_at(
    displays: &[(ScreenRect, Option<Arc<[u8]>>)],
    content: ScreenRect,
) -> Option<Arc<[u8]>> {
    let centre = ScreenRect {
        x: content.x.saturating_add((content.width / 2) as i32),
        y: content.y.saturating_add((content.height / 2) as i32),
        width: 1,
        height: 1,
    };
    displays
        .iter()
        .find(|(r, _)| r.contains(&centre))
        .or_else(|| {
            displays
                .iter()
                .find(|(r, _)| r.intersect(&content).is_some())
        })
        .and_then(|(_, p)| p.clone())
}

fn hook_warning(event: HookEvent) -> Effect {
    match event {
        HookEvent::Reinstalled { late_ms } => {
            Effect::Warn("钉图键盘钩子送达太晚，已重装", format!("晚了 {late_ms} ms"))
        }
        HookEvent::Failed { code } => Effect::Warn(
            "钉图键盘钩子装不上，钉图快捷键不可用",
            format!("错误码 {code}"),
        ),
    }
}

#[cfg(test)]
mod tests;
