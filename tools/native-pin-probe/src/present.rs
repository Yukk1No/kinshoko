//! 上屏：窗口矩形、ULW（或 DComp 对照组）、拖动只挪窗口、透明度。

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
    /// 窗口要显示的矩形：钉图（含阴影边）与虚拟桌面的交集；整个盖住某台显示器时让出最下面一行
    /// （ADR 0011，否则 Windows 报 `QUNS_BUSY`）。
    pub(crate) fn window_rect(&self, pin: &Pin) -> (Rect, Option<Rect>) {
        let (dw, dh) = pin.view.display_size(&pin.src);
        let full = Rect {
            x: pin.origin.0.round() as i32 - PIN_EDGE,
            y: pin.origin.1.round() as i32 - PIN_EDGE,
            w: dw + 2 * PIN_EDGE,
            h: dh + 2 * PIN_EDGE,
        };
        let mut shown = full.intersect(&virtual_screen());
        if let (Some(s), true) = (shown.as_mut(), self.no_fullscreen) {
            for m in &self.monitors {
                if s.x <= m.rect.x
                    && s.y <= m.rect.y
                    && s.right() >= m.rect.right()
                    && s.bottom() >= m.rect.bottom()
                {
                    s.h = m.rect.bottom() - 1 - s.y;
                }
            }
        }
        (full, shown)
    }

    pub(crate) fn present(
        &mut self,
        i: usize,
        quality: Quality,
        reason: &'static str,
        input_t: Option<i64>,
    ) {
        let (full, shown) = self.window_rect(&self.pins[i]);
        let pin = &mut self.pins[i];
        let Some(shown) = shown else {
            unsafe {
                let _ = ShowWindow(pin.hwnd, SW_HIDE);
            }
            return;
        };
        let t0 = qpc();
        let vis = Rect {
            x: shown.x - full.x,
            y: shown.y - full.y,
            w: shown.w,
            h: shown.h,
        };
        let need = (shown.w, shown.h);
        if let (Some(gpu), Some(gp)) = (self.gpu.as_ref(), pin.gpu.as_mut()) {
            let place = |hwnd: HWND| unsafe {
                SetWindowPos(
                    hwnd,
                    None,
                    shown.x,
                    shown.y,
                    shown.w,
                    shown.h,
                    SWP_NOZORDER
                        | SWP_NOACTIVATE
                        | SWP_NOOWNERZORDER
                        | SWP_NOCOPYBITS
                        | SWP_NOREDRAW
                        | SWP_SHOWWINDOW,
                )
                .expect("SetWindowPos");
            };
            if self.move_first {
                place(pin.hwnd);
            }
            let (resize_us, draw_us, present_us) =
                gp.draw(&pin.src, &pin.view, vis).expect("D2D 绘制");
            let t1 = qpc();
            if !self.move_first {
                place(pin.hwnd);
            }
            gpu.commit();
            let t2 = qpc();
            pin.shown = shown;
            pin.full = full;
            pin.rendered_quality = Some(quality);
            self.after_update(i, t2);
            self.presents.push(Present {
                reason,
                quality,
                level: 0,
                size: need,
                render_us: ((t1 - t0) as f64 * 1e6 / measure::qpf() as f64) as u64,
                resample_us: draw_us,
                blit_us: resize_us,
                shadow_us: present_us,
                ulw_us: ((t2 - t1) as f64 * 1e6 / measure::qpf() as f64) as u64,
                input_ms: input_t.map(|t| ms(t2 - t)),
                to_vblank_ms: measure::next_vblank_after(t2).map(|v| ms(v - t2)),
                cached: false,
            });
            return;
        }
        let fits = pin.dib.as_ref().is_some_and(|d| {
            d.w >= need.0
                && d.h >= need.1
                && (d.w as i64 * d.h as i64) <= 4 * (need.0 as i64 * need.1 as i64).max(65536)
        });
        if !fits {
            pin.dib = None;
            pin.dib = Some(Dib::new(need.0 + need.0 / 8, need.1 + need.1 / 8));
        }
        let dib = pin.dib.as_mut().unwrap();
        let stride = dib.w as usize * 4;
        let q = if pin.nearest && quality == Quality::Settled {
            Quality::Nearest
        } else {
            quality
        };
        let times = self
            .raster
            .render(&pin.src, &pin.view, q, vis, dib.pixels(), stride);
        let t1 = qpc();
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: pin.opacity,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        let pt = POINT {
            x: shown.x,
            y: shown.y,
        };
        let size = SIZE {
            cx: shown.w,
            cy: shown.h,
        };
        let src_pt = POINT { x: 0, y: 0 };
        unsafe {
            UpdateLayeredWindow(
                pin.hwnd,
                Some(self.screen_dc),
                Some(&pt),
                Some(&size),
                Some(dib.hdc),
                Some(&src_pt),
                COLORREF(0),
                Some(&blend),
                ULW_ALPHA,
            )
            .expect("UpdateLayeredWindow");
            if !IsWindowVisible(pin.hwnd).as_bool() {
                let _ = ShowWindow(pin.hwnd, SW_SHOWNOACTIVATE);
            }
        }
        let t2 = qpc();
        pin.shown = shown;
        pin.full = full;
        pin.rendered_quality = Some(q);
        self.after_update(i, t2);
        let to_vblank = measure::next_vblank_after(t2).map(|v| ms(v - t2));
        self.presents.push(Present {
            reason,
            quality: q,
            level: times.level,
            size: need,
            render_us: ((t1 - t0) as f64 * 1e6 / measure::qpf() as f64) as u64,
            resample_us: times.resample_us,
            blit_us: times.blit_us,
            shadow_us: times.shadow_us,
            ulw_us: ((t2 - t1) as f64 * 1e6 / measure::qpf() as f64) as u64,
            input_ms: input_t.map(|t| ms(t2 - t)),
            to_vblank_ms: to_vblank,
            cached: times.cached,
        });
    }

    /// 只挪位置（拖动）：内容不变时不重画，ULW 只给新位置。
    pub(crate) fn move_only(&mut self, i: usize, input_t: i64) {
        let (full, shown) = self.window_rect(&self.pins[i]);
        let pin = &self.pins[i];
        // 被屏幕边裁过的窗口，挪动后可见部分变了，要重画。
        if shown != Some(full) || pin.shown != pin.full {
            self.present(i, Quality::Gesture, "drag-clip", Some(input_t));
            return;
        }
        let t1 = qpc();
        unsafe {
            SetWindowPos(
                pin.hwnd,
                None,
                full.x,
                full.y,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            )
            .expect("SetWindowPos");
        }
        let t2 = qpc();
        let pin = &mut self.pins[i];
        pin.shown = full;
        pin.full = full;
        let quality = pin.rendered_quality.unwrap_or(Quality::Gesture);
        self.after_update(i, t2);
        self.presents.push(Present {
            reason: "drag",
            quality,
            level: 0,
            size: (full.w, full.h),
            render_us: 0,
            resample_us: 0,
            blit_us: 0,
            shadow_us: 0,
            ulw_us: ((t2 - t1) as f64 * 1e6 / measure::qpf() as f64) as u64,
            input_ms: Some(ms(t2 - input_t)),
            to_vblank_ms: measure::next_vblank_after(t2).map(|v| ms(v - t2)),
            cached: true,
        });
    }

    /// 透明度只改 ULW 的常量 alpha，不重画位图。
    pub(crate) fn set_opacity(&mut self, i: usize) {
        let pin = &self.pins[i];
        let Some(dib) = pin.dib.as_ref() else { return };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: pin.opacity,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        let pt = POINT {
            x: pin.shown.x,
            y: pin.shown.y,
        };
        let size = SIZE {
            cx: pin.shown.w,
            cy: pin.shown.h,
        };
        let t = qpc();
        unsafe {
            UpdateLayeredWindow(
                pin.hwnd,
                Some(self.screen_dc),
                Some(&pt),
                Some(&size),
                Some(dib.hdc),
                Some(&POINT::default()),
                COLORREF(0),
                Some(&blend),
                ULW_ALPHA,
            )
            .expect("UpdateLayeredWindow opacity");
        }
        eprintln!(
            "透明度 {} 只改常量 alpha：{:.2} ms",
            pin.opacity,
            ms(qpc() - t)
        );
        self.after_update(i, qpc());
    }

    pub(crate) fn after_update(&mut self, i: usize, t: i64) {
        let pin = &self.pins[i];
        RECTS.with(|r| {
            let mut r = r.borrow_mut();
            r.retain(|(k, _, _)| *k != i);
            r.push((i, pin.shown, pin.hwnd));
        });
        if let Some(log) = &self.verify_log {
            let (dw, dh) = pin.view.display_size(&pin.src);
            let content = Rect {
                x: pin.full.x + PIN_EDGE,
                y: pin.full.y + PIN_EDGE,
                w: dw,
                h: dh,
            };
            // marker.png 的品红边框宽度是短边的 5%（原图像素）。
            let border = (pin.src.width().min(pin.src.height()) as f64 / 20.0) * pin.view.scale;
            let _ = t;
            log.lock().unwrap().push(verify::Submitted {
                content,
                window: pin.shown,
                border,
                translucent: pin.opacity < 255,
            });
        }
    }
}
