//! 一张钉图两个槽的状态：哪个看得见、各自摆在哪、有没有等着换上的 `swap`。两个适配器共用；
//! 违反接口约定时返回 [`Misuse`]，Windows 适配器忽略那次调用，假实现直接 panic 让测试失败。

use kinshoko_core::desktop::ScreenRect;

/// 编排违反了 [`PinShell`](crate::PinShell) 的约定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Misuse {
    /// 可见槽还没 `show` 就平移。
    NotShown,
    /// `translate` 改了可见槽的尺寸。
    Resized,
    /// 备用槽还没 `stage` 就 `swap`。
    NotStaged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Slots {
    visible: usize,
    rects: [Option<ScreenRect>; 2],
    shown: bool,
    staged: bool,
    /// 等合成器收下的 `swap`：适配器给的序号。
    pending: Option<u64>,
}

impl Slots {
    pub fn new() -> Slots {
        Slots {
            visible: 0,
            rects: [None, None],
            shown: false,
            staged: false,
            pending: None,
        }
    }

    pub fn visible(&self) -> usize {
        self.visible
    }

    pub fn standby(&self) -> usize {
        1 - self.visible
    }

    /// 槽现在摆在哪（还没摆过为 None）。
    pub fn rect(&self, slot: usize) -> Option<ScreenRect> {
        self.rects[slot]
    }

    /// 看得见的窗口（还没显示为 None）。
    pub fn window(&self) -> Option<ScreenRect> {
        if self.shown {
            self.rects[self.visible]
        } else {
            None
        }
    }

    pub fn pending(&self) -> Option<u64> {
        self.pending
    }

    pub fn show(&mut self, rect: ScreenRect) {
        self.rects[self.visible] = Some(rect);
        self.shown = true;
    }

    pub fn translate(&mut self, rect: ScreenRect) -> Result<(), Misuse> {
        let now = self.window().ok_or(Misuse::NotShown)?;
        if (now.width, now.height) != (rect.width, rect.height) {
            return Err(Misuse::Resized);
        }
        self.rects[self.visible] = Some(rect);
        Ok(())
    }

    /// 摆备用槽；还没完成的 `swap` 作废。
    pub fn stage(&mut self, rect: ScreenRect) {
        self.rects[self.standby()] = Some(rect);
        self.staged = true;
        self.pending = None;
    }

    /// 记下要换窗，`ticket` 是适配器用来认“合成器收下了哪些”的序号。
    pub fn request_swap(&mut self, ticket: u64) -> Result<(), Misuse> {
        if !self.staged {
            return Err(Misuse::NotStaged);
        }
        self.pending = Some(ticket);
        Ok(())
    }

    /// 合成器已收下 `ticket` 及以前的请求：换上，返回 `(换下的槽, 换上的槽)`。
    pub fn complete(&mut self, ticket: u64) -> Option<(usize, usize)> {
        let pending = self.pending?;
        if pending > ticket {
            return None;
        }
        self.pending = None;
        self.staged = false;
        let old = self.visible;
        self.visible = 1 - old;
        self.shown = true;
        Some((old, self.visible))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn new_pin_has_no_window_until_shown() {
        let mut s = Slots::new();
        assert_eq!(s.window(), None);
        assert_eq!(s.translate(rect(0, 0, 10, 10)), Err(Misuse::NotShown));
        s.show(rect(5, 6, 10, 10));
        assert_eq!(s.visible(), 0);
        assert_eq!(s.window(), Some(rect(5, 6, 10, 10)));
    }

    #[test]
    fn translate_only_moves() {
        let mut s = Slots::new();
        s.show(rect(0, 0, 10, 10));
        assert_eq!(s.translate(rect(-40, 7, 10, 10)), Ok(()));
        assert_eq!(s.window(), Some(rect(-40, 7, 10, 10)));
        assert_eq!(s.translate(rect(0, 0, 11, 10)), Err(Misuse::Resized));
        assert_eq!(s.window(), Some(rect(-40, 7, 10, 10)));
    }

    #[test]
    fn swap_needs_a_staged_standby() {
        let mut s = Slots::new();
        s.show(rect(0, 0, 10, 10));
        assert_eq!(s.request_swap(1), Err(Misuse::NotStaged));
    }

    #[test]
    fn swap_takes_effect_when_its_ticket_is_composed() {
        let mut s = Slots::new();
        s.show(rect(0, 0, 10, 10));
        s.stage(rect(-5, -5, 20, 20));
        s.request_swap(3).unwrap();
        // 合成器收下的是更早的请求：还不换。
        assert_eq!(s.complete(2), None);
        assert_eq!(s.visible(), 0);
        assert_eq!(s.complete(3), Some((0, 1)));
        assert_eq!(s.visible(), 1);
        assert_eq!(s.window(), Some(rect(-5, -5, 20, 20)));
        assert_eq!(s.pending(), None);
        // 同一个序号再报一次不会再换。
        assert_eq!(s.complete(3), None);
    }

    #[test]
    fn staging_again_cancels_the_pending_swap() {
        let mut s = Slots::new();
        s.show(rect(0, 0, 10, 10));
        s.stage(rect(0, 0, 20, 20));
        s.request_swap(1).unwrap();
        s.stage(rect(0, 0, 30, 30));
        assert_eq!(s.complete(1), None);
        assert_eq!(s.visible(), 0);
        s.request_swap(2).unwrap();
        assert_eq!(s.complete(2), Some((0, 1)));
        assert_eq!(s.window(), Some(rect(0, 0, 30, 30)));
    }

    #[test]
    fn after_a_swap_the_old_slot_is_the_standby_and_must_be_staged_again() {
        let mut s = Slots::new();
        s.show(rect(0, 0, 10, 10));
        s.stage(rect(0, 0, 20, 20));
        s.request_swap(1).unwrap();
        s.complete(1);
        assert_eq!(s.standby(), 0);
        assert_eq!(s.request_swap(2), Err(Misuse::NotStaged));
        s.stage(rect(1, 1, 5, 5));
        assert_eq!(s.rect(0), Some(rect(1, 1, 5, 5)));
        s.request_swap(2).unwrap();
        assert_eq!(s.complete(2), Some((1, 0)));
    }

    #[test]
    fn translate_while_a_swap_is_pending_moves_the_old_visible_slot() {
        let mut s = Slots::new();
        s.show(rect(0, 0, 10, 10));
        s.stage(rect(0, 0, 20, 20));
        s.request_swap(1).unwrap();
        s.translate(rect(3, 3, 10, 10)).unwrap();
        assert_eq!(s.rect(0), Some(rect(3, 3, 10, 10)));
        assert_eq!(s.pending(), Some(1));
    }
}
