//! 查看器的两条显示路径（ADR-0005）：静态 SDR 原图，以及精确设备像素尺寸的派生图。

use std::io::Cursor;
use std::path::PathBuf;

use image::codecs::webp::WebPEncoder;
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{AnimationDecoder, DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use rusqlite::OptionalExtension;

use super::{CACHE_DIR, Error, Inner};

// #45 合入后，在此适配还原度管线；缓存版本随管线提升，查看器与自定义协议不认识解码器。
const PIPELINE: &str = "v0";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayKind {
    Original,
    SdrDerivative,
}

/// 已转正方向的尺寸与本地显示文件。原图字节保持不变，由 WebView2 解释方向和颜色。
#[derive(Debug, Clone)]
pub struct DisplayImage {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub kind: DisplayKind,
}

pub(super) fn get(inner: &Inner, image_id: &str, target_px: u32) -> Result<DisplayImage, Error> {
    if target_px == 0 {
        return Err(Error::InvalidDisplaySize);
    }
    let (sha, relative, width, height, orientation): (String, String, u32, u32, u8) = inner
        .readers
        .get()
        .query_row(
            "SELECT sha256, rel_path, width, height, orientation FROM image WHERE id = ?1",
            [image_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?
        .ok_or(Error::UnknownImage)?;
    let original = inner.root.join(relative);
    let bytes = std::fs::read(&original)?;
    let format = image::guess_format(&bytes)?;
    if target_px >= width && !is_animated(&bytes, format)? && !is_hdr(&bytes, format)? {
        return Ok(DisplayImage {
            path: original,
            width,
            height,
            kind: DisplayKind::Original,
        });
    }
    let width_px = target_px.min(width);
    let height_px = ((height as f64) * (width_px as f64) / (width as f64))
        .round()
        .max(1.0) as u32;
    let path = inner
        .root
        .join(CACHE_DIR)
        .join("viewer")
        .join(PIPELINE)
        .join("sdr")
        .join(&sha[..2])
        .join(format!("{sha}-{width_px}x{height_px}.webp"));
    if !path.is_file() {
        let mut image = decode_still(&bytes, format)?;
        if let Some(o) = Orientation::from_exif(orientation) {
            image.apply_orientation(o);
        }
        image = image.resize_exact(width_px, height_px, FilterType::Lanczos3);
        let image = if image.color().has_alpha() {
            DynamicImage::ImageRgba8(image.to_rgba8())
        } else {
            DynamicImage::ImageRgb8(image.to_rgb8())
        };
        std::fs::create_dir_all(path.parent().expect("缓存路径有父目录"))?;
        let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
        let written = (|| -> Result<(), Error> {
            image.write_with_encoder(WebPEncoder::new_lossless(std::io::BufWriter::new(
                std::fs::File::create(&tmp)?,
            )))?;
            std::fs::rename(&tmp, &path)?;
            Ok(())
        })();
        if written.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        written?;
    }
    Ok(DisplayImage {
        path,
        width: width_px,
        height: height_px,
        kind: DisplayKind::SdrDerivative,
    })
}

fn is_animated(bytes: &[u8], format: ImageFormat) -> Result<bool, Error> {
    Ok(match format {
        ImageFormat::Gif => true,
        ImageFormat::Png => image::codecs::png::PngDecoder::new(Cursor::new(bytes))?.is_apng()?,
        ImageFormat::WebP => {
            image::codecs::webp::WebPDecoder::new(Cursor::new(bytes))?.has_animation()
        }
        _ => false,
    })
}

/// v0 的保守分流：只去掉 HDR 声明、不作还原度承诺；#45 接管描述与 SDR 色调映射。
fn is_hdr(bytes: &[u8], format: ImageFormat) -> Result<bool, Error> {
    if format == ImageFormat::Png {
        let mut at = 8;
        while let Some(head) = bytes.get(at..at + 8) {
            let len = u32::from_be_bytes(head[..4].try_into().expect("四字节长度")) as usize;
            let Some(end) = at.checked_add(12).and_then(|n| n.checked_add(len)) else {
                break;
            };
            let Some(payload) = bytes.get(at + 8..end.saturating_sub(4)) else {
                break;
            };
            if (&head[4..] == b"cICP" && payload.get(1).is_some_and(|t| matches!(t, 16 | 18)))
                || matches!(&head[4..], b"mDCV" | b"cLLI")
            {
                return Ok(true);
            }
            at = end;
        }
    }
    if format == ImageFormat::Jpeg {
        let mut at = 2;
        while bytes.get(at) == Some(&0xff) {
            let Some(&marker) = bytes.get(at + 1) else {
                break;
            };
            if marker == 0xda || marker == 0xd9 {
                break;
            }
            let Some(length) = bytes.get(at + 2..at + 4) else {
                break;
            };
            let length = u16::from_be_bytes(length.try_into().expect("两字节长度")) as usize;
            if length < 2 {
                break;
            }
            let Some(payload) = bytes.get(at + 4..at + 2 + length) else {
                break;
            };
            if (marker == 0xe1 || marker == 0xe2)
                && [
                    b"hdr-gain-map".as_slice(),
                    b"urn:iso:std:iso:ts:21496".as_slice(),
                ]
                .iter()
                .any(|needle| payload.windows(needle.len()).any(|w| w == *needle))
            {
                return Ok(true);
            }
            at += length + 2;
        }
    }
    // ICC 中的 cicp 标签也可以声明 PQ / HLG。
    let mut decoder = ImageReader::with_format(Cursor::new(bytes), format).into_decoder()?;
    if let Some(icc) = decoder.icc_profile()? {
        let count = icc
            .get(128..132)
            .map(|n| u32::from_be_bytes(n.try_into().expect("四字节长度")))
            .unwrap_or(0);
        for tag in icc
            .get(132..)
            .unwrap_or_default()
            .chunks_exact(12)
            .take(count as usize)
        {
            if &tag[..4] != b"cicp" {
                continue;
            }
            let offset = u32::from_be_bytes(tag[4..8].try_into().expect("四字节偏移")) as usize;
            if icc.get(offset..offset + 4) == Some(b"cicp")
                && icc.get(offset + 9).is_some_and(|t| matches!(t, 16 | 18))
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

pub(super) fn decode_still(bytes: &[u8], format: ImageFormat) -> Result<DynamicImage, Error> {
    let frames = match format {
        ImageFormat::Gif => {
            Some(image::codecs::gif::GifDecoder::new(Cursor::new(bytes))?.into_frames())
        }
        ImageFormat::Png => {
            let decoder = image::codecs::png::PngDecoder::new(Cursor::new(bytes))?;
            if decoder.is_apng()? {
                Some(decoder.apng()?.into_frames())
            } else {
                None
            }
        }
        ImageFormat::WebP => {
            let decoder = image::codecs::webp::WebPDecoder::new(Cursor::new(bytes))?;
            if decoder.has_animation() {
                Some(decoder.into_frames())
            } else {
                None
            }
        }
        _ => None,
    };
    match frames {
        Some(mut frames) => {
            let frame = frames.next().ok_or(Error::NoImageFrame)??;
            Ok(DynamicImage::ImageRgba8(frame.into_buffer()))
        }
        None => Ok(ImageReader::with_format(Cursor::new(bytes), format).decode()?),
    }
}
