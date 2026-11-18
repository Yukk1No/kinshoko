//! 钉图状态存在哪里：旧的 `pins.json`（[`PinStore`]），或桌面上的参考组（[`Desk`]，#588、#591）。
//!
//! 由设置里界面上没有的开关 `deskReferenceGroups` 决定，启动恢复钉图时定下（[`super::pins::restore`]）。
//! 开关关着时一切照旧：调用方经这里做的每件事都与原来直接用 [`PinStore`] 时相同。
//!
//! 截图历史的钉住计数：钉上新钉图（[`PinState::add`]）和画师关掉钉图（[`PinState::close`]）时由这里
//! 成对地记，调用方不再自己调 `history.pin` / `history.unpin`。
//!
//! 锁的先后：参考组 → 钉图状态 → 截图历史。

use kinshoko_core::CommandError;
use kinshoko_core::desktop::{CaptureHistory, PinContent, PinStore, SavedPin, ScreenRect};
use kinshoko_core::reference_groups::{Desk, OpenedPins};

pub enum PinState {
    /// 开关关着：钉图只是工作状态，存在 `pins.json`。
    Legacy(PinStore),
    /// 开关打开：桌面上的参考组。
    Desk(Box<Desk>),
}

impl PinState {
    pub fn pins(&self) -> &[SavedPin] {
        match self {
            PinState::Legacy(store) => store.pins(),
            PinState::Desk(desk) => desk.pins(),
        }
    }

    pub fn get(&self, id: &str) -> Option<&SavedPin> {
        match self {
            PinState::Legacy(store) => store.get(id),
            PinState::Desk(desk) => desk.get(id),
        }
    }

    /// 改一张钉图（拖动、缩放、翻转、旋转、透明度、锁定）；桌面上的参考组跟着改。需要再 [`Self::save`]。
    pub fn edit<T>(&mut self, id: &str, edit: impl FnOnce(&mut SavedPin) -> T) -> Option<T> {
        match self {
            PinState::Legacy(store) => store.edit(id, edit),
            PinState::Desk(desk) => desk.edit(id, edit),
        }
    }

    /// 钉上一张新钉图，返回要打开的钉图（桌面上的参考组里，它记着自己是哪个成员）。截图钉图在截图
    /// 历史里记下钉住。开关关着时立即写回 `pins.json`。
    pub fn add(
        &mut self,
        pin: SavedPin,
        history: &mut CaptureHistory,
    ) -> Result<SavedPin, CommandError> {
        match self {
            PinState::Legacy(store) => {
                if let Some(capture) = pin.capture_id() {
                    history.pin(capture);
                }
                store.put(pin.clone());
                let _ = store.save();
                Ok(pin)
            }
            PinState::Desk(desk) => desk.pin(pin, history).map_err(CommandError::from),
        }
    }

    /// 已在截图历史里记过钉住的钉图（旧的“摆到桌面”打开参考组时）：放进钉图状态。
    pub fn put_opened(&mut self, pins: &[SavedPin]) {
        if let PinState::Legacy(store) = self {
            for pin in pins {
                store.put(pin.clone());
            }
            let _ = store.save();
        }
    }

    /// 画师关掉了钉图：不再恢复；截图钉图在截图历史里不再算钉住。`capture` 是本次运行里这张钉图
    /// 记着的截图（旧路径按它解除钉住）。返回截图历史有没有变。
    pub fn close(&mut self, id: &str, capture: Option<&str>, history: &mut CaptureHistory) -> bool {
        match self {
            PinState::Legacy(store) => {
                store.remove(id);
                let _ = store.save();
                if let Some(capture) = capture {
                    history.unpin(capture);
                    true
                } else {
                    false
                }
            }
            PinState::Desk(desk) => desk
                .close(id, history)
                .is_some_and(|p| p.capture_id().is_some()),
        }
    }

    /// 写回磁盘。写不进时改动留着，下次再写。
    pub fn save(&mut self) -> Result<(), String> {
        match self {
            PinState::Legacy(store) => store.save().map_err(|e| e.to_string()),
            PinState::Desk(desk) => desk.flush().map_err(|e| e.to_string()),
        }
    }

    /// 启动时恢复的钉图（见 [`PinStore::restore`]、[`Desk::restore`]）。
    pub fn restore(&mut self, history: &mut CaptureHistory, monitors: &[ScreenRect]) -> OpenedPins {
        match self {
            PinState::Legacy(store) => {
                let pins = store.restore(history, monitors);
                let _ = store.save();
                OpenedPins {
                    pins,
                    problems: Vec::new(),
                }
            }
            PinState::Desk(desk) => {
                let opened = desk.restore(history, monitors);
                // 拉回屏幕的位置马上写下（同旧路径）：之后不动钉图也不会丢。写不进时留着，下次再写。
                let _ = desk.flush();
                opened
            }
        }
    }

    pub fn desk(&mut self) -> Option<&mut Desk> {
        match self {
            PinState::Legacy(_) => None,
            PinState::Desk(desk) => Some(desk),
        }
    }

    pub fn is_desk(&self) -> bool {
        matches!(self, PinState::Desk(_))
    }

    /// 旧路径（存进参考组之后）：记下钉图成了哪个成员，已收藏的截图钉图改连参考图。返回改连了的钉图。
    /// 桌面上的参考组里钉图只属于桌面上那个参考组，不改。
    pub fn remember_members(&mut self, saved: &[SavedPin]) -> Vec<String> {
        let PinState::Legacy(store) = self else {
            return Vec::new();
        };
        let mut converted = Vec::new();
        for pin in saved {
            store.edit(&pin.id, |p| {
                p.member = pin.member.clone();
                if p.capture_id().is_some() && matches!(pin.content, PinContent::Reference { .. }) {
                    p.content = pin.content.clone();
                    converted.push(pin.id.clone());
                }
            });
        }
        let _ = store.save();
        converted
    }
}
