//! 钉图状态：桌面上的参考组（[`Desk`]，#588）。钉图就是桌面上那个参考组的成员，改动直接记进它。
//!
//! 截图历史的钉住计数：钉上新钉图（[`PinState::add`]）和画师关掉钉图（[`PinState::close`]）时由桌面
//! 模块成对地记，调用方不再自己调 `history.pin` / `history.unpin`。
//!
//! 锁的先后：参考组 → 钉图状态 → 截图历史。

use kinshoko_core::CommandError;
use kinshoko_core::desktop::{CaptureHistory, SavedPin, ScreenRect};
use kinshoko_core::reference_groups::{Desk, OpenedPins};

pub struct PinState(Box<Desk>);

impl PinState {
    pub fn new(desk: Desk) -> PinState {
        PinState(Box::new(desk))
    }

    pub fn pins(&self) -> &[SavedPin] {
        self.0.pins()
    }

    pub fn get(&self, id: &str) -> Option<&SavedPin> {
        self.0.get(id)
    }

    /// 改一张钉图（拖动、缩放、翻转、旋转、透明度、锁定）；桌面上的参考组跟着改。需要再 [`Self::save`]。
    pub fn edit<T>(&mut self, id: &str, edit: impl FnOnce(&mut SavedPin) -> T) -> Option<T> {
        self.0.edit(id, edit)
    }

    /// 钉上一张新钉图，返回要打开的钉图（它记着自己是哪个成员）。截图钉图在截图历史里记下钉住。
    /// 需要再 [`Self::save`]。
    pub fn add(
        &mut self,
        pin: SavedPin,
        history: &mut CaptureHistory,
    ) -> Result<SavedPin, CommandError> {
        self.0.pin(pin, history).map_err(CommandError::from)
    }

    /// 画师关掉了钉图：它不再是桌面上参考组的成员；截图钉图在截图历史里不再算钉住。
    /// 返回截图历史有没有变。
    pub fn close(&mut self, id: &str, history: &mut CaptureHistory) -> bool {
        self.0
            .close(id, history)
            .is_some_and(|p| p.capture_id().is_some())
    }

    /// 写回磁盘。写不进时改动留着，下次再写。返回参考组列表上看不看得出（见 [`Desk::flush`]）。
    pub fn save(&mut self) -> Result<bool, String> {
        self.0.flush().map_err(|e| e.to_string())
    }

    /// 启动时恢复的钉图（见 [`Desk::restore`]）。
    pub fn restore(&mut self, history: &mut CaptureHistory, monitors: &[ScreenRect]) -> OpenedPins {
        let opened = self.0.restore(history, monitors);
        // 拉回屏幕的位置马上写下：之后不动钉图也不会丢。写不进时留着，下次再写。
        let _ = self.0.flush();
        opened
    }

    pub fn desk(&mut self) -> &mut Desk {
        &mut self.0
    }
}
