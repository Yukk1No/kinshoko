//! 换桌时把钉在别处的钉图拉回屏幕（同启动时的 [`Desk::restore`]）。

use super::Desk;
use crate::desktop::{ScreenRect, pull_onto_screen};

impl Desk {
    /// 整张不在当前显示器上的钉图（存在拔掉的显示器上、从别的布局导入）拉回屏幕，成员的摆放跟着改。
    /// 拉动了返回 `true`，这时有了没落盘的改动。
    pub fn pull_onto_screen(&mut self, monitors: &[ScreenRect]) -> bool {
        let mut moved = Vec::new();
        for pin in &mut self.pins {
            let (x, y) = pull_onto_screen(pin.rect(), monitors);
            if (x, y) != (pin.placement.x, pin.placement.y) {
                (pin.placement.x, pin.placement.y) = (x, y);
                moved.push(pin.clone());
            }
        }
        for pin in &moved {
            self.sync(pin);
        }
        self.dirty |= !moved.is_empty();
        !moved.is_empty()
    }
}
