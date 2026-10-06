//! 缩略图 v0 管线：按 sRGB 解释（不做色彩管理）、转正 EXIF 方向、Lanczos3 缩小、无损 WebP 保存。
//! #45 换成还原度管线时提升 [`PIPELINE`]，旧缓存自然失效。
//!
//! 缩略图是可重建缓存：缓存键 = 内容哈希 + 目标像素 + 管线版本，删掉随时重建。

use std::path::PathBuf;

use image::codecs::webp::WebPEncoder;
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{DynamicImage, ImageReader};
use rusqlite::OptionalExtension;

use super::{CACHE_DIR, Error, Inner};

/// 缩略图管线版本。算法或色彩策略变化时提升。
const PIPELINE: &str = "v0";

/// 缩略图宽度档位（设备像素）。请求取整到不小于它的最小档位，避免每种列宽各存一份。
const TIERS: [u32; 9] = [128, 192, 256, 384, 512, 768, 1024, 1536, 2048];

pub(super) fn tier(px: u32) -> u32 {
    TIERS
        .iter()
        .copied()
        .find(|&t| t >= px)
        .unwrap_or(TIERS[TIERS.len() - 1])
}

pub(super) fn get(inner: &Inner, image_id: &str, target_px: u32) -> Result<PathBuf, Error> {
    let px = tier(target_px);
    let (sha, rel_path, orientation): (String, String, u8) = inner
        .readers
        .get()
        .query_row(
            "SELECT sha256, rel_path, orientation FROM image WHERE id = ?1",
            [image_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or(Error::UnknownImage)?;

    let path = inner
        .root
        .join(CACHE_DIR)
        .join("thumbs")
        .join(PIPELINE)
        .join(&sha[..2])
        .join(format!("{sha}-{px}.webp"));
    if path.is_file() {
        return Ok(path);
    }

    let mut image = ImageReader::open(inner.root.join(rel_path))?
        .with_guessed_format()?
        .decode()?;
    if let Some(o) = Orientation::from_exif(orientation) {
        image.apply_orientation(o);
    }
    // 不放大：原图比档位窄时按原尺寸保存。
    if image.width() > px {
        let height = ((image.height() as f64) * (px as f64) / (image.width() as f64))
            .round()
            .max(1.0) as u32;
        image = image.resize_exact(px, height, FilterType::Lanczos3);
    }
    let image = if image.color().has_alpha() {
        DynamicImage::ImageRgba8(image.to_rgba8())
    } else {
        DynamicImage::ImageRgb8(image.to_rgb8())
    };

    std::fs::create_dir_all(path.parent().expect("缓存路径有父目录"))?;
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    let written = (|| -> Result<(), Error> {
        let file = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
        image.write_with_encoder(WebPEncoder::new_lossless(file))?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.map(|()| path)
}
