//! 资料库钉图 100% 时与原图逐像素一致（sRGB 图、sRGB 显示器，#284）：走应用里真正的一条路——
//! 派生图 → `pin_colour` 转线性 → 上传 → 按显示器配置文件建查找表 → [`draw_of`] → 离屏画。
//! 要 GPU 适配器（没有显卡时是 WARP）。

use image::{ImageEncoder, RgbaImage};
use kinshoko_core::desktop::pin_colour::{self, PinLut};
use kinshoko_core::desktop::{PinContent, Placement, SavedPin, pin_area};
use pin_render::{LutData, Pixels, Renderer};
use pin_shell::PinId;

use super::draw::draw_of;
use super::port::DrawJob;

/// Windows 自带的 sRGB 显示器配置文件（“sRGB 显示器”就是装着它的显示器）。
const WINDOWS_SRGB: &str = r"C:\Windows\System32\spool\drivers\color\sRGB Color Space Profile.icm";

/// 硬边、细线、逐像素噪声与平滑过渡都有的确定性测试图（不透明）。
fn test_image(w: u32, h: u32) -> RgbaImage {
    let mut state = 0x9e37_79b9_u32;
    RgbaImage::from_fn(w, h, |x, y| {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        let noise = (state & 0xff) as u8;
        match (x / 40 + y / 40) % 3 {
            0 => image::Rgba([(x * 255 / w) as u8, (y * 255 / h) as u8, noise, 255]),
            1 => image::Rgba([noise, 255 - noise, (x % 2 * 255) as u8, 255]),
            _ => image::Rgba([(x ^ y) as u8, noise / 2, 200, 255]),
        }
    })
}

fn png(image: &RgbaImage) -> Vec<u8> {
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();
    out
}

#[test]
fn a_library_pin_at_100_percent_is_the_original_pixel_for_pixel() {
    let display = std::fs::read(WINDOWS_SRGB).ok();
    if display.is_none() {
        eprintln!("没有 {WINDOWS_SRGB}，只按没有配置文件（sRGB）的显示器测");
    }
    let source = test_image(301, 207);
    let r = Renderer::new().expect("要有 GPU 适配器（或后备适配器）");
    let pixels = pin_colour::derivative(&png(&source)).unwrap();
    let image = r
        .upload(Pixels {
            width: pixels.width,
            height: pixels.height,
            rgba: &pixels.rgba,
        })
        .unwrap();
    let lut = match pin_colour::lut(None, display.as_deref()).unwrap() {
        PinLut::Identity => r.lut(LutData::Identity),
        PinLut::Table {
            clut,
            curve,
            linear,
        } => r.lut(LutData::Table {
            clut: &clut,
            curve: &curve,
            linear,
        }),
    }
    .unwrap();
    let pin = SavedPin {
        id: "p".into(),
        content: PinContent::Reference {
            library_id: "l".into(),
            image_id: "i".into(),
            source_width: 301,
            source_height: 207,
        },
        crop: None,
        width: 301,
        height: 207,
        placement: Placement {
            x: -40,
            y: 900,
            ..Placement::default()
        },
        opacity: 1.0,
        locked: false,
        member: None,
    };
    let content = pin.rect();
    let window = pin_area(content);
    let job = DrawJob {
        pin: PinId(1),
        slot: 0,
        window,
        content,
        state: pin,
        display: display.map(Into::into),
        display_scale: 1.0,
        veil: 0.0,
        ring: false,
    };
    let out = r
        .render_offscreen(&image, &draw_of(&job, (301, 207)), &lut)
        .unwrap();
    let (dx, dy) = ((content.x - window.x) as u32, (content.y - window.y) as u32);
    let mut differ = 0;
    for y in 0..207 {
        for x in 0..301 {
            if out.pixel(dx + x, dy + y) != source.get_pixel(x, y).0 {
                differ += 1;
            }
        }
    }
    assert_eq!(differ, 0, "{differ} 个像素与原图不同");
}
