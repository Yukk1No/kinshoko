//! Model-specific image preprocessing. Transparent pixels are composited onto white.

use crate::models::Preprocess;
use image::{imageops::FilterType, DynamicImage, Rgb, RgbImage};
use std::path::Path;

pub const SIZE: u32 = 448;

pub struct Prepared {
    pub shape: [usize; 4],
    pub data: Vec<f32>,
}

pub fn load(path: &Path) -> Result<DynamicImage, String> {
    image::open(path).map_err(|e| format!("无法解码图片: {e}"))
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

pub fn prepare(img: &DynamicImage, kind: Preprocess) -> Prepared {
    let rgb = flatten_on_white(img);
    match kind {
        Preprocess::PixAi => {
            // preprocess.json: bilinear resize to 448x448, to_tensor, normalize mean=std=0.5.
            let r = image::imageops::resize(&rgb, SIZE, SIZE, FilterType::Triangle);
            let n = (SIZE * SIZE) as usize;
            let mut data = vec![0f32; 3 * n];
            for (i, p) in r.pixels().enumerate() {
                for c in 0..3 {
                    data[c * n + i] = (p[c] as f32 / 255.0 - 0.5) / 0.5;
                }
            }
            Prepared { shape: [1, 3, SIZE as usize, SIZE as usize], data }
        }
        Preprocess::Wd => {
            // WD v3: pad to a white square, bicubic resize, BGR, NHWC, 0-255.
            let side = rgb.width().max(rgb.height());
            let mut square = RgbImage::from_pixel(side, side, Rgb([255, 255, 255]));
            image::imageops::overlay(
                &mut square,
                &rgb,
                ((side - rgb.width()) / 2) as i64,
                ((side - rgb.height()) / 2) as i64,
            );
            let r = image::imageops::resize(&square, SIZE, SIZE, FilterType::CatmullRom);
            let mut data = Vec::with_capacity((SIZE * SIZE * 3) as usize);
            for p in r.pixels() {
                data.extend_from_slice(&[p[2] as f32, p[1] as f32, p[0] as f32]);
            }
            Prepared { shape: [1, SIZE as usize, SIZE as usize, 3], data }
        }
    }
}
