//! 一次绘制交给 pin-render 的参数：由钉图状态、窗口与源图尺寸换算，不碰 GPU。

use kinshoko_core::desktop::PIN_EDGE;
use kinshoko_core::desktop::frame::{drawing, source_rect};

use super::port::DrawJob;

/// 遮蔽的模糊半径（`pin-veil` 的 `blur(14px)`），CSS 像素。
const VEIL_BLUR: f64 = 14.0;
/// 遮蔽的墨色：`--veil`（#2b2747）的 sRGB 编码值，不透明度 0.92。
const VEIL_INK: [f32; 4] = [43.0 / 255.0, 39.0 / 255.0, 71.0 / 255.0, 0.92];
/// 增强钉图边缘那圈细线的宽度（`0 0 0 1px`），CSS 像素。
const RING: f64 = 1.0;
/// 出现提示框（`.pin-appear` 的 `inset 0 0 0 2px var(--accent)`）：宽度 CSS 像素，浅色、深色主题的
/// `--accent`。
const APPEAR: f64 = 2.0;
const ACCENT_LIGHT: [f32; 3] = [224.0 / 255.0, 118.0 / 255.0, 143.0 / 255.0];
const ACCENT_DARK: [f32; 3] = [227.0 / 255.0, 179.0 / 255.0, 79.0 / 255.0];

/// `image` 是已上传的源图尺寸（整图或缩小的派生图；占位时是 1×1 的灰）。`overlay` 是画好的说明层与它
/// 相对内容左上角的位置。
pub fn draw_of<'a>(
    job: &DrawJob,
    image: (u32, u32),
    overlay: Option<(&'a pin_render::Overlay, (i32, i32))>,
) -> pin_render::Draw<'a> {
    let d = drawing(&job.state);
    let src = if job.placeholder {
        kinshoko_core::desktop::frame::RectF {
            x: 0.0,
            y: 0.0,
            width: f64::from(image.0),
            height: f64::from(image.1),
        }
    } else {
        source_rect(&job.state, image.0, image.1)
    };
    let (w, c) = (job.window, job.content);
    pin_render::Draw {
        turn: pin_render::Turn {
            quarter: d.quarter_turns,
            flip_h: d.flip_h,
            flip_v: d.flip_v,
        },
        opacity: job.state.opacity as f32,
        edge: PIN_EDGE as f32,
        ring: if job.ring {
            (RING * job.display_scale) as f32
        } else {
            0.0
        },
        veil: (job.veil > 0.0).then(|| pin_render::Veil {
            amount: job.veil.min(1.0),
            blur: (VEIL_BLUR * job.display_scale) as f32,
            ink: VEIL_INK,
        }),
        appear: (job.appear > 0.0).then(|| {
            let [r, g, b] = if job.dark { ACCENT_DARK } else { ACCENT_LIGHT };
            pin_render::Appear {
                width: (APPEAR * job.display_scale) as f32,
                colour: [r, g, b, job.appear.min(1.0)],
            }
        }),
        overlay: overlay.map(|(o, (x, y))| {
            (
                o,
                [
                    job.content.x.saturating_add(x) as f32,
                    job.content.y.saturating_add(y) as f32,
                ],
            )
        }),
        ..pin_render::Draw::new(
            pin_render::Window {
                x: w.x,
                y: w.y,
                width: w.width,
                height: w.height,
            },
            pin_render::Rect::new(c.x as f32, c.y as f32, c.width as f32, c.height as f32),
            pin_render::Rect::new(
                src.x as f32,
                src.y as f32,
                src.width as f32,
                src.height as f32,
            ),
        )
    }
}

#[cfg(test)]
mod tests {
    use kinshoko_core::desktop::{PinContent, Placement, Region, SavedPin, ScreenRect};
    use pin_shell::PinId;

    use super::*;

    fn job(crop: Option<Region>, scale: f64) -> DrawJob {
        let pin = SavedPin {
            id: "p".into(),
            content: PinContent::Reference {
                library_id: "l".into(),
                image_id: "i".into(),
                source_width: 400,
                source_height: 200,
            },
            crop,
            width: crop.map_or(400, |c| c.width),
            height: crop.map_or(200, |c| c.height),
            placement: Placement {
                x: 50,
                y: 60,
                scale,
                rotation: 1,
                flip_h: true,
                ..Placement::default()
            },
            opacity: 0.5,
            locked: false,
            member: None,
        };
        DrawJob {
            pin: PinId(1),
            slot: 0,
            window: ScreenRect {
                x: 30,
                y: 40,
                width: 300,
                height: 500,
            },
            content: pin.rect(),
            state: pin,
            display: None,
            display_scale: 1.5,
            veil: 0.0,
            ring: false,
            appear: 0.0,
            dark: false,
            placeholder: false,
            caption: Default::default(),
        }
    }

    #[test]
    fn carries_window_content_turn_opacity_and_shadow() {
        let j = job(None, 1.0);
        let d = draw_of(&j, (400, 200), None);
        assert_eq!(
            d.window,
            pin_render::Window {
                x: 30,
                y: 40,
                width: 300,
                height: 500
            }
        );
        let c = j.state.rect();
        assert_eq!(
            d.content,
            pin_render::Rect::new(c.x as f32, c.y as f32, c.width as f32, c.height as f32)
        );
        assert_eq!(
            d.turn,
            pin_render::Turn {
                quarter: 1,
                flip_h: true,
                flip_v: false
            }
        );
        assert_eq!(d.opacity, 0.5);
        assert_eq!(d.edge, PIN_EDGE as f32);
        assert_eq!(d.crop, pin_render::Rect::new(0.0, 0.0, 400.0, 200.0));
        assert_eq!((d.ring, d.veil), (0.0, None));
    }

    #[test]
    fn veil_and_ring_are_sized_in_css_pixels_of_the_display() {
        let mut j = job(None, 1.0);
        j.veil = 0.25;
        j.ring = true;
        let d = draw_of(&j, (400, 200), None);
        assert_eq!(d.ring, 1.5);
        let veil = d.veil.expect("遮蔽");
        assert_eq!((veil.amount, veil.blur), (0.25, 21.0));
        assert_eq!(veil.ink, VEIL_INK);
    }

    #[test]
    fn the_appear_ring_is_2_css_px_of_the_theme_accent() {
        let mut j = job(None, 1.0);
        j.appear = 0.5;
        let d = draw_of(&j, (400, 200), None);
        let a = d.appear.expect("提示框");
        assert_eq!(a.width, 3.0);
        assert_eq!(a.colour, [224.0 / 255.0, 118.0 / 255.0, 143.0 / 255.0, 0.5]);
        j.dark = true;
        assert_eq!(
            draw_of(&j, (400, 200), None).appear.unwrap().colour[1],
            179.0 / 255.0
        );
        j.appear = 0.0;
        assert_eq!(draw_of(&j, (400, 200), None).appear, None);
    }

    #[test]
    fn a_placeholder_shows_the_whole_grey_texel() {
        let mut j = job(None, 1.0);
        j.placeholder = true;
        let d = draw_of(&j, (1, 1), None);
        assert_eq!(d.crop, pin_render::Rect::new(0.0, 0.0, 1.0, 1.0));
    }

    #[test]
    fn a_crop_maps_onto_a_smaller_derivative() {
        let crop = Region {
            x: 100,
            y: 50,
            width: 200,
            height: 100,
        };
        let d = draw_of(&job(Some(crop), 0.5), (200, 100), None);
        assert_eq!(d.crop, pin_render::Rect::new(50.0, 25.0, 100.0, 50.0));
    }
}
