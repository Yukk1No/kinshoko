//! 窗口消息参数的换算（纯函数）：坐标、滚轮、虚拟键码，以及钩子线程投给界面线程的按键打包。
//! 进程是 Per-Monitor V2，消息里的坐标已是物理像素，这里不做 DPI 换算。

use crate::keys::{Captured, Key};
use crate::types::PinId;

/// `lParam` 里的点（低 16 位 x、高 16 位 y，各自有符号：左边、上边的显示器坐标为负）。
pub(super) fn lparam_point(lp: isize) -> (i32, i32) {
    let x = (lp & 0xffff) as u16 as i16;
    let y = ((lp >> 16) & 0xffff) as u16 as i16;
    (i32::from(x), i32::from(y))
}

/// 客户区坐标换成屏幕坐标：钉图窗口没有边框，客户区原点就是窗口左上角。
pub(super) fn client_to_screen(origin: (i32, i32), client: (i32, i32)) -> (i32, i32) {
    (origin.0 + client.0, origin.1 + client.1)
}

/// `WM_MOUSEWHEEL` 的 `wParam`：高 16 位是有符号的滚动量（一格 120，向上为正）。
pub(super) fn wheel_notches(wp: usize) -> f64 {
    f64::from(((wp >> 16) & 0xffff) as u16 as i16) / 120.0
}

/// `WM_MOUSEWHEEL` 的 `wParam` 低 16 位里有没有按着 Ctrl（`MK_CONTROL`）。
pub(super) fn wheel_ctrl(wp: usize) -> bool {
    wp & 0x0008 != 0
}

/// 鼠标消息 `wParam` 里还按着左键或右键（`MK_LBUTTON`、`MK_RBUTTON`）。
pub(super) fn buttons_held(wp: usize) -> bool {
    wp & 0x0003 != 0
}

const VK_ESCAPE: u32 = 0x1b;
const VK_DELETE: u32 = 0x2e;
const VK_OEM_4: u32 = 0xdb;
const VK_OEM_6: u32 = 0xdd;

/// 虚拟键码 → 钉图认的键。
pub(super) fn key_from_vk(vk: u32) -> Option<Key> {
    match vk {
        0x41..=0x5a => char::from_u32(vk).map(Key::Letter),
        0x30..=0x39 => Some(Key::Digit((vk - 0x30) as u8)),
        VK_ESCAPE => Some(Key::Escape),
        VK_DELETE => Some(Key::Delete),
        VK_OEM_4 => Some(Key::BracketLeft),
        VK_OEM_6 => Some(Key::BracketRight),
        _ => None,
    }
}

fn vk_from_key(key: Key) -> u32 {
    match key {
        Key::Letter(c) => u32::from(c.to_ascii_uppercase()),
        Key::Digit(d) => 0x30 + u32::from(d),
        Key::Escape => VK_ESCAPE,
        Key::Delete => VK_DELETE,
        Key::BracketLeft => VK_OEM_4,
        Key::BracketRight => VK_OEM_6,
    }
}

/// 拦下的按键装进一条投递消息的 `(wParam, lParam)`：键码、Shift、重复在 `wParam`，钉图编号在 `lParam`。
pub(super) fn pack_key(c: Captured) -> (usize, isize) {
    let wp = vk_from_key(c.key) as usize | usize::from(c.shift) << 16 | usize::from(c.repeat) << 17;
    (wp, c.pin.0 as isize)
}

pub(super) fn unpack_key(wp: usize, lp: isize) -> Option<Captured> {
    Some(Captured {
        pin: PinId(lp as u64),
        key: key_from_vk((wp & 0xffff) as u32)?,
        shift: wp & (1 << 16) != 0,
        repeat: wp & (1 << 17) != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lparam(x: i16, y: i16) -> isize {
        (x as u16 as isize) | ((y as u16 as isize) << 16)
    }

    #[test]
    fn points_left_of_and_above_the_primary_display_are_negative() {
        assert_eq!(lparam_point(lparam(100, 200)), (100, 200));
        assert_eq!(lparam_point(lparam(-2560, -10)), (-2560, -10));
        assert_eq!(lparam_point(lparam(i16::MAX, i16::MIN)), (32767, -32768));
    }

    #[test]
    fn client_points_are_offset_by_the_window_origin() {
        assert_eq!(client_to_screen((-1920, 300), (10, 20)), (-1910, 320));
    }

    #[test]
    fn wheel_delta_and_ctrl() {
        let wp = |delta: i16, keys: u16| ((delta as u16 as usize) << 16) | keys as usize;
        assert_eq!(wheel_notches(wp(120, 0)), 1.0);
        assert_eq!(wheel_notches(wp(-240, 0)), -2.0);
        assert_eq!(wheel_notches(wp(30, 0)), 0.25);
        assert!(wheel_ctrl(wp(120, 0x0008)));
        assert!(!wheel_ctrl(wp(120, 0x0004)));
    }

    #[test]
    fn buttons_still_held_after_one_is_released() {
        assert!(buttons_held(0x0002));
        assert!(!buttons_held(0x0004 | 0x0008));
    }

    #[test]
    fn virtual_keys_map_to_pin_keys() {
        assert_eq!(key_from_vk(0x48), Some(Key::Letter('H')));
        assert_eq!(key_from_vk(0x31), Some(Key::Digit(1)));
        assert_eq!(key_from_vk(0x1b), Some(Key::Escape));
        assert_eq!(key_from_vk(0xdb), Some(Key::BracketLeft));
        assert_eq!(key_from_vk(0x10), None); // Shift 本身
        assert_eq!(key_from_vk(0x70), None); // F1：截图快捷键归应用
        for key in [
            Key::Letter('Z'),
            Key::Digit(0),
            Key::Delete,
            Key::BracketRight,
        ] {
            assert_eq!(key_from_vk(vk_from_key(key)), Some(key));
        }
    }

    #[test]
    fn captured_keys_survive_the_trip_to_the_ui_thread() {
        let c = Captured {
            pin: PinId(u64::MAX - 3),
            key: Key::Letter('R'),
            shift: true,
            repeat: false,
        };
        let (wp, lp) = pack_key(c);
        assert_eq!(unpack_key(wp, lp), Some(c));
        let c = Captured {
            repeat: true,
            shift: false,
            ..c
        };
        let (wp, lp) = pack_key(c);
        assert_eq!(unpack_key(wp, lp), Some(c));
    }
}
