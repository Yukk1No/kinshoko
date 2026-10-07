//! 缩略图：还原度管线（`crate::fidelity`，ADR-0005）生成的 `sdr` 派生图。
//!
//! 缩略图是可重建缓存：`cache/thumbs/<管线版本>/<动态范围变体>/<sha 前两位>/<sha>-<像素|full>.<webp|png>`；
//! `full` 是不直接显示的原图在 1:1 与放大时用的原尺寸派生图。
//! 管线版本变化时旧目录整体作废：打开资料库时在后台删除，缩略图按需在新目录重建。

use std::path::{Path, PathBuf};

use super::{CACHE_DIR, Error, Inner, colour};
use crate::fidelity::render;

/// 缩略图管线版本。解码器、色彩策略、缩放或存储格式变化时提升。
/// v0：#44 的 sRGB 管线；v1：#45 的色彩管理管线。
pub(crate) const PIPELINE: &str = "v1";

/// 动态范围变体。首版只有 `sdr`；HDR 显示上线时加 `hdr`，不覆盖 `sdr`。
const SDR: &str = "sdr";

const THUMBS_DIR: &str = "thumbs";

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
    cached(inner, image_id, &px.to_string(), px)
}

/// 原尺寸（转正后）的 `sdr` 派生图，供不直接显示的原图在 1:1 与放大时使用。
pub(super) fn full_size(inner: &Inner, image_id: &str) -> Result<PathBuf, Error> {
    cached(inner, image_id, "full", u32::MAX)
}

fn cached(inner: &Inner, image_id: &str, label: &str, max_width: u32) -> Result<PathBuf, Error> {
    let (description, sha, original) = colour::get(inner, image_id)?;
    let container = render::container(&description);
    let path = inner
        .root
        .join(CACHE_DIR)
        .join(THUMBS_DIR)
        .join(PIPELINE)
        .join(SDR)
        .join(&sha[..2])
        .join(format!("{sha}-{label}.{}", container.extension()));
    if path.is_file() {
        return Ok(path);
    }

    let bytes = std::fs::read(original)?;
    let rendered = render::render_sdr(&bytes, max_width).map_err(Error::Undecodable)?;
    std::fs::create_dir_all(path.parent().expect("缓存路径有父目录"))?;
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    let written = std::fs::write(&tmp, &rendered.bytes).and_then(|()| std::fs::rename(&tmp, &path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written?;
    Ok(path)
}

/// 删除其他管线版本的缩略图目录。在后台线程里调用；失败只影响磁盘占用。
pub(super) fn remove_stale(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root.join(CACHE_DIR).join(THUMBS_DIR)) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name() != PIPELINE {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}
