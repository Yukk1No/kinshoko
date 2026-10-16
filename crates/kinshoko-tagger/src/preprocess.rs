//! PixAI v1.0 的预处理（`tagger_pipeline.rescale_pad`），移植自 `tools/tagger-probe`。
//!
//! 透明像素先叠在白底上；最长边缩放到 1008（向下取整），保持比例，双线性；居中放在黑底画布上；
//! RGB、CHW，`(x/255 - 0.5)/0.5`，所以留白是 −1。已知差异：缩放核与 PyTorch 的抗锯齿不同，
//! 少数贴近阈值的标签会翻转（#6：8 张图 449 个标签中 4 个）。

use image::imageops::FilterType;
use image::{DynamicImage, Rgb, RgbImage};

pub const SIDE: u32 = 1008;

pub struct Prepared {
    pub shape: [usize; 4],
    pub data: Vec<f32>,
}

fn flatten_on_white(img: &DynamicImage) -> RgbImage {
    let rgba = img.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = p[3] as f32 / 255.0;
        let mix = |c: u8| (c as f32 * a + 255.0 * (1.0 - a)).round() as u8;
        out.put_pixel(x, y, Rgb([mix(p[0]), mix(p[1]), mix(p[2])]));
    }
    out
}

pub fn prepare(img: &DynamicImage) -> Prepared {
    let rgb = flatten_on_white(img);
    let (w, h) = (rgb.width(), rgb.height());
    let r = (SIDE as f64 / h as f64).min(SIDE as f64 / w as f64);
    let (nw, nh) = (
        ((w as f64 * r) as u32).clamp(1, SIDE),
        ((h as f64 * r) as u32).clamp(1, SIDE),
    );
    let resized = if (nw, nh) == (w, h) {
        rgb
    } else {
        image::imageops::resize(&rgb, nw, nh, FilterType::Triangle)
    };
    let (left, top) = ((SIDE - nw) / 2, (SIDE - nh) / 2);
    let n = (SIDE * SIDE) as usize;
    let mut data = vec![-1f32; 3 * n];
    for (x, y, p) in resized.enumerate_pixels() {
        let i = ((y + top) * SIDE + x + left) as usize;
        for c in 0..3 {
            data[c * n + i] = (p[c] as f32 / 255.0 - 0.5) / 0.5;
        }
    }
    Prepared {
        shape: [1, 3, SIDE as usize, SIDE as usize],
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn at(p: &Prepared, c: usize, x: u32, y: u32) -> f32 {
        let n = (SIDE * SIDE) as usize;
        p.data[c * n + (y * SIDE + x) as usize]
    }

    #[test]
    fn a_wide_image_is_scaled_to_1008_and_padded_black_above_and_below() {
        // 2016 × 1008 的纯红图：缩到 1008 × 504，上下各留 252 行。
        let img =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(2016, 1008, Rgba([255, 0, 0, 255])));
        let p = prepare(&img);
        assert_eq!(p.shape, [1, 3, 1008, 1008]);
        assert_eq!(at(&p, 0, 500, 0), -1.0, "留白是黑色（归一化后 −1）");
        assert_eq!(at(&p, 0, 500, 251), -1.0);
        assert_eq!(at(&p, 0, 500, 252), 1.0, "红通道 255 → 1");
        assert_eq!(at(&p, 1, 500, 252), -1.0, "绿通道 0 → −1");
        assert_eq!(at(&p, 0, 500, 755), 1.0);
        assert_eq!(at(&p, 0, 500, 756), -1.0);
    }

    #[test]
    fn transparent_pixels_become_white() {
        let img = DynamicImage::ImageRgba8(RgbaImage::from_pixel(1008, 1008, Rgba([0, 0, 0, 0])));
        let p = prepare(&img);
        for c in 0..3 {
            assert_eq!(at(&p, c, 10, 10), 1.0);
        }
    }
}
