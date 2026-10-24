//! 钉图上的动作：缩放、旋转翻转、按键、菜单、动画，以及把排队的输入合成一帧。

#![allow(unused_imports)]

use std::fmt::Write as _;
use std::sync::{Arc, Mutex};

use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Dwm::DwmFlush;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{PCWSTR, w};

use crate::measure::{self, ms, qpc};
use crate::raster::{Crop, PIN_EDGE, Quality, Rasterizer, Rect, View};
use crate::*;

impl App {
    pub(crate) fn zoom(&mut self, i: usize, delta: i16, x: i32, y: i32) {
        let pin = &mut self.pins[i];
        let factor = 1.1f64.powf(delta as f64 / 120.0);
        let s0 = pin.view.scale;
        let s1 = (s0 * factor).clamp(0.01, 16.0);
        let k = s1 / s0;
        pin.origin.0 = x as f64 - (x as f64 - pin.origin.0) * k;
        pin.origin.1 = y as f64 - (y as f64 - pin.origin.1) * k;
        pin.view.scale = s1;
    }

    /// 绕显示中心改几何（旋转、翻转、裁切），中心不动。
    pub(crate) fn around_centre(&mut self, i: usize, f: impl FnOnce(&mut View)) {
        let pin = &mut self.pins[i];
        let (w0, h0) = pin.view.display_size(&pin.src);
        let c = (
            pin.origin.0 + w0 as f64 / 2.0,
            pin.origin.1 + h0 as f64 / 2.0,
        );
        f(&mut pin.view);
        let (w1, h1) = pin.view.display_size(&pin.src);
        pin.origin = (c.0 - w1 as f64 / 2.0, c.1 - h1 as f64 / 2.0);
    }

    pub(crate) fn arm_settle(&self, i: usize) {
        unsafe {
            SetTimer(Some(self.pins[i].hwnd), 1, SETTLE_MS, None);
        }
    }

    pub(crate) fn key(&mut self, i: usize, vk: u32, t: i64) {
        match vk {
            0x48 /* H */ => {
                self.around_centre(i, |v| if v.rotation % 2 == 1 { v.flip_v = !v.flip_v } else { v.flip_h = !v.flip_h });
                self.present(i, Quality::Settled, "flip", Some(t));
            }
            0x56 /* V */ => {
                self.around_centre(i, |v| if v.rotation % 2 == 1 { v.flip_h = !v.flip_h } else { v.flip_v = !v.flip_v });
                self.present(i, Quality::Settled, "flip", Some(t));
            }
            0x52 /* R */ => {
                self.around_centre(i, |v| v.rotation = (v.rotation + 1) % 4);
                self.present(i, Quality::Settled, "rotate", Some(t));
            }
            0x43 /* C */ => {
                let (w, h) = (self.pins[i].src.width() as f64, self.pins[i].src.height() as f64);
                self.around_centre(i, |v| {
                    v.crop = match v.crop {
                        None => Some(Crop { x: w / 4.0, y: h / 4.0, w: w / 2.0, h: h / 2.0 }),
                        Some(_) => None,
                    }
                });
                self.present(i, Quality::Gesture, "crop", Some(t));
                self.arm_settle(i);
            }
            0x54 /* T */ => {
                let pin = &mut self.pins[i];
                pin.click_through = !pin.click_through;
                unsafe {
                    let ex = GetWindowLongPtrW(pin.hwnd, GWL_EXSTYLE);
                    let t = WS_EX_TRANSPARENT.0 as isize;
                    SetWindowLongPtrW(pin.hwnd, GWL_EXSTYLE, if pin.click_through { ex | t } else { ex & !t });
                }
                eprintln!("钉图 {i} 点击穿透：{}", pin.click_through);
            }
            0xDB /* [ */ | 0xDD /* ] */ => {
                let pin = &mut self.pins[i];
                let step: i32 = if vk == 0xDB { -26 } else { 26 };
                pin.opacity = (pin.opacity as i32 + step).clamp(26, 255) as u8;
                self.set_opacity(i);
            }
            0x4E /* N */ => {
                self.pins[i].nearest = !self.pins[i].nearest;
                self.present(i, Quality::Settled, "nearest", Some(t));
            }
            0x31 /* 1 */ => {
                self.around_centre(i, |v| v.scale = 1.0);
                self.present(i, Quality::Gesture, "reset", Some(t));
                self.arm_settle(i);
            }
            0x41 /* A */ => self.animate(i, 250.0),
            0x1B /* Esc */ => self.close(i),
            _ => {}
        }
    }

    pub(crate) fn close(&mut self, i: usize) {
        let pin = &mut self.pins[i];
        if pin.closed {
            return;
        }
        pin.closed = true;
        pin.dib = None;
        unsafe {
            let _ = DestroyWindow(pin.hwnd);
        }
        RECTS.with(|r| r.borrow_mut().retain(|(k, _, _)| *k != i));
        if self.pins.iter().all(|p| p.closed) {
            unsafe { PostQuitMessage(0) };
        }
    }

    /// 动画：`duration_ms` 内放大到 2 倍再回来（以中心为锚），每帧等 DWM 合成一次。
    pub(crate) fn animate(&mut self, i: usize, duration_ms: f64) {
        let s0 = self.pins[i].view.scale;
        let start = qpc();
        loop {
            let t = ms(qpc() - start) / duration_ms;
            if t >= 1.0 {
                break;
            }
            let k = 1.0 + (std::f64::consts::PI * t).sin(); // 1 → 2 → 1
            self.around_centre(i, |v| v.scale = s0 * k);
            self.present(i, Quality::Gesture, "anim", None);
            unsafe {
                let _ = DwmFlush();
            }
        }
        self.around_centre(i, |v| v.scale = s0);
        self.present(i, Quality::Settled, "anim-end", None);
    }

    pub(crate) fn menu(&mut self, i: usize, x: i32, y: i32) {
        unsafe {
            let m = CreatePopupMenu().unwrap();
            let _ = AppendMenuW(m, MF_STRING, 1, w!("顺时针转 90°（R）"));
            let _ = AppendMenuW(m, MF_STRING, 2, w!("水平翻转（H）"));
            let _ = AppendMenuW(m, MF_STRING, 3, w!("点击穿透（T）"));
            let _ = AppendMenuW(m, MF_SEPARATOR, 0, PCWSTR::null());
            let _ = AppendMenuW(m, MF_STRING, 4, w!("关闭（Esc）"));
            let hwnd = self.pins[i].hwnd;
            if self.menu_foreground {
                let _ = SetForegroundWindow(hwnd);
            }
            let fg_before = GetForegroundWindow();
            MENU_OPEN.with(|m| m.set(true));
            let cmd = TrackPopupMenu(
                m,
                TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY,
                x,
                y,
                None,
                hwnd,
                None,
            );
            MENU_OPEN.with(|m| m.set(false));
            let fg_after = GetForegroundWindow();
            let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
            let _ = DestroyMenu(m);
            eprintln!(
                "菜单返回 {}；前台窗口 菜单前 {:?} 菜单后 {:?}",
                cmd.0, fg_before.0, fg_after.0
            );
            let t = qpc();
            match cmd.0 {
                1 => self.key(i, 0x52, t),
                2 => self.key(i, 0x48, t),
                3 => self.key(i, 0x54, t),
                4 => self.close(i),
                _ => {}
            }
        }
    }

    pub(crate) fn handle(&mut self, ev: Ev, pending: &mut Vec<(usize, i64)>) {
        match ev {
            Ev::Wheel {
                pin,
                delta,
                x,
                y,
                t,
            } if !self.pins[pin].closed => {
                self.zoom(pin, delta, x, y);
                // 同一批里的滚轮只上屏一次，延迟按最早那格算。
                if !pending.iter().any(|(p, _)| *p == pin) {
                    pending.push((pin, t));
                }
            }
            Ev::Down { pin, x, y } if !self.pins[pin].closed => {
                let o = self.pins[pin].origin;
                self.drag = Some((pin, x as f64 - o.0, y as f64 - o.1));
            }
            Ev::Drag { x, y, t } => {
                if let Some((pin, dx, dy)) = self.drag {
                    self.pins[pin].origin = (x as f64 - dx, y as f64 - dy);
                    self.move_only(pin, t);
                }
            }
            Ev::Up => self.drag = None,
            Ev::Menu { pin, x, y } if !self.pins[pin].closed => self.menu(pin, x, y),
            Ev::Key { pin, vk, t } if !self.pins[pin].closed => self.key(pin, vk, t),
            Ev::Settle { pin } if !self.pins[pin].closed => {
                let p = &self.pins[pin];
                let want = if p.nearest {
                    Quality::Nearest
                } else {
                    Quality::Settled
                };
                if p.rendered_quality != Some(want) {
                    self.present(pin, Quality::Settled, "settle", None);
                }
            }
            _ => {}
        }
    }

    pub(crate) fn drain(&mut self) {
        let mut pending = Vec::new();
        while let Some(ev) = EVENTS.with(|e| e.borrow_mut().pop_front()) {
            self.handle(ev, &mut pending);
        }
        for (pin, t) in pending {
            self.present(pin, Quality::Gesture, "wheel", Some(t));
            self.arm_settle(pin);
        }
    }
}
