//! 钉图的快捷键：钉图窗口不激活、拿不到键盘焦点，所以由低级键盘钩子按光标位置判断（ADR 0013）。
//! 这里是钩子回调里的全部判断，与平台无关：光标在不在某张钉图（含阴影）上、键在不在拦截表里。
//! 回调只查表，不能卡住，否则系统会跳过、移除钩子。

use std::collections::{BTreeMap, BTreeSet};

use kinshoko_core::desktop::ScreenRect;

use crate::types::PinId;

/// 钉图认的键（按美式键位的位置，不随输入法变）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Key {
    /// `A`～`Z`，大写。
    Letter(char),
    /// `0`～`9`（主键盘区）。
    Digit(u8),
    Escape,
    Delete,
    BracketLeft,
    BracketRight,
}

/// 光标在钉图上时拦下的键。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PinKeys(BTreeSet<Key>);

impl PinKeys {
    /// 什么都不拦（菜单打开时）。
    pub fn none() -> PinKeys {
        PinKeys::default()
    }

    pub fn new(keys: impl IntoIterator<Item = Key>) -> PinKeys {
        PinKeys(keys.into_iter().collect())
    }

    pub fn contains(&self, key: Key) -> bool {
        self.0.contains(&key)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// 钩子回调查的表：看得见、不穿透的钉图窗口（从上到下）与要拦的键。
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct HitTable {
    pub pins: Vec<(PinId, ScreenRect)>,
    pub keys: PinKeys,
}

impl HitTable {
    /// 光标下最上面的钉图。
    pub fn pin_at(&self, at: (i32, i32)) -> Option<PinId> {
        self.pins
            .iter()
            .find(|(_, r)| contains(r, at))
            .map(|(pin, _)| *pin)
    }
}

fn contains(r: &ScreenRect, (x, y): (i32, i32)) -> bool {
    let (x, y) = (i64::from(x), i64::from(y));
    x >= i64::from(r.x)
        && y >= i64::from(r.y)
        && x < i64::from(r.x) + i64::from(r.width)
        && y < i64::from(r.y) + i64::from(r.height)
}

/// 按键时按着的修饰键。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Mods {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub win: bool,
}

/// 拦下的一次按键，交给编排。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Captured {
    pub pin: PinId,
    pub key: Key,
    pub shift: bool,
    pub repeat: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// 交给前台程序。
    Pass,
    /// 拦下；有按键事件时交给编排。
    Swallow(Option<Captured>),
}

/// 记住按着的键各自归谁：拦下的，自动重复和松开也拦下（不拦就会有一个没头的松开进前台程序）；
/// 放行的，光标后来移到钉图上，自动重复和松开也照样放行。
#[derive(Debug, Default)]
pub(crate) struct KeyGate {
    /// 按着的键 → 按下时是否拦下。
    held: BTreeMap<Key, bool>,
}

impl KeyGate {
    /// `key` 为 None 表示不是钉图认的键。带 Ctrl、Alt、Win 的组合键是给前台程序的，不拦。
    pub fn down(
        &mut self,
        table: &HitTable,
        key: Option<Key>,
        at: (i32, i32),
        mods: Mods,
    ) -> Verdict {
        let Some(key) = key else {
            return Verdict::Pass;
        };
        let pin = table.pin_at(at);
        match self.held.get(&key) {
            // 自动重复：跟着按下时的决定走；光标还在钉图上才交给编排。
            // 拦截表已关掉这个键（菜单打开了）：吞到松开为止，但不再交给钉图。
            Some(true) => {
                let pin = pin.filter(|_| table.keys.contains(key));
                return Verdict::Swallow(pin.map(|pin| Captured {
                    pin,
                    key,
                    shift: mods.shift,
                    repeat: true,
                }));
            }
            Some(false) => return Verdict::Pass,
            None => {}
        }
        let pin = pin.filter(|_| !(mods.ctrl || mods.alt || mods.win) && table.keys.contains(key));
        self.held.insert(key, pin.is_some());
        let Some(pin) = pin else {
            return Verdict::Pass;
        };
        Verdict::Swallow(Some(Captured {
            pin,
            key,
            shift: mods.shift,
            repeat: false,
        }))
    }

    /// 没有按着的键（这时重装钩子不会丢掉一次松开）。
    pub fn idle(&self) -> bool {
        self.held.is_empty()
    }

    /// 忘掉物理上已经松开的键：钩子被系统移除期间松开的键，钩子收不到它的松开。
    pub fn forget_released(&mut self, still_down: impl Fn(Key) -> bool) {
        self.held.retain(|&key, _| still_down(key));
    }

    pub fn up(&mut self, key: Option<Key>) -> Verdict {
        match key {
            Some(key) if self.held.remove(&key) == Some(true) => Verdict::Swallow(None),
            _ => Verdict::Pass,
        }
    }
}

/// 回调送达比按键晚这么多毫秒，就当系统可能已因超时移除钩子，重新安装。系统的超时
/// （`LowLevelHooksTimeout`）至少几百毫秒，这里取小一些。
pub(crate) const LATE_MS: u32 = 200;

/// 按键时刻 `event_ms` 与回调时刻 `now_ms`（都是系统毫秒计数，会回绕）相差太多时返回差值。
pub(crate) fn late_ms(event_ms: u32, now_ms: u32) -> Option<u32> {
    let d = now_ms.wrapping_sub(event_ms);
    // 差值“为负”（回绕后极大）说明时间戳比现在还新，不算晚。
    (LATE_MS..u32::MAX / 2).contains(&d).then_some(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: Key = Key::Letter('H');
    const R: Key = Key::Letter('R');

    fn table() -> HitTable {
        HitTable {
            // 1 号在 2 号上面，两者重叠在 50..100。
            pins: vec![
                (
                    PinId(1),
                    ScreenRect {
                        x: 50,
                        y: 0,
                        width: 100,
                        height: 100,
                    },
                ),
                (
                    PinId(2),
                    ScreenRect {
                        x: 0,
                        y: 0,
                        width: 100,
                        height: 100,
                    },
                ),
            ],
            keys: PinKeys::new([H, R, Key::Escape]),
        }
    }

    fn shift() -> Mods {
        Mods {
            shift: true,
            ..Mods::default()
        }
    }

    #[test]
    fn key_over_a_pin_goes_to_the_topmost_pin() {
        let mut g = KeyGate::default();
        let v = g.down(&table(), Some(H), (60, 10), Mods::default());
        assert_eq!(
            v,
            Verdict::Swallow(Some(Captured {
                pin: PinId(1),
                key: H,
                shift: false,
                repeat: false
            }))
        );
        assert_eq!(
            g.down(&table(), Some(R), (10, 10), shift()),
            Verdict::Swallow(Some(Captured {
                pin: PinId(2),
                key: R,
                shift: true,
                repeat: false
            }))
        );
    }

    #[test]
    fn rect_edges_are_half_open() {
        let t = table();
        assert_eq!(t.pin_at((149, 99)), Some(PinId(1)));
        assert_eq!(t.pin_at((150, 50)), None);
        assert_eq!(t.pin_at((0, 100)), None);
        assert_eq!(t.pin_at((-1, 0)), None);
    }

    #[test]
    fn keys_pass_when_the_cursor_is_not_on_a_pin() {
        let mut g = KeyGate::default();
        assert_eq!(
            g.down(&table(), Some(H), (500, 10), Mods::default()),
            Verdict::Pass
        );
        assert_eq!(g.up(Some(H)), Verdict::Pass);
    }

    #[test]
    fn keys_not_in_the_table_pass() {
        let mut g = KeyGate::default();
        assert_eq!(
            g.down(&table(), Some(Key::Letter('V')), (10, 10), Mods::default()),
            Verdict::Pass
        );
        assert_eq!(
            g.down(&table(), None, (10, 10), Mods::default()),
            Verdict::Pass
        );
    }

    #[test]
    fn empty_table_while_the_menu_is_open_passes_everything() {
        let mut g = KeyGate::default();
        let t = HitTable {
            keys: PinKeys::none(),
            ..table()
        };
        assert_eq!(
            g.down(&t, Some(Key::Escape), (10, 10), Mods::default()),
            Verdict::Pass
        );
    }

    #[test]
    fn shortcuts_of_the_foreground_program_pass() {
        let mut g = KeyGate::default();
        for mods in [
            Mods {
                ctrl: true,
                ..Mods::default()
            },
            Mods {
                alt: true,
                ..Mods::default()
            },
            Mods {
                win: true,
                ..Mods::default()
            },
        ] {
            assert_eq!(g.down(&table(), Some(H), (10, 10), mods), Verdict::Pass);
        }
    }

    #[test]
    fn release_of_a_swallowed_key_is_swallowed_even_off_the_pin() {
        let mut g = KeyGate::default();
        g.down(&table(), Some(H), (10, 10), Mods::default());
        assert!(!g.idle());
        assert_eq!(g.up(Some(H)), Verdict::Swallow(None));
        assert!(g.idle());
        // 只拦一次：下一次松开（没拦下的按下）照常放行。
        assert_eq!(g.up(Some(H)), Verdict::Pass);
    }

    #[test]
    fn auto_repeat_of_a_swallowed_key_stays_swallowed() {
        let mut g = KeyGate::default();
        g.down(&table(), Some(R), (10, 10), Mods::default());
        assert_eq!(
            g.down(&table(), Some(R), (10, 10), Mods::default()),
            Verdict::Swallow(Some(Captured {
                pin: PinId(2),
                key: R,
                shift: false,
                repeat: true
            }))
        );
        // 光标移开后的重复仍拦下，但不再交给钉图。
        assert_eq!(
            g.down(&table(), Some(R), (900, 10), Mods::default()),
            Verdict::Swallow(None)
        );
    }

    #[test]
    fn repeats_are_swallowed_but_not_dispatched_once_the_key_is_disabled() {
        let mut g = KeyGate::default();
        g.down(&table(), Some(R), (10, 10), Mods::default());
        let menu = HitTable {
            keys: PinKeys::none(),
            ..table()
        };
        assert_eq!(
            g.down(&menu, Some(R), (10, 10), Mods::default()),
            Verdict::Swallow(None)
        );
        assert_eq!(g.up(Some(R)), Verdict::Swallow(None));
    }

    #[test]
    fn keys_released_while_the_hook_was_gone_are_forgotten() {
        let mut g = KeyGate::default();
        g.down(&table(), Some(H), (10, 10), Mods::default());
        g.down(&table(), Some(R), (10, 10), Mods::default());
        g.forget_released(|k| k == R);
        assert!(!g.idle());
        g.forget_released(|_| false);
        assert!(g.idle());
        // 忘掉之后再按，重新判断。
        assert!(matches!(
            g.down(&table(), Some(H), (10, 10), Mods::default()),
            Verdict::Swallow(Some(Captured { repeat: false, .. }))
        ));
    }

    #[test]
    fn a_key_pressed_off_the_pin_is_not_taken_when_the_cursor_arrives() {
        let mut g = KeyGate::default();
        assert_eq!(
            g.down(&table(), Some(H), (900, 10), Mods::default()),
            Verdict::Pass
        );
        // 按住不放、光标移到钉图上：自动重复和松开都还是前台程序的。
        assert_eq!(
            g.down(&table(), Some(H), (10, 10), Mods::default()),
            Verdict::Pass
        );
        assert_eq!(g.up(Some(H)), Verdict::Pass);
        // 下一次按下重新判断。
        assert!(matches!(
            g.down(&table(), Some(H), (10, 10), Mods::default()),
            Verdict::Swallow(Some(_))
        ));
    }

    #[test]
    fn late_delivery_is_detected_across_wraparound() {
        assert_eq!(late_ms(1000, 1100), None);
        assert_eq!(late_ms(1000, 1000 + LATE_MS), Some(LATE_MS));
        assert_eq!(late_ms(u32::MAX - 100, 400), Some(501));
        // 时间戳比现在新（注入的输入、时钟抖动）：不算晚。
        assert_eq!(late_ms(1005, 1000), None);
    }
}
