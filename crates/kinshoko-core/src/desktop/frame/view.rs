//! 钉图怎么摆、怎么画：以光标为中心缩放、拖角缩放、透明度、翻转旋转后的绘制变换、局部在源图上的
//! 位置。状态就是 [`SavedPin`]，这里只换算；从前端 `pixels.ts`、`motion.ts`、`renderer.ts` 搬来。

use crate::desktop::{MIN_OPACITY, PinContent, Region, SavedPin};

/// 滚轮缩放：每格（`delta_y` 100）×1.12，向上（负值）放大。与前端 `wheelZoomScale` 相同。
pub fn wheel_zoom_scale(scale: f64, delta_y: f64) -> f64 {
    scale * 1.12f64.powf(-delta_y / 100.0)
}

/// 按下右下角时的缩放与内容的物理像素尺寸。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ZoomStart {
    pub scale: f64,
    pub width: u32,
    pub height: u32,
}

/// 拖右下角缩放：按 (dx, dy)（物理像素）里拖得多的方向算新缩放，保持宽高比。左上角不动由
/// [`ZoomAnchor`] 负责。与前端 `cornerZoomScale` 相同。
pub fn corner_zoom_scale(start: ZoomStart, dx: f64, dy: f64) -> f64 {
    let w = f64::from(start.width.max(1));
    let h = f64::from(start.height.max(1));
    let factor = ((w + dx) / w).max((h + dy) / h);
    start.scale * factor.max(0.0)
}

/// Ctrl+滚轮调透明度：每格 10%，向上更不透明，限制在 [`MIN_OPACITY`]～1。与前端 `wheelOpacity` 相同。
pub fn wheel_opacity(opacity: f64, delta_y: f64) -> f64 {
    let next = ((opacity - delta_y.signum() * 0.1) * 10.0).round() / 10.0;
    next.clamp(MIN_OPACITY, 1.0)
}

/// 缩放的锚点：屏幕上的一点（物理像素）和它落在内容上的相对位置（0～1，按未取整的内容尺寸）。
///
/// 手势开始（或光标挪动）时取一次，之后每一格都从它算位置。位置只能是整数像素，每格各自取整，
/// 误差不会一格格累积：光标下的点始终在半个像素以内。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ZoomAnchor {
    at: (f64, f64),
    fraction: (f64, f64),
}

impl ZoomAnchor {
    /// 以屏幕上的 `at` 为锚点。滚轮缩放取光标，拖角缩放取内容左上角。
    pub fn new(pin: &SavedPin, at: (f64, f64)) -> ZoomAnchor {
        let (w, h) = exact_size(pin);
        let p = &pin.placement;
        ZoomAnchor {
            at,
            fraction: ((at.0 - f64::from(p.x)) / w, (at.1 - f64::from(p.y)) / h),
        }
    }

    /// 缩放到 `scale`（限制同 [`SavedPin::clamp_scale`]），锚点下的点不动。锁定时不缩放，返回 false。
    pub fn zoom(&self, pin: &mut SavedPin, scale: f64) -> bool {
        if pin.locked {
            return false;
        }
        pin.placement.scale = pin.clamp_scale(scale);
        let (w, h) = exact_size(pin);
        pin.placement.x = (self.at.0 - self.fraction.0 * w).round() as i32;
        pin.placement.y = (self.at.1 - self.fraction.1 * h).round() as i32;
        true
    }
}

/// 旋转后、缩放后、未取整的内容尺寸（物理像素）。
fn exact_size(pin: &SavedPin) -> (f64, f64) {
    let p = &pin.placement;
    let (w, h) = if p.rotation % 2 == 1 {
        (pin.height, pin.width)
    } else {
        (pin.width, pin.height)
    };
    (f64::from(w.max(1)) * p.scale, f64::from(h.max(1)) * p.scale)
}

/// 画钉图的变换：以内容中心为原点，先镜像再顺时针转 `quarter_turns` 个四分之一圈，按
/// `width`×`height`（旋转前的目标尺寸，与内容尺寸一样取整）画。与前端 `pinDrawing` 相同。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Drawing {
    pub quarter_turns: u8,
    pub flip_h: bool,
    pub flip_v: bool,
    pub width: u32,
    pub height: u32,
    /// 未缩放：翻转和 90° 旋转都是像素置换，取最近的像素，不做平滑（截图 100% 逐像素）。
    pub nearest: bool,
}

/// 钉图此刻的绘制变换。内容尺寸就是 [`SavedPin::window_size`]（前端 `pinCanvasSize`）。
pub fn drawing(pin: &SavedPin) -> Drawing {
    let p = &pin.placement;
    let (w, h) = pin.window_size();
    let odd = p.rotation % 2 == 1;
    Drawing {
        quarter_turns: p.rotation % 4,
        flip_h: p.flip_h,
        flip_v: p.flip_v,
        width: if odd { h } else { w },
        height: if odd { w } else { h },
        nearest: (p.scale - 1.0).abs() < 1e-9,
    }
}

/// 遮蔽时只取这么宽的派生图：模糊与墨色罩之下看不出细节。与前端 `VEILED_SOURCE_PX` 相同。
pub const VEILED_SOURCE_PX: u32 = 64;

/// 钉图要画的源图。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceSize {
    /// 1:1 显示的文件：原图、动图与 HDR 等的 `sdr` 派生图，或截图本身。
    Full,
    /// 整张缩到这个宽度（物理像素）的派生图。
    Width(u32),
}

/// 钉图要画的源图：缩小时以派生图为源，遮蔽时最多 [`VEILED_SOURCE_PX`] 宽；截图钉图总是截图本身。
/// 与前端 `pinSourceSize` 相同。
pub fn source_size(pin: &SavedPin, veiled: bool) -> SourceSize {
    let PinContent::Reference { source_width, .. } = pin.content else {
        return SourceSize::Full;
    };
    let scale = pin.placement.scale;
    let mut px = if scale < 1.0 {
        ((f64::from(source_width) * scale).round() as u32).max(1)
    } else {
        source_width
    };
    if veiled {
        px = px.min(VEILED_SOURCE_PX);
    }
    if px >= source_width {
        SourceSize::Full
    } else {
        SourceSize::Width(px)
    }
}

/// 源图上的矩形（源图像素，派生图上可以是小数）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SourceRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 局部（原图像素）在一张 `width`×`height` 的源图上的位置：派生图按它与原图的比例换算，整图钉图为
/// 整张源图。局部以外的像素不画（局部钉图不露边）。与前端 `pinSourceRect` 相同。
pub fn source_rect(pin: &SavedPin, width: u32, height: u32) -> SourceRect {
    let (full_w, full_h) = match pin.content {
        PinContent::Reference {
            source_width,
            source_height,
            ..
        } => (source_width, source_height),
        PinContent::Capture { .. } => (width, height),
    };
    let crop = pin.crop.unwrap_or(Region {
        x: 0,
        y: 0,
        width: full_w,
        height: full_h,
    });
    let sx = f64::from(width) / f64::from(full_w.max(1));
    let sy = f64::from(height) / f64::from(full_h.max(1));
    SourceRect {
        x: f64::from(crop.x) * sx,
        y: f64::from(crop.y) * sy,
        width: f64::from(crop.width) * sx,
        height: f64::from(crop.height) * sy,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::frame::test_rng::Rng;
    use crate::desktop::{MAX_SCALE, MIN_SIDE, Placement};

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-12, "{a} != {b}");
    }

    fn pin(width: u32, height: u32, placement: Placement) -> SavedPin {
        SavedPin {
            id: "P1".into(),
            content: PinContent::Capture {
                capture_id: "C1".into(),
            },
            crop: None,
            width,
            height,
            placement,
            opacity: 1.0,
            locked: false,
            member: None,
        }
    }

    fn reference(scale: f64, crop: Option<Region>) -> SavedPin {
        SavedPin {
            content: PinContent::Reference {
                library_id: "L1".into(),
                image_id: "I1".into(),
                source_width: 800,
                source_height: 600,
            },
            crop,
            width: crop.map_or(800, |c| c.width),
            height: crop.map_or(600, |c| c.height),
            ..pin(
                800,
                600,
                Placement {
                    scale,
                    ..Placement::default()
                },
            )
        }
    }

    fn at(x: i32, y: i32, scale: f64) -> Placement {
        Placement {
            x,
            y,
            scale,
            ..Placement::default()
        }
    }

    /// 屏幕上的 `screen` 点落在图片（旋转前、未缩放）的哪个像素位置。
    fn image_point(p: &SavedPin, screen: (f64, f64)) -> (f64, f64) {
        let (w, h) = p.window_size();
        let fx = (screen.0 - f64::from(p.placement.x)) / f64::from(w);
        let fy = (screen.1 - f64::from(p.placement.y)) / f64::from(h);
        (fx * f64::from(p.width), fy * f64::from(p.height))
    }

    // 原型场景：以光标为中心缩放，光标下的点不漂移。一路滚上去再滚回来，误差不累积。
    #[test]
    fn wheel_zoom_keeps_the_point_under_the_cursor() {
        let mut p = pin(4000, 6000, at(100, 200, 0.1));
        let cursor = (100.0 + 1000.0 * 0.1 + 0.3, 200.0 + 3000.0 * 0.1 + 0.7);
        let start = image_point(&p, cursor);
        let anchor = ZoomAnchor::new(&p, cursor);
        let mut scale = p.placement.scale;
        for step in (0..40).map(|_| -100.0).chain((0..40).map(|_| 100.0)) {
            scale = wheel_zoom_scale(scale, step);
            assert!(anchor.zoom(&mut p, scale));
            let now = image_point(&p, cursor);
            // 半个物理像素以内，换成图片像素。
            let tolerance = 0.5 / p.placement.scale + 1e-9;
            assert!(
                (now.0 - start.0).abs() <= tolerance * 2.0,
                "{now:?} vs {start:?}"
            );
            assert!(
                (now.1 - start.1).abs() <= tolerance * 2.0,
                "{now:?} vs {start:?}"
            );
        }
        close(p.placement.scale, 0.1);
        assert_eq!((p.placement.x, p.placement.y), (100, 200));
    }

    #[test]
    fn random_wheel_zooms_never_drift_more_than_a_pixel() {
        let mut rng = Rng::new(281);
        for _ in 0..500 {
            let w = rng.range(1, 5000) as u32;
            let h = rng.range(1, 5000) as u32;
            let mut p = pin(
                w,
                h,
                at(
                    rng.range(-3000, 3000) as i32,
                    rng.range(-3000, 3000) as i32,
                    rng.float(0.05, 3.0),
                ),
            );
            p.placement.rotation = rng.range(0, 4) as u8;
            let (cw, ch) = p.window_size();
            let cursor = (
                f64::from(p.placement.x) + rng.float(0.0, f64::from(cw)),
                f64::from(p.placement.y) + rng.float(0.0, f64::from(ch)),
            );
            let anchor = ZoomAnchor::new(&p, cursor);
            let before = (
                (cursor.0 - f64::from(p.placement.x)) / exact_size(&p).0,
                (cursor.1 - f64::from(p.placement.y)) / exact_size(&p).1,
            );
            let mut scale = p.placement.scale;
            for _ in 0..30 {
                scale = wheel_zoom_scale(scale, rng.float(-300.0, 300.0));
                anchor.zoom(&mut p, scale);
                let (ew, eh) = exact_size(&p);
                // 锚点在内容上的位置换回屏幕：与光标相差不到半个物理像素。
                let x = f64::from(p.placement.x) + before.0 * ew;
                let y = f64::from(p.placement.y) + before.1 * eh;
                assert!((x - cursor.0).abs() <= 0.5 + 1e-6);
                assert!((y - cursor.1).abs() <= 0.5 + 1e-6);
            }
        }
    }

    #[test]
    fn corner_zoom_keeps_the_top_left_corner() {
        let mut p = pin(200, 100, at(50, 60, 1.0));
        let anchor = ZoomAnchor::new(&p, (50.0, 60.0));
        let start = ZoomStart {
            scale: 1.0,
            width: 200,
            height: 100,
        };
        assert!(anchor.zoom(&mut p, corner_zoom_scale(start, 200.0, 100.0)));
        assert_eq!(
            p.rect(),
            crate::desktop::ScreenRect {
                x: 50,
                y: 60,
                width: 400,
                height: 200
            }
        );
    }

    #[test]
    fn zoom_respects_the_limits_and_the_lock() {
        let mut p = pin(200, 100, at(0, 0, 1.0));
        let anchor = ZoomAnchor::new(&p, (0.0, 0.0));
        anchor.zoom(&mut p, 1000.0);
        close(p.placement.scale, MAX_SCALE);
        anchor.zoom(&mut p, 0.0001);
        close(p.placement.scale, f64::from(MIN_SIDE) / 200.0);
        p.locked = true;
        assert!(!anchor.zoom(&mut p, 2.0));
        close(p.placement.scale, f64::from(MIN_SIDE) / 200.0);
    }

    // 原型场景：绕中心旋转（SavedPin::rotate 沿用）。
    #[test]
    fn rotation_turns_around_the_centre() {
        let mut p = pin(4000, 6000, at(100, 100, 0.1));
        let c = p.rect();
        p.rotate(1);
        let r = p.rect();
        assert_eq!((r.width, r.height), (c.height, c.width));
        assert_eq!(r.x * 2 + r.width as i32, c.x * 2 + c.width as i32);
        assert_eq!(r.y * 2 + r.height as i32, c.y * 2 + c.height as i32);
        // 转回来回到原处。
        p.rotate(-1);
        assert_eq!(p.rect(), c);
    }

    // 以下与前端 pixels.test.ts、motion.test.ts、renderer.test.ts 的钉图用例一一对应，输入输出相同。

    #[test]
    fn content_size_matches_pin_canvas_size() {
        let size = |w, h, scale, rotation| {
            pin(
                w,
                h,
                Placement {
                    scale,
                    rotation,
                    ..Placement::default()
                },
            )
            .window_size()
        };
        assert_eq!(size(101, 37, 1.0, 0), (101, 37));
        assert_eq!(size(333, 7, 1.0, 0), (333, 7));
        assert_eq!(size(40, 10, 1.0, 1), (10, 40));
        assert_eq!(size(101, 37, 0.5, 0), (51, 19));
        assert_eq!(size(1, 1, 0.05, 0), (1, 1));
        assert!(drawing(&pin(101, 37, at(0, 0, 1.0))).nearest);
        assert!(!drawing(&pin(101, 37, at(0, 0, 0.5))).nearest);
    }

    #[test]
    fn drawing_matches_pin_drawing() {
        let base = pin(40, 10, at(0, 0, 1.0));
        assert_eq!(
            drawing(&base),
            Drawing {
                quarter_turns: 0,
                flip_h: false,
                flip_v: false,
                width: 40,
                height: 10,
                nearest: true
            }
        );
        let mut turned = base.clone();
        turned.placement.rotation = 1;
        let d = drawing(&turned);
        assert_eq!((d.quarter_turns, d.width, d.height), (1, 40, 10));
        assert_eq!(turned.window_size(), (10, 40));
        let mut scaled = pin(101, 37, at(0, 0, 1.5));
        scaled.placement.rotation = 3;
        let d = drawing(&scaled);
        assert_eq!((d.width, d.height), (152, 56));
        let mut flipped = base.clone();
        flipped.placement.flip_h = true;
        flipped.placement.flip_v = true;
        let d = drawing(&flipped);
        assert!(d.flip_h && d.flip_v);
    }

    #[test]
    fn corner_zoom_scale_matches_the_frontend() {
        let start = ZoomStart {
            scale: 1.0,
            width: 200,
            height: 100,
        };
        close(corner_zoom_scale(start, 200.0, 100.0), 2.0);
        close(corner_zoom_scale(start, -100.0, 0.0), 1.0);
        close(corner_zoom_scale(start, -100.0, -80.0), 0.5);
        close(
            corner_zoom_scale(
                ZoomStart {
                    scale: 0.5,
                    ..start
                },
                200.0,
                0.0,
            ),
            1.0,
        );
    }

    #[test]
    fn wheel_zoom_scale_matches_the_frontend() {
        close(wheel_zoom_scale(1.0, -100.0), 1.12);
        close(wheel_zoom_scale(1.12, 100.0), 1.0);
        close(wheel_zoom_scale(1.0, -50.0), 1.12f64.sqrt());
    }

    #[test]
    fn wheel_opacity_matches_the_frontend() {
        close(wheel_opacity(1.0, 100.0), 0.9);
        close(wheel_opacity(0.5, -100.0), 0.6);
        close(wheel_opacity(0.1, 100.0), 0.1);
        assert_eq!(wheel_opacity(1.0, -100.0), 1.0);
        close(wheel_opacity(0.15, 100.0), 0.1);
    }

    #[test]
    fn source_size_matches_pin_source_size() {
        let crop = Region {
            x: 100,
            y: 50,
            width: 300,
            height: 200,
        };
        assert_eq!(source_size(&reference(1.0, None), false), SourceSize::Full);
        assert_eq!(source_size(&reference(2.5, None), false), SourceSize::Full);
        assert_eq!(
            source_size(&reference(0.5, None), false),
            SourceSize::Width(400)
        );
        assert_eq!(
            source_size(&reference(0.25, Some(crop)), false),
            SourceSize::Width(200)
        );
        assert_eq!(
            source_size(&reference(0.001, None), false),
            SourceSize::Width(1)
        );
        assert_eq!(
            source_size(&reference(0.999, None), false),
            SourceSize::Width(799)
        );
        assert_eq!(
            source_size(&reference(1.0, None), true),
            SourceSize::Width(VEILED_SOURCE_PX)
        );
        assert_eq!(
            source_size(&reference(0.01, None), true),
            SourceSize::Width(8)
        );
        let capture = pin(800, 600, at(0, 0, 0.5));
        assert_eq!(source_size(&capture, false), SourceSize::Full);
    }

    #[test]
    fn source_rect_matches_pin_source_rect() {
        let crop = Region {
            x: 100,
            y: 50,
            width: 300,
            height: 200,
        };
        let whole = SourceRect {
            x: 0.0,
            y: 0.0,
            width: 400.0,
            height: 300.0,
        };
        assert_eq!(source_rect(&reference(0.5, None), 400, 300), whole);
        assert_eq!(
            source_rect(&reference(1.0, Some(crop)), 800, 600),
            SourceRect {
                x: 100.0,
                y: 50.0,
                width: 300.0,
                height: 200.0
            }
        );
        assert_eq!(
            source_rect(&reference(0.5, Some(crop)), 400, 300),
            SourceRect {
                x: 50.0,
                y: 25.0,
                width: 150.0,
                height: 100.0
            }
        );
        let capture = SavedPin {
            crop: Some(Region {
                x: 10,
                y: 5,
                width: 60,
                height: 40,
            }),
            ..pin(60, 40, at(0, 0, 0.5))
        };
        assert_eq!(
            source_rect(&capture, 800, 600),
            SourceRect {
                x: 10.0,
                y: 5.0,
                width: 60.0,
                height: 40.0
            }
        );
    }
}
