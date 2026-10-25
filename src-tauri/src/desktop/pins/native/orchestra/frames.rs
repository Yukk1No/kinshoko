//! 应用壳推来的帧：钉图层的 `PinFrame` 去掉层以后剩下的那些。菜单动作（翻转、旋转、原始大小、
//! 透明度、锁定）、贴边隐藏（收起、滑出、回到原位，点击穿透）、遮蔽与“增强钉图边缘”设置、
//! 参考组改引用，都由应用壳改好 `pins.json` 再推一帧过来。
//!
//! 几何的规则：帧里的 `content` 是内容静止时要到的位置；`motion` 决定怎么过去（缩放、滑动带动画）。
//! 只刷新外观的帧（`geometry` 为假：遮蔽、设置、改引用）不碰几何：应用壳那边的保存（这边拖动、
//! 缩放、按键之后）可能还没落地，几何以这边为准。

use std::time::{Duration, Instant};

use kinshoko_core::desktop::frame::{RectF, SLIDE_MS, ZOOM_MS, source_size};
use kinshoko_core::desktop::{PinMotion, SavedPin, ScreenRect};
use pin_shell::PinShell;

use super::super::port::RenderPort;
use super::{Orchestra, Reveal, SETTLE_MS};

/// 应用壳推来的一帧。
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub pin: SavedPin,
    /// 内容静止时要到的位置：一般是原位，贴边收起、滑出时是那里。
    pub content: ScreenRect,
    pub motion: PinMotion,
    /// 收起且没滑出：点击穿过它落到下面的程序。
    pub click_through: bool,
    /// 应用壳改了几何（菜单的翻转旋转、原始大小，贴边隐藏）；为假时只刷新外观。
    pub geometry: bool,
    pub look: Look,
}

/// 钉图的外观（钉图层 `PinFrame` 的同名字段）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Look {
    /// 原位遮蔽（安全模式）：只取 64 px 派生图，模糊并盖墨色。
    pub veiled: bool,
    /// 暂时不能显示的原因（#66）。
    pub unavailable: Option<String>,
    /// 增强钉图边缘（设置，#239）。
    pub edge_contrast: bool,
    /// 深色主题（跟随系统，与页面的 `prefers-color-scheme` 相同）。
    pub dark: bool,
}

impl Frame {
    /// 静止在原位、不穿透、按 `look` 显示的一帧（新钉的、恢复的钉图）。
    pub fn at_home(pin: SavedPin, look: Look) -> Frame {
        Frame {
            content: pin.rect(),
            pin,
            motion: PinMotion::Jump,
            click_through: false,
            geometry: true,
            look,
        }
    }
}

impl<S: PinShell, R: RenderPort> Orchestra<S, R> {
    /// 应用壳改了钉图（或它的外观）：照着帧显示。钉图不在时什么都不做。
    pub fn frame(&mut self, mut f: Frame, now: Instant) {
        self.now = now;
        let at = self.ms(now);
        let Some(id) = self.id_of(&f.pin.id) else {
            return;
        };
        let Some(live) = self.live(id) else { return };
        if !f.geometry {
            f.pin.placement = live.pin.placement;
            f.content = live.target;
            f.click_through = live.click_through;
        }
        // 换了图（收藏后改引用），或资料库回来了、占位可以换成图。
        let source_changed = f.pin.content != live.pin.content
            || f.pin.crop != live.pin.crop
            || (live.placeholder && f.look.unavailable.is_none() && !live.loading);
        let veil_changed = f.look.veiled != live.look.veiled;
        if live.look.veiled && !f.look.veiled {
            // 确认显示：清晰的源图到了才淡出（不必换图时马上淡出）。
            live.reveal = Reveal::Waiting;
        } else if f.look.veiled {
            live.reveal = Reveal::Idle;
        }
        live.tucked = f.content != f.pin.rect();
        live.target = f.content;
        live.pin = f.pin;
        live.look = f.look;
        live.fresh = false;
        if std::mem::replace(&mut live.click_through, f.click_through) != f.click_through {
            self.shell.set_click_through(id, f.click_through);
        }
        let live = self.pins.get_mut(&id).expect("上面找到");
        let duration = match f.motion {
            PinMotion::Zoom => ZOOM_MS,
            PinMotion::Slide => SLIDE_MS,
            PinMotion::Jump | PinMotion::Drag => 0,
        };
        let target = RectF::from(live.target);
        if live.motion.target() != target {
            live.motion.retarget(target, at, f64::from(duration));
            let until = now + Duration::from_millis(u64::from(duration) + SETTLE_MS);
            live.gesture_until = Some(live.gesture_until.map_or(until, |t| t.max(until)));
        }
        // 换了图（收藏后改引用）、遮蔽开关时马上换源图；缩放的源图等手势收尾再换。
        let size = source_size(&live.pin, live.look.veiled);
        if source_changed || (veil_changed && size != live.requested) {
            live.requested = size;
            live.loading = true;
            self.render.load(id, &live.pin, size);
        } else if live.reveal == Reveal::Waiting && !live.loading {
            live.reveal = Reveal::Fading(at);
        }
        let gesture = live.gesture_until.is_some();
        self.update(id, gesture);
    }
}
