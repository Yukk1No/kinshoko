//! [`Draw`] → 着色器的统一变量（`pin.wgsl` 的 `Pin`）。纯函数。

use bytemuck::{Pod, Zeroable};

use crate::{Draw, Rect};

/// 采样方式（`flags.y`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub(crate) enum Mode {
    /// 1:1：取最近的纹素，不插值。
    Exact = 0,
    /// 缩小：mip 链上三线性。
    Minify = 1,
    /// 放大：Catmull-Rom。
    Magnify = 2,
}

/// `flags.w` 的位。
pub(crate) const LUT_IDENTITY: u32 = 1;
/// 查找表的输入是线性值（`LutData::Table` 的 `linear`）。
pub(crate) const LUT_LINEAR: u32 = 4;
pub(crate) const BLUR: u32 = 2;

/// 缩放比例离 1 这么近时按 1:1 逐像素取（与 `pinCanvasSize` 的 `pixelated` 同一个意思）。
const EXACT: f32 = 1e-3;
/// 模糊的标准差（第 0 层纹素）小于它时不模糊。
const MIN_BLUR: f32 = 0.25;

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Pod, Zeroable)]
pub(crate) struct PinUniform {
    /// 内容矩形 x, y, w, h（屏幕）。
    pub content: [f32; 4],
    /// 裁切 x0, y0, x1, y1（第 0 层纹素）。
    pub crop: [f32; 4],
    /// 说明层 x, y, w, h（屏幕）；w = 0 时没有。
    pub overlay: [f32; 4],
    /// 遮蔽墨色：预乘的编码值与 alpha。
    pub ink: [f32; 4],
    /// 增强边缘细线：预乘的编码值与 alpha。
    pub ring: [f32; 4],
    /// 窗口原点 x, y，不透明度，缩小时的 mip 层（log2 比例）。
    pub misc: [f32; 4],
    /// 阴影宽度，细线宽度，模糊标准差（第 0 层纹素），未用。
    pub shape: [f32; 4],
    /// 翻转旋转位，采样方式，可用的最高 mip 层，标志位。
    pub flags: [u32; 4],
}

/// 一张图：尺寸与 mip 层数。
#[derive(Debug, Clone, Copy)]
pub(crate) struct Source {
    pub width: u32,
    pub height: u32,
    pub levels: u32,
}

pub(crate) fn pack(
    draw: &Draw<'_>,
    source: Source,
    overlay: Option<(u32, u32)>,
    lut_bits: u32,
) -> PinUniform {
    let crop = clamp_crop(draw.crop, source);
    let odd = draw.turn.quarter % 2 == 1;
    let shown_width = if odd {
        draw.content.height
    } else {
        draw.content.width
    };
    // 每个屏幕像素对应多少源图像素（宽高比与裁切一致，取一个方向即可）。
    let ratio = (crop.width / shown_width.max(f32::MIN_POSITIVE)).max(f32::MIN_POSITIVE);
    let mode = if (ratio - 1.0).abs() < EXACT {
        Mode::Exact
    } else if ratio > 1.0 {
        Mode::Minify
    } else {
        Mode::Magnify
    };
    let top = top_level(crop, source.levels);

    let (ink, blur) = match draw.veil {
        Some(v) => {
            let a = v.ink[3] * v.amount;
            (
                [v.ink[0] * a, v.ink[1] * a, v.ink[2] * a, a],
                v.blur * v.amount * ratio,
            )
        }
        None => ([0.0; 4], 0.0),
    };
    let ring = crate::RING_COLOUR;
    let ring = [
        ring[0] * ring[3],
        ring[1] * ring[3],
        ring[2] * ring[3],
        ring[3],
    ];

    let overlay = match (draw.overlay, overlay) {
        (Some((_, [x, y])), Some((w, h))) => [x, y, w as f32, h as f32],
        _ => [0.0; 4],
    };
    let turn = u32::from(draw.turn.quarter % 4)
        | if draw.turn.flip_h { 4 } else { 0 }
        | if draw.turn.flip_v { 8 } else { 0 };
    let mut bits = lut_bits;
    if blur >= MIN_BLUR {
        bits |= BLUR;
    }
    PinUniform {
        content: [
            draw.content.x,
            draw.content.y,
            draw.content.width,
            draw.content.height,
        ],
        crop: [crop.x, crop.y, crop.x + crop.width, crop.y + crop.height],
        overlay,
        ink,
        ring,
        misc: [
            draw.window.x as f32,
            draw.window.y as f32,
            draw.opacity.clamp(0.0, 1.0),
            ratio.log2().max(0.0),
        ],
        shape: [draw.edge.max(0.0), draw.ring.max(0.0), blur, 0.0],
        flags: [turn, mode as u32, top, bits],
    }
}

/// 裁切夹在源图里，且至少一个纹素。
fn clamp_crop(crop: Rect, source: Source) -> Rect {
    let (w, h) = (source.width as f32, source.height as f32);
    let x0 = crop.x.clamp(0.0, w - 1.0);
    let y0 = crop.y.clamp(0.0, h - 1.0);
    let x1 = (crop.x + crop.width).clamp(x0 + 1.0, w);
    let y1 = (crop.y + crop.height).clamp(y0 + 1.0, h);
    Rect::new(x0, y0, x1 - x0, y1 - y0)
}

/// 还能用的最高 mip 层：第 `L` 层里至少有一个纹素完整落在裁切范围内（第 `L` 层纹素 `j`
/// 正好盖住第 0 层的 `[j·2^L, (j+1)·2^L)`，见 `mip.wgsl`）。裁切不足一个完整纹素时为 0。
pub(crate) fn top_level(crop: Rect, levels: u32) -> u32 {
    let fits = |level: u32| {
        let s = (1u64 << level) as f32;
        (crop.x / s).ceil() < ((crop.x + crop.width) / s).floor()
            && (crop.y / s).ceil() < ((crop.y + crop.height) / s).floor()
    };
    (1..levels).take_while(|&l| fits(l)).last().unwrap_or(0)
}

/// 源图需要的 mip 层数：一直缩到 1×1。
pub(crate) fn mip_levels(width: u32, height: u32) -> u32 {
    32 - width.max(height).max(1).leading_zeros()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Turn, Veil, Window};

    fn source(width: u32, height: u32) -> Source {
        Source {
            width,
            height,
            levels: mip_levels(width, height),
        }
    }

    fn draw(content: Rect, crop: Rect) -> Draw<'static> {
        Draw::new(
            Window {
                x: 10,
                y: 20,
                width: 400,
                height: 300,
            },
            content,
            crop,
        )
    }

    #[test]
    fn the_sampling_mode_follows_the_scale_and_a_quarter_turn_swaps_the_sides() {
        let src = source(200, 100);
        let crop = Rect::new(0.0, 0.0, 200.0, 100.0);
        let at = |content, quarter| {
            let mut d = draw(content, crop);
            d.turn = Turn {
                quarter,
                ..Turn::default()
            };
            pack(&d, src, None, LUT_IDENTITY)
        };
        assert_eq!(at(Rect::new(0.0, 0.0, 200.0, 100.0), 0).flags[1], 0);
        assert_eq!(at(Rect::new(0.0, 0.0, 100.0, 200.0), 1).flags[1], 0);
        let small = at(Rect::new(0.0, 0.0, 50.0, 25.0), 0);
        assert_eq!(small.flags[1], 1);
        assert_eq!(small.misc[3], 2.0);
        assert_eq!(at(Rect::new(0.0, 0.0, 600.0, 300.0), 2).flags[1], 2);
        assert_eq!(at(Rect::new(0.0, 0.0, 600.0, 300.0), 2).flags[0], 2);
    }

    #[test]
    fn mip_levels_reach_one_pixel_and_a_crop_limits_the_usable_levels() {
        assert_eq!(mip_levels(1, 1), 1);
        assert_eq!(mip_levels(1000, 3), 10);
        assert_eq!(top_level(Rect::new(0.0, 0.0, 1024.0, 1024.0), 11), 10);
        // 一块 x 从 3 到 35 的裁切：第 4 层（16 像素一个纹素）里只有 [16, 32) 完整落在里面，
        // 第 5 层的 [32, 64) 不在。
        assert_eq!(top_level(Rect::new(3.0, 0.0, 32.0, 64.0), 11), 4);
        assert_eq!(top_level(Rect::new(0.5, 0.5, 1.2, 1.2), 11), 0);
    }

    #[test]
    fn a_crop_is_kept_inside_the_image() {
        let p = pack(
            &draw(
                Rect::new(0.0, 0.0, 10.0, 10.0),
                Rect::new(-5.0, 90.0, 400.0, 400.0),
            ),
            source(100, 100),
            None,
            0,
        );
        assert_eq!(p.crop, [0.0, 90.0, 100.0, 100.0]);
    }

    #[test]
    fn the_veil_blur_is_in_source_texels_and_fades_with_the_ink() {
        let mut d = draw(
            Rect::new(0.0, 0.0, 640.0, 640.0),
            Rect::new(0.0, 0.0, 64.0, 64.0),
        );
        d.veil = Some(Veil {
            amount: 0.5,
            blur: 14.0,
            ink: [0.2, 0.4, 0.6, 0.92],
        });
        let p = pack(&d, source(64, 64), None, 0);
        assert!((p.shape[2] - 0.7).abs() < 1e-6);
        assert_eq!(p.flags[3] & BLUR, BLUR);
        assert!((p.ink[3] - 0.46).abs() < 1e-6);
        assert!((p.ink[0] - 0.2 * 0.46).abs() < 1e-6);

        d.veil = Some(Veil {
            amount: 0.01,
            ..d.veil.unwrap()
        });
        assert_eq!(pack(&d, source(64, 64), None, 0).flags[3] & BLUR, 0);
    }
}
