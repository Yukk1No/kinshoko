//! 钉图的源图：读图 → 转正 → 按来源色彩声明转换到显示器配置文件（moxcms）→ 预乘 BGRA8 → 金字塔。
//!
//! 每帧不再做颜色转换：源图一次性转到显示器空间，缩放、旋转都在显示器的编码值上做，
//! 窗口里的像素原样交给 DWM。手势中从金字塔里不小于目标的一层缩，停手后从第 0 层按线性光精缩。

use std::io::Cursor;
use std::time::Instant;

use fast_image_resize::{self as fr, FilterType, ResizeAlg, Resizer};
use image::{DynamicImage, ImageDecoder, ImageReader};
use moxcms::{ColorProfile, Layout, RenderingIntent, TransformOptions};

/// 金字塔的一层：预乘 alpha 的 BGRA8，显示器编码值。
pub struct Level {
    pub width: u32,
    pub height: u32,
    pub px: Vec<u8>,
}

pub struct Source {
    pub levels: Vec<Level>,
    pub opaque: bool,
    /// 读图各步耗时与色彩说明，打印到日志。
    pub report: String,
}

impl Source {
    pub fn width(&self) -> u32 {
        self.levels[0].width
    }
    pub fn height(&self) -> u32 {
        self.levels[0].height
    }
    pub fn bytes(&self) -> usize {
        self.levels.iter().map(|l| l.px.len()).sum()
    }
}

/// `display_icc` 为显示器配置文件；为 `None` 时按 sRGB 显示器处理（或系统已做自动色彩管理）。
pub fn load(path: &std::path::Path, display_icc: Option<&[u8]>) -> Result<Source, String> {
    let t0 = Instant::now();
    let bytes = std::fs::read(path).map_err(|e| format!("读不到 {}: {e}", path.display()))?;
    let mut decoder = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .into_decoder()
        .map_err(|e| e.to_string())?;
    let icc = decoder.icc_profile().ok().flatten();
    let orientation = decoder.orientation().map_err(|e| e.to_string())?;
    let mut img = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    img.apply_orientation(orientation);
    let opaque = !img.color().has_alpha();
    let mut rgba = img.into_rgba8();
    let (w, h) = rgba.dimensions();
    let t_decode = t0.elapsed();

    let t1 = Instant::now();
    let src_profile = match icc.as_deref().map(ColorProfile::new_from_slice) {
        Some(Ok(p)) => Some(p),
        Some(Err(e)) => return Err(format!("原图 ICC 解析失败: {e:?}")),
        None => None,
    };
    let dst_profile = match display_icc.map(ColorProfile::new_from_slice) {
        Some(Ok(p)) => Some(p),
        Some(Err(e)) => return Err(format!("显示器 ICC 解析失败: {e:?}")),
        None => None,
    };
    let colour = if src_profile.is_none() && dst_profile.is_none() {
        "sRGB → sRGB 显示器：不转换".to_owned()
    } else {
        let src = src_profile.unwrap_or_else(ColorProfile::new_srgb);
        let dst = dst_profile.unwrap_or_else(ColorProfile::new_srgb);
        let options = TransformOptions {
            rendering_intent: RenderingIntent::Perceptual,
            ..TransformOptions::default()
        };
        let transform = src
            .create_transform_8bit(Layout::Rgba, &dst, Layout::Rgba, options)
            .map_err(|e| format!("建不出色彩转换: {e:?}"))?;
        let mut out = vec![0u8; rgba.len()];
        transform
            .transform(&rgba, &mut out)
            .map_err(|e| format!("{e:?}"))?;
        rgba.copy_from_slice(&out);
        format!(
            "{} → {}",
            if icc.is_some() {
                "原图 ICC"
            } else {
                "sRGB（无声明）"
            },
            if display_icc.is_some() {
                "显示器 ICC"
            } else {
                "sRGB"
            }
        )
    };
    let t_colour = t1.elapsed();

    // RGBA → 预乘 BGRA（UpdateLayeredWindow 要的格式）。
    let mut px = rgba.into_raw();
    for p in px.chunks_exact_mut(4) {
        let a = p[3] as u32;
        let (r, g, b) = (p[0] as u32, p[1] as u32, p[2] as u32);
        if a == 255 {
            p[0] = b as u8;
            p[2] = r as u8;
        } else {
            p[0] = ((b * a + 127) / 255) as u8;
            p[1] = ((g * a + 127) / 255) as u8;
            p[2] = ((r * a + 127) / 255) as u8;
        }
    }

    let t2 = Instant::now();
    let mut levels = vec![Level {
        width: w,
        height: h,
        px,
    }];
    let mut resizer = Resizer::new();
    let srgb = fr::create_srgb_mapper();
    let mut strips = crate::raster::Strips::default();
    while levels
        .last()
        .map_or(false, |l| l.width > 64 && l.height > 64)
    {
        let last = levels.last().unwrap();
        let (nw, nh) = (last.width.div_ceil(2), last.height.div_ceil(2));
        let mut px = vec![0u8; (nw * nh * 4) as usize];
        // 金字塔在线性光里做，与派生图（ADR 0005）的缩小方式一致。
        crate::raster::linear_resize(
            &mut resizer,
            &srgb,
            &mut strips,
            last,
            (0.0, 0.0, last.width as f64, last.height as f64),
            &mut px,
            nw,
            nh,
            ResizeAlg::Convolution(FilterType::Bilinear),
        );
        levels.push(Level {
            width: nw,
            height: nh,
            px,
        });
    }
    let t_pyramid = t2.elapsed();

    let report = format!(
        "{}×{}，{}；解码 {:.0} ms，颜色 {:.0} ms，金字塔 {} 层 {:.0} ms",
        w,
        h,
        colour,
        t_decode.as_secs_f64() * 1e3,
        t_colour.as_secs_f64() * 1e3,
        levels.len(),
        t_pyramid.as_secs_f64() * 1e3
    );
    Ok(Source {
        levels,
        opaque,
        report,
    })
}

/// 生成测试图（都放在调用方给的临时目录里）：
/// - `photo.jpg`：4000×6000，渐变、细线和噪点，模拟一张大参考图；
/// - `marker.png`：4000×6000，品红边框（宽度为短边的 5%）＋绿色内部＋黑白棋盘，逐帧核对用；
/// - `p3.png`：1200×800，嵌 Display P3 配置文件的高饱和色块，颜色管理用。
pub fn generate(dir: &std::path::Path) -> Result<(), String> {
    use image::{ImageEncoder, Rgb, RgbImage, codecs::png::PngEncoder};
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let (w, h) = (4000u32, 6000u32);
    let mut photo = RgbImage::new(w, h);
    let mut seed = 0x1234_5678u32;
    for (x, y, p) in photo.enumerate_pixels_mut() {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        let n = (seed & 15) as i32 - 8;
        let fx = x as f32 / w as f32;
        let fy = y as f32 / h as f32;
        let line = if (x / 3) % 40 == 0 || (y + x / 2) % 97 < 2 {
            -90
        } else {
            0
        };
        let r = (40.0 + 180.0 * fx) as i32 + n + line;
        let g = (60.0 + 150.0 * fy) as i32 + n + line;
        let b = (200.0 - 120.0 * (fx * fy)) as i32 + n + line;
        *p = Rgb([
            r.clamp(0, 255) as u8,
            g.clamp(0, 255) as u8,
            b.clamp(0, 255) as u8,
        ]);
    }
    photo
        .save_with_format(dir.join("photo.jpg"), image::ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;

    let border = w.min(h) / 20;
    let marker = RgbImage::from_fn(w, h, |x, y| {
        if x < border || y < border || x >= w - border || y >= h - border {
            Rgb([255, 0, 255])
        } else if ((x / 200) + (y / 200)) % 2 == 0 {
            Rgb([0, 200, 0])
        } else {
            Rgb([0, 120, 0])
        }
    });
    marker
        .save(dir.join("marker.png"))
        .map_err(|e| e.to_string())?;

    let p3 = ColorProfile::new_display_p3()
        .encode()
        .map_err(|e| format!("{e:?}"))?;
    let swatches: [[u8; 3]; 6] = [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 0],
        [0, 255, 255],
        [255, 0, 255],
    ];
    let (pw, ph) = (1200u32, 800u32);
    let img = RgbImage::from_fn(pw, ph, |x, y| {
        let i = (x / 400 + 3 * (y / 400)) as usize;
        Rgb(swatches[i.min(5)])
    });
    let file = std::fs::File::create(dir.join("p3.png")).map_err(|e| e.to_string())?;
    let mut enc = PngEncoder::new(file);
    enc.set_icc_profile(p3).map_err(|e| e.to_string())?;
    enc.write_image(&img, pw, ph, image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(())
}
