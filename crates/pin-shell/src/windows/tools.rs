//! 只给测试与逐帧核对工具（`tools/pin-frame-check`）用的口子，编排不要用。

use super::{SWP_NOZORDER, SWP_SHOWWINDOW, WinShell, set_pos};
use crate::{PinId, ScreenRect};

impl WinShell {
    #[doc(hidden)]
    /// 对照组，只给逐帧核对工具证明它抓得到错位：直接改可见槽的位置与尺寸，`present` 里渲染层往
    /// 可见槽画，再提交。`present_first` 时先画后改窗口。这正是 ADR 0013 否决的做法，别处不要用。
    pub fn control_group(
        &mut self,
        pin: PinId,
        rect: ScreenRect,
        present_first: bool,
        present: impl FnOnce(),
    ) {
        let hwnd = {
            let mut s = self.state.borrow_mut();
            let Some(p) = s.pin(pin) else { return };
            p.slots.show(rect);
            p.windows[p.slots.visible()].hwnd
        };
        let place = || set_pos(hwnd, None, Some(rect), SWP_NOZORDER | SWP_SHOWWINDOW);
        if present_first {
            present();
            place();
        } else {
            place();
            present();
        }
        self.state.borrow().commit();
    }

    #[doc(hidden)]
    /// 某个槽的窗口（测试与核对工具用）。
    pub fn hwnd(&self, pin: PinId, slot: usize) -> Option<isize> {
        let s = self.state.borrow();
        s.pins.get(&pin).map(|p| p.windows[slot].hwnd.0 as isize)
    }
}
