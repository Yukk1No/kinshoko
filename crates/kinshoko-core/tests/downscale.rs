//! 缩小方式（#48）：线性光与编码值空间是同一管线的参数，供探测程序并排生成两种缩略图。
//! 默认值由画师的选择决定（`docs/validation/acceptance.md`“图片还原度”一节）。

use image::ImageEncoder;
use kinshoko_core::fidelity::{self, DEFAULT_DOWNSCALE, Downscale};

/// 白底上隔列的 1 px 黑线：一半像素黑、一半白。
fn alternating_columns(w: u32, h: u32) -> Vec<u8> {
    let img = image::RgbImage::from_fn(w, h, |x, _| {
        if x % 2 == 0 {
            image::Rgb([0, 0, 0])
        } else {
            image::Rgb([255, 255, 255])
        }
    });
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgb8)
        .unwrap();
    out
}

fn centre_grey(bytes: &[u8]) -> u8 {
    let img = image::load_from_memory(bytes).unwrap().to_rgb8();
    let (w, h) = img.dimensions();
    img.get_pixel(w / 2, h / 2).0[1]
}

#[test]
fn half_black_lines_average_in_light_or_in_encoded_values() {
    let source = alternating_columns(600, 120);

    let linear = fidelity::render_sdr(&source, 100, Downscale::LinearLight).unwrap();
    let encoded = fidelity::render_sdr(&source, 100, Downscale::EncodedValue).unwrap();

    assert_eq!((linear.width, linear.height), (100, 20));
    assert_eq!((encoded.width, encoded.height), (100, 20));
    // 一半光：线性 0.5 的 sRGB 编码值约 188；编码值平均是 255 的一半，约 128。
    let (l, e) = (centre_grey(&linear.bytes), centre_grey(&encoded.bytes));
    assert!((182..=194).contains(&l), "线性光缩小得到 {l}");
    assert!((122..=134).contains(&e), "编码值缩小得到 {e}");
}

#[test]
fn the_default_is_linear_light_until_the_artist_chooses() {
    assert_eq!(DEFAULT_DOWNSCALE, Downscale::LinearLight);
}

#[test]
fn derivatives_say_what_they_are() {
    let source = alternating_columns(60, 12);
    let out = fidelity::render_sdr(&source, 30, Downscale::EncodedValue).unwrap();
    assert_eq!(out.mime, "image/webp");
    assert_eq!(&out.bytes[8..12], b"WEBP");
}
