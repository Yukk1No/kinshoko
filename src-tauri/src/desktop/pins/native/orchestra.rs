//! 原生钉图的编排（#277、ADR 0013）：输入（[`PinShell::pump`]）与应用壳的帧（[`Frame`]）→ 改
//! [`SavedPin`] → [`plan`](kinshoko_core::desktop::frame::plan) → 平台层与渲染层。不认识 Tauri，也不认识
//! 具体的平台层与渲染层：测试用假平台层（`FakeShell`）和一个只记录的假渲染层。
//!
//! 分工：
//! - 这里：打开、关闭、到时的收尾、把输入与渲染层的回报分给下面几块；
//! - [`screen`]：每一帧怎么上屏（重画、平移、换窗），路上有事时先记下；
//! - [`gesture`]：指针、滚轮、按键，按住开菜单；
//! - [`frames`]：应用壳推来的帧（菜单动作、贴边隐藏、遮蔽、设置）。
//!
//! 内容此刻在哪由 [`ContentMotion`] 按时间求出：缩放（滚轮、拖角、“原始大小”）以 `ZOOM_MS`、贴边以
//! `SLIDE_MS` 的 `easeOutCubic` 从此刻看到的位置过渡到新目标，动画中再来输入就从当前位置重新计时
//! （与钉图层的 `motion.retarget` 相同）。动画中每 [`ANIM_FRAME`] 上屏一次。
//!
//! 手势（滚轮、拖动、动画）在最后一次变化、动画结束后 [`SETTLE_MS`] 结束（[`Orchestra::tick`]）：
//! 窗口收回刚好盖住钉图，再按显示尺寸要一张派生图（[`source_size`]）。

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use kinshoko_core::desktop::frame::{ContentMotion, Monitor, SourceSize, source_size};
use kinshoko_core::desktop::{SavedPin, ScreenRect};
use pin_shell::{Display, HookEvent, Key, PinCursor, PinId, PinInput, PinKeys, PinShell};

use super::port::{RenderEvent, RenderPort};

mod frames;
mod gesture;
mod screen;

#[cfg(test)]
use frames::View;
pub use frames::{Frame, Look};
use gesture::Gesture;
use screen::Pending;

/// 停手多久算手势结束（ADR 0005、#281）。
pub const SETTLE_MS: u64 = 120;
/// 动画中多久上屏一次：比最快的显示器的刷新周期还短，合成器每次刷新取最新的一次提交。
pub const ANIM_FRAME: Duration = Duration::from_millis(4);
/// 提示在钉图上留多久（钉图层 `PinView` 的 1600 ms）。
pub const NOTICE_MS: u64 = 1600;
/// 读不到图、又没有别的原因时写的话（钉图层 `PinView` 的同一句）。
pub const MISSING: &str = "参考图无法读取：图库没有打开，或原图已缺失";
/// 光标在钉图上时拦下的键：Esc 关闭，H／V 翻转，R／Shift+R 旋转。菜单打开时一个都不拦。
const KEYS: [Key; 4] = [
    Key::Escape,
    Key::Letter('H'),
    Key::Letter('V'),
    Key::Letter('R'),
];

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
    /// 画师要打开这张钉图的菜单（鼠标右键、笔的侧键、笔或触摸按住）。键盘钩子已不拦键；菜单
    /// 关掉后调 [`Orchestra::menu_closed`]。
    Menu(String),
    /// 画师点了遮蔽钉图上的小圆锁：在菜单窗口里问“显示这张图？”。
    RevealAsked(String),
    /// 收起（贴边隐藏）着的钉图被画师就地拖动、缩放或翻转了：从此刻的位置算起，不再算收起。
    Released(String),
    /// 写进运行日志的警告。
    Warn(&'static str, String),
}

/// 一次提交：给逐帧核对（`tools/pin-frame-check`）记录屏幕上应当出现的画面。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Submit {
    pub pin: PinId,
    pub content: ScreenRect,
    pub window: ScreenRect,
    /// 这一帧显示的缩放比例（动画中途不是钉图保存的比例）。
    pub scale: f64,
    pub opacity: f64,
}

type OnSubmit = Box<dyn FnMut(&Submit)>;

/// 一张打开着的钉图。
struct Live {
    key: String,
    pin: SavedPin,
    look: Look,
    /// 内容静止时在哪：一般是钉图的原位，贴边收起、滑出时是那里。
    target: ScreenRect,
    /// 收起（贴边隐藏）着：`target` 不是原位。
    tucked: bool,
    click_through: bool,
    /// 内容此刻在哪（缩放、贴边的动画）。
    motion: ContentMotion,
    /// 确认显示后遮蔽淡出：清晰的源图还没到时为 `Waiting`。
    reveal: Reveal,
    /// 看得见的槽的窗口；还没显示为 `None`。
    window: Option<ScreenRect>,
    /// 上一次画进看得见的槽的内容矩形。
    drawn: ScreenRect,
    /// 上一次绘制之后，除了位置还有没有别的变化（透明度、换了源图、换了显示器配置文件）。
    fresh: bool,
    /// 上一次绘制按哪个显示器配置文件转的颜色。
    profile: Option<Arc<[u8]>>,
    pending: Option<Pending>,
    /// 路上有事时来的更新：是否手势中。
    dirty: Option<bool>,
    gesture_until: Option<Instant>,
    /// 动画中下一次上屏的时刻。
    frame_due: Option<Instant>,
    /// 滚轮缩放的锚点与取锚点时的光标。
    anchor: Option<((i32, i32), kinshoko_core::desktop::frame::ZoomAnchor)>,
    /// 按着的指针。
    gesture: Option<Gesture>,
    cursor: PinCursor,
    /// 最近一次要的源图，与它到了没有。
    requested: SourceSize,
    /// `requested` 还在路上。
    loading: bool,
    loaded: bool,
    /// 读不到图：画灰色占位与原因。
    placeholder: bool,
    /// 第一次显示的时刻（毫秒）：出现提示框从这时渐隐。渐隐完了为 `None`。
    appeared: Option<f64>,
    /// 底部的提示与它消失的时刻。
    notice: Option<(String, Instant)>,
    closing: bool,
}

/// 确认显示之后的遮蔽。
#[derive(Debug, Clone, Copy, PartialEq)]
enum Reveal {
    /// 没在淡出：遮蔽与否看 [`Look::veiled`]。
    Idle,
    /// 已确认显示，清晰的源图还没到：先保持遮蔽。
    Waiting,
    /// 从这一刻（毫秒）开始淡出。
    Fading(f64),
}

/// 一台显示器：矩形、缩放比例、颜色配置文件。
struct Screen {
    rect: ScreenRect,
    scale: f64,
    profile: Option<Arc<[u8]>>,
}

pub struct Orchestra<S: PinShell, R: RenderPort> {
    shell: S,
    render: R,
    pins: BTreeMap<PinId, Live>,
    next: u64,
    screens: Vec<Screen>,
    effects: Vec<Effect>,
    on_submit: Option<OnSubmit>,
    /// 动画时间的原点与此刻（每个入口先记下 `now`）。
    epoch: Instant,
    now: Instant,
    /// 菜单开着：键盘钩子不拦键。
    menu_open: bool,
    /// 最近一次开菜单的时刻：同一次按下引出的几个事件只开一次。
    menu_at: Option<Instant>,
}

impl<S: PinShell, R: RenderPort> Orchestra<S, R> {
    pub fn new(mut shell: S, render: R) -> Self {
        shell.set_keys(PinKeys::new(KEYS));
        let screens = to_screens(shell.displays());
        let now = Instant::now();
        Orchestra {
            shell,
            render,
            pins: BTreeMap::new(),
            next: 1,
            screens,
            effects: Vec::new(),
            on_submit: None,
            epoch: now,
            now,
            menu_open: false,
            menu_at: None,
        }
    }

    /// 每次提交前调用（逐帧核对要在画面上屏之前知道它）。
    pub fn on_submit(&mut self, f: impl FnMut(&Submit) + 'static) {
        self.on_submit = Some(Box::new(f));
    }

    /// 打开一张钉图：建窗口槽，要源图；图到了以后画好再显示。已经开着时什么都不做。
    pub fn open(&mut self, frame: Frame, now: Instant) -> Result<(), String> {
        self.now = now;
        if self.id_of(&frame.pin.id).is_some() {
            return Ok(());
        }
        let id = PinId(self.next);
        self.next += 1;
        let targets = self.shell.create(id).map_err(|e| e.to_string())?;
        self.render.attach(id, targets);
        let size = source_size(&frame.pin, frame.look.veiled);
        // 已知读不到（资料库不可用、本设备没登记、原图不在，#66）：不读，直接画占位。
        let placeholder = frame.look.unavailable.is_some();
        if !placeholder {
            self.render.load(id, &frame.pin, size);
        }
        if frame.click_through {
            self.shell.set_click_through(id, true);
        }
        let at = self.ms(now);
        self.pins.insert(
            id,
            Live {
                key: frame.pin.id.clone(),
                tucked: frame.content != frame.pin.rect(),
                target: frame.content,
                motion: ContentMotion::new(frame.content.into(), at),
                drawn: frame.content,
                pin: frame.pin,
                look: frame.look,
                click_through: frame.click_through,
                reveal: Reveal::Idle,
                window: None,
                fresh: false,
                profile: None,
                pending: None,
                dirty: None,
                gesture_until: None,
                frame_due: None,
                anchor: None,
                gesture: None,
                cursor: PinCursor::Arrow,
                requested: size,
                loading: !placeholder,
                loaded: placeholder,
                placeholder,
                appeared: None,
                notice: None,
                closing: false,
            },
        );
        if placeholder {
            self.update(id, false);
        }
        Ok(())
    }

    /// 在钉图底部显示一条提示（菜单动作的结果），[`NOTICE_MS`] 后消失。钉图不在时什么都不做。
    pub fn notice(&mut self, key: &str, text: String, now: Instant) {
        self.now = now;
        let Some(id) = self.id_of(key) else { return };
        let Some(live) = self.live(id) else { return };
        live.notice = Some((text, now + Duration::from_millis(NOTICE_MS)));
        live.fresh = false;
        let gesture = live.gesture_until.is_some();
        self.update(id, gesture);
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

    /// 下一件到时的事（手势结束、动画的下一帧、按住开菜单）；到时调 [`Orchestra::tick`]。
    pub fn next_deadline(&self) -> Option<Instant> {
        self.pins
            .values()
            .filter(|l| !l.closing)
            .flat_map(|l| {
                [
                    // 指针还按着时不收尾，松开时重新计时。
                    l.gesture_until.filter(|_| l.gesture.is_none()),
                    l.frame_due,
                    l.gesture.as_ref().and_then(Gesture::hold_due),
                    l.notice.as_ref().map(|(_, until)| *until),
                ]
            })
            .flatten()
            .min()
    }

    /// 取出平台层排着的输入并处理。
    pub fn pump(&mut self, now: Instant) {
        for input in self.shell.pump() {
            self.input(input, now);
        }
    }

    /// 到时的事：按住开菜单、动画的下一帧、手势收尾（窗口收回刚好盖住钉图，按显示尺寸换源图）。
    pub fn tick(&mut self, now: Instant) {
        self.now = now;
        self.check_holds(now);
        let ids: Vec<PinId> = self.pins.keys().copied().collect();
        for id in ids {
            let live = self.pins.get_mut(&id).expect("刚列出");
            if live.closing {
                continue;
            }
            if live.notice.as_ref().is_some_and(|(_, until)| now >= *until) {
                live.notice = None;
                live.fresh = false;
                live.frame_due = Some(now);
            }
            if live.gesture_until.is_some_and(|t| now >= t) && live.gesture.is_none() {
                live.gesture_until = None;
                live.frame_due = None;
                live.anchor = None;
                let size = source_size(&live.pin, live.look.veiled);
                if size != live.requested {
                    live.requested = size;
                    live.loading = true;
                    self.render.load(id, &live.pin, size);
                }
                self.update(id, false);
            } else if live.frame_due.is_some_and(|t| now >= t) {
                live.frame_due = None;
                let gesture = live.gesture_until.is_some();
                self.update(id, gesture);
            }
        }
    }

    pub fn input(&mut self, input: PinInput, now: Instant) {
        self.now = now;
        match input {
            PinInput::Swapped { pin, .. } => self.swapped(pin),
            PinInput::Wheel {
                pin,
                at,
                notches,
                ctrl,
            } => self.wheel(pin, at, notches, ctrl),
            PinInput::Pointer(p) => self.pointer(p),
            PinInput::Key {
                pin, key, shift, ..
            } => self.key(pin, key, shift),
            PinInput::DisplaysChanged => {
                self.screens = to_screens(self.shell.displays());
                let ids: Vec<PinId> = self.pins.keys().copied().collect();
                for id in ids {
                    let gesture = self.pins[&id].gesture_until.is_some();
                    self.update(id, gesture);
                }
            }
            PinInput::KeyHook(event) => self.effects.push(hook_warning(event)),
        }
    }

    pub fn render_event(&mut self, event: RenderEvent, now: Instant) {
        self.now = now;
        match event {
            RenderEvent::Drawn { pin, result } => self.drawn(pin, result),
            RenderEvent::Loaded { pin, size } => {
                let at = self.ms(now);
                let Some(live) = self.live(pin) else { return };
                if size != live.requested {
                    return;
                }
                live.loaded = true;
                live.loading = false;
                live.placeholder = false;
                live.fresh = false;
                if live.reveal == Reveal::Waiting {
                    live.reveal = Reveal::Fading(at);
                }
                let gesture = live.gesture_until.is_some();
                self.update(pin, gesture);
            }
            RenderEvent::LoadFailed { pin, reason } => {
                if let Some(live) = self.live(pin) {
                    // 画占位与原因（钉图层也是这样）；已有图时留着原来的图。
                    live.loading = false;
                    let first = !std::mem::replace(&mut live.loaded, true);
                    if first {
                        live.placeholder = true;
                        live.fresh = false;
                    }
                    let gesture = live.gesture_until.is_some();
                    self.effects.push(Effect::Warn("原生钉图读不到图", reason));
                    if first {
                        self.update(pin, gesture);
                    }
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

    /// 平台层（应用壳查窗口句柄用）。
    pub fn platform(&self) -> &S {
        &self.shell
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

    /// 从动画时间的原点算起的毫秒。
    fn ms(&self, t: Instant) -> f64 {
        match t.checked_duration_since(self.epoch) {
            Some(d) => d.as_secs_f64() * 1000.0,
            None => -(self.epoch - t).as_secs_f64() * 1000.0,
        }
    }

    fn monitors(&self) -> Vec<Monitor> {
        self.screens
            .iter()
            .map(|s| Monitor {
                rect: s.rect,
                scale: s.scale,
            })
            .collect()
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

fn to_screens(displays: Vec<Display>) -> Vec<Screen> {
    displays
        .into_iter()
        .map(|d| Screen {
            rect: d.rect,
            scale: d.scale,
            profile: d.profile.map(Arc::from),
        })
        .collect()
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
