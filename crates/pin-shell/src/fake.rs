//! 记录调用顺序的假平台层，给编排层的测试用：断言“滚轮一格 → stage、swap，之后都只重画”这类序列。
//!
//! 违反接口约定（平移改尺寸、没 stage 就 swap、操作不存在的钉图）直接 panic，测试当场失败。
//! `swap` 默认在下一次 `pump` 时完成；[`FakeShell::hold_swaps`] 之后要 [`FakeShell::finish_swaps`]，
//! 用来测“换窗还没完成时又来了输入”。

use std::collections::{BTreeMap, VecDeque};

use wgpu::rwh::{RawDisplayHandle, RawWindowHandle, WebDisplayHandle, WebWindowHandle};

use crate::displays::Display;
use crate::keys::PinKeys;
use crate::slots::Slots;
use crate::types::{PinCursor, PinId, PinInput, ShellError};
use crate::{PinShell, ScreenRect};

/// 编排对平台层的一次调用。
#[derive(Debug, Clone, PartialEq)]
pub enum Call {
    Create(PinId),
    Retarget(PinId),
    Show(PinId, ScreenRect),
    Translate(PinId, ScreenRect),
    Stage(PinId, ScreenRect),
    Swap(PinId),
    Raise(PinId),
    ClickThrough(PinId, bool),
    Cursor(PinId, PinCursor),
    Keys(PinKeys),
    Close(PinId),
}

#[derive(Debug)]
struct FakePin {
    slots: Slots,
    click_through: bool,
    cursor: PinCursor,
}

#[derive(Debug, Default)]
pub struct FakeShell {
    calls: Vec<Call>,
    pins: BTreeMap<PinId, FakePin>,
    /// 从上到下。
    order: Vec<PinId>,
    queue: VecDeque<PinInput>,
    displays: Vec<Display>,
    keys: PinKeys,
    hold_swaps: bool,
    tickets: u64,
}

impl FakeShell {
    pub fn new(displays: Vec<Display>) -> FakeShell {
        FakeShell {
            displays,
            ..FakeShell::default()
        }
    }

    /// 到现在为止的全部调用。
    pub fn calls(&self) -> &[Call] {
        &self.calls
    }

    /// 取出并清空调用记录。
    pub fn take_calls(&mut self) -> Vec<Call> {
        std::mem::take(&mut self.calls)
    }

    /// 排一条输入，下一次 `pump` 报出。
    pub fn push(&mut self, input: PinInput) {
        self.queue.push_back(input);
    }

    /// 换显示器，下一次 `pump` 报 [`PinInput::DisplaysChanged`]。
    pub fn set_displays(&mut self, displays: Vec<Display>) {
        self.displays = displays;
        self.queue.push_back(PinInput::DisplaysChanged);
    }

    /// 为真时 `swap` 不自动完成，要等 [`FakeShell::finish_swaps`]。
    pub fn hold_swaps(&mut self, hold: bool) {
        self.hold_swaps = hold;
    }

    /// 完成所有等着的 `swap`，下一次 `pump` 报 `Swapped`。
    pub fn finish_swaps(&mut self) {
        let ticket = self.tickets;
        for (&pin, p) in &mut self.pins {
            if p.slots.complete(ticket).is_some() {
                self.queue.push_back(PinInput::Swapped {
                    pin,
                    waited_ms: 0.0,
                });
            }
        }
    }

    /// 看得见的窗口（还没显示为 None）。
    pub fn window(&self, pin: PinId) -> Option<ScreenRect> {
        self.pin(pin).slots.window()
    }

    /// 某个槽摆在哪。
    pub fn slot_rect(&self, pin: PinId, slot: usize) -> Option<ScreenRect> {
        self.pin(pin).slots.rect(slot)
    }

    pub fn swap_pending(&self, pin: PinId) -> bool {
        self.pin(pin).slots.pending().is_some()
    }

    pub fn click_through(&self, pin: PinId) -> bool {
        self.pin(pin).click_through
    }

    pub fn cursor(&self, pin: PinId) -> PinCursor {
        self.pin(pin).cursor
    }

    pub fn keys(&self) -> &PinKeys {
        &self.keys
    }

    /// 钉图从上到下的次序。
    pub fn order(&self) -> &[PinId] {
        &self.order
    }

    fn pin(&self, pin: PinId) -> &FakePin {
        self.pins
            .get(&pin)
            .unwrap_or_else(|| panic!("钉图 {pin:?} 不存在或已关"))
    }

    fn pin_mut(&mut self, pin: PinId) -> &mut FakePin {
        self.pins
            .get_mut(&pin)
            .unwrap_or_else(|| panic!("钉图 {pin:?} 不存在或已关"))
    }

    fn put_on_top(&mut self, pin: PinId) {
        self.order.retain(|&p| p != pin);
        self.order.insert(0, pin);
    }

    /// 假的 Surface 目标：不能真的建 Surface，只用来认出是哪张钉图的哪个槽。
    fn targets(pin: PinId) -> [wgpu::SurfaceTargetUnsafe; 2] {
        [0u32, 1].map(|slot| wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle: Some(RawDisplayHandle::Web(WebDisplayHandle::new())),
            raw_window_handle: RawWindowHandle::Web(WebWindowHandle::new(
                (pin.0 as u32).wrapping_mul(2) + slot + 1,
            )),
        })
    }
}

impl PinShell for FakeShell {
    fn create(&mut self, pin: PinId) -> Result<[wgpu::SurfaceTargetUnsafe; 2], ShellError> {
        self.calls.push(Call::Create(pin));
        assert!(!self.pins.contains_key(&pin), "钉图 {pin:?} 已经建过");
        self.pins.insert(
            pin,
            FakePin {
                slots: Slots::new(),
                click_through: false,
                cursor: PinCursor::default(),
            },
        );
        Ok(FakeShell::targets(pin))
    }

    fn retarget(&mut self, pin: PinId) -> Result<[wgpu::SurfaceTargetUnsafe; 2], ShellError> {
        self.calls.push(Call::Retarget(pin));
        self.pin(pin);
        Ok(FakeShell::targets(pin))
    }

    fn show(&mut self, pin: PinId, rect: ScreenRect) {
        self.calls.push(Call::Show(pin, rect));
        self.pin_mut(pin).slots.show(rect);
        self.put_on_top(pin);
    }

    fn translate(&mut self, pin: PinId, rect: ScreenRect) {
        self.calls.push(Call::Translate(pin, rect));
        if let Err(e) = self.pin_mut(pin).slots.translate(rect) {
            panic!("translate({pin:?}, {rect:?})：{e:?}");
        }
    }

    fn stage(&mut self, pin: PinId, rect: ScreenRect) {
        self.calls.push(Call::Stage(pin, rect));
        self.pin_mut(pin).slots.stage(rect);
    }

    fn swap(&mut self, pin: PinId) {
        self.calls.push(Call::Swap(pin));
        self.tickets += 1;
        let ticket = self.tickets;
        if let Err(e) = self.pin_mut(pin).slots.request_swap(ticket) {
            panic!("swap({pin:?})：{e:?}");
        }
    }

    fn visible_slot(&self, pin: PinId) -> usize {
        self.pin(pin).slots.visible()
    }

    fn raise(&mut self, pin: PinId) {
        self.calls.push(Call::Raise(pin));
        self.pin(pin);
        self.put_on_top(pin);
    }

    fn set_click_through(&mut self, pin: PinId, on: bool) {
        self.calls.push(Call::ClickThrough(pin, on));
        self.pin_mut(pin).click_through = on;
    }

    fn set_cursor(&mut self, pin: PinId, cursor: PinCursor) {
        self.calls.push(Call::Cursor(pin, cursor));
        self.pin_mut(pin).cursor = cursor;
    }

    fn set_keys(&mut self, keys: PinKeys) {
        self.calls.push(Call::Keys(keys.clone()));
        self.keys = keys;
    }

    fn displays(&self) -> Vec<Display> {
        self.displays.clone()
    }

    fn pump(&mut self) -> Vec<PinInput> {
        if !self.hold_swaps {
            self.finish_swaps();
        }
        self.queue.drain(..).collect()
    }

    fn close(&mut self, pin: PinId) {
        self.calls.push(Call::Close(pin));
        self.pins
            .remove(&pin)
            .unwrap_or_else(|| panic!("钉图 {pin:?} 不存在或已关"));
        self.order.retain(|&p| p != pin);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::Key;
    use crate::types::{Pointer, PointerEvent};
    use crate::{PointerButton, PointerKind};

    const A: PinId = PinId(1);
    const B: PinId = PinId(2);

    fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    fn window_id(t: &wgpu::SurfaceTargetUnsafe) -> u32 {
        match t {
            wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_window_handle: RawWindowHandle::Web(h),
                ..
            } => h.id,
            _ => panic!("不是假目标"),
        }
    }

    #[test]
    fn records_the_call_sequence() {
        let mut s = FakeShell::default();
        s.create(A).unwrap();
        s.show(A, rect(0, 0, 10, 10));
        s.translate(A, rect(5, 0, 10, 10));
        s.stage(A, rect(0, 0, 20, 20));
        s.swap(A);
        s.set_keys(PinKeys::new([Key::Escape]));
        s.close(A);
        assert_eq!(
            s.calls(),
            &[
                Call::Create(A),
                Call::Show(A, rect(0, 0, 10, 10)),
                Call::Translate(A, rect(5, 0, 10, 10)),
                Call::Stage(A, rect(0, 0, 20, 20)),
                Call::Swap(A),
                Call::Keys(PinKeys::new([Key::Escape])),
                Call::Close(A),
            ]
        );
        assert_eq!(s.take_calls().len(), 7);
        assert!(s.calls().is_empty());
    }

    #[test]
    fn each_slot_gets_its_own_target() {
        let mut s = FakeShell::default();
        let a = s.create(A).unwrap();
        let b = s.create(B).unwrap();
        let ids: Vec<u32> = a.iter().chain(&b).map(window_id).collect();
        assert_eq!(ids, [3, 4, 5, 6]);
        let again = s.retarget(A).unwrap();
        assert_eq!(again.each_ref().map(window_id), [3, 4]);
    }

    #[test]
    fn swap_completes_on_the_next_pump() {
        let mut s = FakeShell::default();
        s.create(A).unwrap();
        s.show(A, rect(0, 0, 10, 10));
        s.stage(A, rect(-5, -5, 20, 20));
        s.swap(A);
        assert_eq!(s.visible_slot(A), 0);
        assert_eq!(
            s.pump(),
            [PinInput::Swapped {
                pin: A,
                waited_ms: 0.0
            }]
        );
        assert_eq!(s.visible_slot(A), 1);
        assert_eq!(s.window(A), Some(rect(-5, -5, 20, 20)));
        assert_eq!(s.pump(), []);
    }

    #[test]
    fn held_swaps_wait_for_finish() {
        let mut s = FakeShell::default();
        s.hold_swaps(true);
        s.create(A).unwrap();
        s.show(A, rect(0, 0, 10, 10));
        s.stage(A, rect(0, 0, 20, 20));
        s.swap(A);
        let wheel = PinInput::Wheel {
            pin: A,
            at: (3, 3),
            notches: 1.0,
            ctrl: false,
        };
        s.push(wheel.clone());
        assert_eq!(s.pump(), [wheel]);
        assert!(s.swap_pending(A));
        s.finish_swaps();
        assert_eq!(
            s.pump(),
            [PinInput::Swapped {
                pin: A,
                waited_ms: 0.0
            }]
        );
    }

    #[test]
    fn inputs_come_out_in_order() {
        let mut s = FakeShell::default();
        s.create(A).unwrap();
        let down = PinInput::Pointer(Pointer {
            pin: A,
            kind: PointerKind::Pen,
            at: (1, 2),
            event: PointerEvent::Down(PointerButton::Secondary),
        });
        s.push(down.clone());
        s.set_displays(vec![]);
        assert_eq!(s.pump(), [down, PinInput::DisplaysChanged]);
    }

    #[test]
    fn raise_and_show_put_the_pin_on_top() {
        let mut s = FakeShell::default();
        s.create(A).unwrap();
        s.create(B).unwrap();
        s.show(A, rect(0, 0, 1, 1));
        s.show(B, rect(0, 0, 1, 1));
        assert_eq!(s.order(), [B, A]);
        s.raise(A);
        assert_eq!(s.order(), [A, B]);
        s.close(A);
        assert_eq!(s.order(), [B]);
    }

    #[test]
    fn remembers_click_through_cursor_and_keys() {
        let mut s = FakeShell::default();
        s.create(A).unwrap();
        s.set_click_through(A, true);
        s.set_cursor(A, PinCursor::ResizeNwse);
        s.set_keys(PinKeys::none());
        assert!(s.click_through(A));
        assert_eq!(s.cursor(A), PinCursor::ResizeNwse);
        assert!(s.keys().is_empty());
    }

    #[test]
    #[should_panic(expected = "Resized")]
    fn translate_that_resizes_fails_the_test() {
        let mut s = FakeShell::default();
        s.create(A).unwrap();
        s.show(A, rect(0, 0, 10, 10));
        s.translate(A, rect(0, 0, 12, 10));
    }

    #[test]
    #[should_panic(expected = "NotStaged")]
    fn swap_without_stage_fails_the_test() {
        let mut s = FakeShell::default();
        s.create(A).unwrap();
        s.show(A, rect(0, 0, 10, 10));
        s.swap(A);
    }

    #[test]
    #[should_panic(expected = "不存在")]
    fn using_a_closed_pin_fails_the_test() {
        let mut s = FakeShell::default();
        s.create(A).unwrap();
        s.close(A);
        s.raise(A);
    }
}
