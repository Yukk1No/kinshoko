//! GPU 设备丢失（驱动重启、远程桌面切换）之后重新显示（#277“设备丢失能重建”）。
//!
//! 渲染层发现设备丢了就丢掉所有 Surface、图与设备，报 [`RenderEvent::DeviceLost`]。这里给每张钉图向
//! 平台层要同一对窗口的新目标（[`PinShell::retarget`]），重新挂上、重新读图，图到了按第一次显示的
//! 路子画好再 `show`。窗口、摆放、遮蔽、贴边都还在，只是这一会儿看不见。
//!
//! [`RenderEvent::DeviceLost`]: super::RenderEvent::DeviceLost

use kinshoko_core::desktop::frame::source_size;
use pin_shell::{PinId, PinShell};

use super::screen::Pending;
use super::{Effect, Orchestra, RenderPort};

impl<S: PinShell, R: RenderPort> Orchestra<S, R> {
    pub(super) fn device_lost(&mut self) {
        self.effects
            .push(Effect::Warn("原生钉图 GPU 设备丢失", "重建".to_owned()));
        let ids: Vec<PinId> = self.pins.keys().copied().collect();
        for id in ids {
            let live = self.pins.get_mut(&id).expect("刚列出");
            if live.closing {
                continue;
            }
            // 路上的绘制、换窗都作废。绘制的回报随后到，重建后画占位时已经有新的 `pending`，
            // 要记下丢掉它；换窗随 `retarget` 取消，不会再报。
            live.stale_draw |= matches!(live.pending, Some(Pending::Draw { .. }));
            live.pending = None;
            live.dirty = None;
            live.fresh = false;
            if live.window.is_some() {
                live.window = None;
                live.restoring = Some(self.now);
            }
            let targets = match self.shell.retarget(id) {
                Ok(t) => t,
                Err(e) => {
                    // 再也画不上：收掉，免得留下一张看不见的钉图（与第一次显示失败相同）。
                    self.effects
                        .push(Effect::Warn("原生钉图设备丢失后换不了目标", e.to_string()));
                    live.closing = true;
                    self.effects.push(Effect::Failed(live.key.clone()));
                    self.render.detach(id);
                    continue;
                }
            };
            self.render.attach(id, targets);
            let live = self.pins.get_mut(&id).expect("刚列出");
            if live.look.unavailable.is_some() {
                // 已知读不到：照旧画占位。
                live.placeholder = true;
                live.loaded = true;
                live.loading = false;
                let gesture = live.gesture_until.is_some();
                self.update(id, gesture);
            } else {
                live.requested = source_size(&live.pin, live.look.veiled);
                live.loaded = false;
                live.loading = true;
                self.render.load(id, &live.pin, live.requested);
            }
        }
    }
}
