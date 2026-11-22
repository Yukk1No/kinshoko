//! 没有钉图可承载的提示：复用说明层、原生窗口与渲染线程，不进入钉图记录。

use kinshoko_core::desktop::{PinContent, Placement};

use super::*;
use crate::desktop::pins::native::caption::Caption;
use crate::desktop::pins::native::port::DrawJob;

pub(super) struct NoticeSurface {
    window: ScreenRect,
    pub until: Option<Instant>,
    closing: bool,
}

impl<S: PinShell, R: RenderPort> Orchestra<S, R> {
    /// 没有打开着的钉图了：应用壳可以丢掉整个编排（平台层与渲染层）。
    pub fn is_empty(&self) -> bool {
        self.pins.is_empty() && self.notices.is_empty()
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

    pub fn notice_at(
        &mut self,
        cursor: (i32, i32),
        text: String,
        now: Instant,
    ) -> Result<(), String> {
        self.now = now;
        if text.is_empty() {
            return Ok(());
        }
        let screen = self
            .screens
            .iter()
            .find(|s| {
                cursor.0 >= s.rect.x
                    && cursor.1 >= s.rect.y
                    && i64::from(cursor.0) < i64::from(s.rect.x) + i64::from(s.rect.width)
                    && i64::from(cursor.1) < i64::from(s.rect.y) + i64::from(s.rect.height)
            })
            .or_else(|| self.screens.first())
            .ok_or("No display for pin notice")?;
        let scale = screen.scale;
        let width = (520.0 * scale).round().max(1.0) as u32;
        let height = (40.0 * scale).round().max(1.0) as u32;
        let width = width.min(screen.rect.width.max(1));
        let height = height.min(screen.rect.height.saturating_sub(1).max(1));
        let gap = (12.0 * scale).round() as i32;
        let window = ScreenRect {
            x: cursor.0.saturating_add(gap).clamp(
                screen.rect.x,
                screen
                    .rect
                    .x
                    .saturating_add((screen.rect.width - width) as i32),
            ),
            y: cursor.1.saturating_add(gap).clamp(
                screen.rect.y,
                screen
                    .rect
                    .y
                    .saturating_add(screen.rect.height.saturating_sub(height + 1) as i32),
            ),
            width,
            height,
        };
        let display = screen.profile.clone();
        let id = PinId(self.next);
        self.next += 1;
        let targets = self.shell.create(id).map_err(|e| e.to_string())?;
        for (old, n) in &mut self.notices {
            if !n.closing {
                n.closing = true;
                n.until = None;
                self.render.detach(*old);
            }
        }
        self.render.attach(id, targets);
        self.shell.set_click_through(id, true);
        self.notices.insert(
            id,
            NoticeSurface {
                window,
                until: None,
                closing: false,
            },
        );
        self.render.draw(DrawJob {
            pin: id,
            slot: 0,
            window,
            content: window,
            state: SavedPin {
                id: String::new(),
                content: PinContent::Capture {
                    capture_id: String::new(),
                },
                crop: None,
                width,
                height,
                placement: Placement {
                    x: window.x,
                    y: window.y,
                    ..Placement::default()
                },
                opacity: 1.0,
                locked: true,
                member: None,
            },
            display,
            display_scale: scale,
            veil: 0.0,
            ring: false,
            appear: 0.0,
            dark: false,
            placeholder: true,
            caption_only: true,
            caption: Caption {
                notice: Some(text),
                ..Caption::default()
            },
        });
        Ok(())
    }

    pub(super) fn expire_notices(&mut self, now: Instant) {
        for (id, n) in &mut self.notices {
            if !n.closing && n.until.is_some_and(|until| now >= until) {
                n.closing = true;
                n.until = None;
                self.render.detach(*id);
            }
        }
    }

    pub(super) fn notice_event(&mut self, event: &RenderEvent, now: Instant) -> bool {
        match event {
            RenderEvent::Drawn { pin, result } if self.notices.contains_key(pin) => {
                let n = self.notices.get_mut(pin).expect("notice exists");
                if !n.closing {
                    if result.is_ok() {
                        self.shell.show(*pin, n.window);
                        n.until = Some(now + Duration::from_millis(NOTICE_MS));
                    } else {
                        n.closing = true;
                        self.render.detach(*pin);
                    }
                }
                true
            }
            RenderEvent::Detached { pin } if self.notices.remove(pin).is_some() => {
                self.shell.close(*pin);
                true
            }
            RenderEvent::DeviceLost => {
                for (id, _) in std::mem::take(&mut self.notices) {
                    self.render.detach(id);
                    self.shell.close(id);
                }
                false
            }
            _ => false,
        }
    }
}
