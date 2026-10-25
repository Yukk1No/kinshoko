//! 离屏比对：在真 GPU 设备（没有显卡时是后备适配器，Windows 上为 WARP）上画钉图并读回，
//! 与 `kinshoko-core` 的派生图、moxcms 直接转换和金样比较。
//!
//! WARP 在同一进程里多个设备同时画大量样本时偶发访问冲突（0xc0000005）：在 WARP 上用 nextest
//! （每个用例一个进程，CI 就这样跑）或 `--test-threads=1`。
//!
//! `PIN_RENDER_FALLBACK=1` 时只用后备适配器（WARP）。金样在 `tests/golden/`；改了画法要更新时用 `PIN_RENDER_BLESS=1 cargo test -p pin-render` 重写。

use std::path::PathBuf;
use std::sync::OnceLock;

use image::{ImageEncoder, RgbaImage};
use kinshoko_core::desktop::pin_colour::{self, PinLut, PinPixels};
use kinshoko_core::fidelity::gate::{self, GateSample};
use kinshoko_core::fidelity::pin_gate::{self, PinGateItem};
use kinshoko_core::fidelity::{Downscale, render_sdr};
use pin_render::{Draw, Error, Image, Lut, LutData, Pixels, Rect, Renderer, Turn, Veil, Window};

mod colour;
mod device;
mod geometry;
mod golden;

/// `PIN_RENDER_FALLBACK=1` 时只用后备适配器（WARP），在有显卡的机器上复现 CI。
fn renderer() -> Renderer {
    let r = if std::env::var_os("PIN_RENDER_FALLBACK").is_some() {
        Renderer::new_fallback()
    } else {
        Renderer::new()
    }
    .expect("要有 GPU 适配器（或后备适配器）");
    static SHOWN: OnceLock<()> = OnceLock::new();
    SHOWN.get_or_init(|| eprintln!("适配器：{}", r.describe()));
    r
}

fn upload(r: &Renderer, pixels: &PinPixels) -> Image {
    r.upload(Pixels {
        width: pixels.width,
        height: pixels.height,
        rgba: &pixels.rgba,
    })
    .unwrap()
}

fn lut(r: &Renderer, lut: &PinLut) -> Lut {
    match lut {
        PinLut::Identity => r.lut(LutData::Identity),
        PinLut::Table { clut, curve } => r.lut(LutData::Table { clut, curve }),
    }
    .unwrap()
}

fn png(image: &RgbaImage, icc: Option<Vec<u8>>) -> Vec<u8> {
    let mut out = Vec::new();
    let mut encoder = image::codecs::png::PngEncoder::new(&mut out);
    if let Some(icc) = icc {
        encoder.set_icc_profile(icc).unwrap();
    }
    encoder
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();
    out
}

/// 像照片一样有平滑过渡、细节和硬边的确定性测试图（不透明）。
fn photo(w: u32, h: u32) -> RgbaImage {
    test_image(w, h, true)
}

/// `harsh` 为 false 时只有平滑过渡：没有色块硬边、一像素细线和逐像素噪声。
fn test_image(w: u32, h: u32, harsh: bool) -> RgbaImage {
    RgbaImage::from_fn(w, h, |x, y| {
        let (fx, fy) = (x as f32 / w as f32, y as f32 / h as f32);
        let noise = if harsh {
            (x.wrapping_mul(73_856_093) ^ y.wrapping_mul(19_349_663)) % 23
        } else {
            0
        };
        let ring = (((fx - 0.6).powi(2) + (fy - 0.4).powi(2)).sqrt() * 90.0).sin();
        let r = 40.0 + 170.0 * fx + 25.0 * ring + noise as f32;
        let g = 30.0 + 150.0 * fy + 40.0 * (fx * 37.0).sin() * (fy * 23.0).cos();
        let b = if !harsh {
            130.0
        } else if (x / 37 + y / 53) % 2 == 0 {
            200.0
        } else {
            60.0
        } + 20.0 * ring;
        // 几条一像素宽的细线。
        let line = harsh && (x % 97 == 0 || y % 89 == 0);
        let px = if line { [15.0, 15.0, 15.0] } else { [r, g, b] };
        image::Rgba([
            px[0].clamp(0.0, 255.0) as u8,
            px[1].clamp(0.0, 255.0) as u8,
            px[2].clamp(0.0, 255.0) as u8,
            255,
        ])
    })
}

fn window_at(x: i32, y: i32, width: u32, height: u32) -> Window {
    Window {
        x,
        y,
        width,
        height,
    }
}

/// 窗口刚好是内容（没有阴影）时的一次绘制。
fn plain(content: (i32, i32, u32, u32), crop: Rect) -> Draw<'static> {
    let (x, y, w, h) = content;
    Draw::new(
        window_at(x, y, w, h),
        Rect::new(x as f32, y as f32, w as f32, h as f32),
        crop,
    )
}

fn full(image: &RgbaImage) -> Rect {
    Rect::new(0.0, 0.0, image.width() as f32, image.height() as f32)
}

/// 两张图逐像素相同；不同时报不同的像素数、最大差和第一处，不把整张图打出来。
fn assert_same(got: &RgbaImage, want: &RgbaImage, what: &str) {
    assert_eq!(got.dimensions(), want.dimensions(), "{what}：尺寸不同");
    let diffs: Vec<(u32, u32, [u8; 4], [u8; 4])> = got
        .enumerate_pixels()
        .filter(|(x, y, p)| want.get_pixel(*x, *y) != *p)
        .map(|(x, y, p)| (x, y, p.0, want.get_pixel(x, y).0))
        .collect();
    if let Some(first) = diffs.first() {
        let max = diffs
            .iter()
            .flat_map(|(_, _, a, b)| (0..4).map(move |c| a[c].abs_diff(b[c])))
            .max()
            .unwrap();
        panic!(
            "{what}：{} 个像素不同，最大差 {max}，第一处 {first:?}",
            diffs.len()
        );
    }
}

fn straight(rendered: &pin_render::RgbaImage) -> RgbaImage {
    RgbaImage::from_raw(rendered.width, rendered.height, rendered.data.clone()).unwrap()
}
