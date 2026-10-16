//! 缩略图：还原度管线（`crate::fidelity`，ADR-0005）生成的 `sdr` 派生图。
//!
//! 缩略图是可重建缓存：`cache/thumbs/<管线版本>/<动态范围变体>/<sha 前两位>/<sha>-<像素|full>.<webp|png>`；
//! `full` 是不直接显示的原图在 1:1 与放大时用的原尺寸派生图。
//! 管线版本变化时旧目录整体作废：打开资料库时在后台删除，缩略图按需在新目录重建。
//!
//! 占位图（#110）是同一管线、同一目录下的另一份派生图：`<sha>-p32.<webp|png>`，长边约 32 px。
//! 导入时生成，打开资料库时在后台为缺少的补齐；浏览只读已有的，缺少时界面退回中性底色。

use std::path::{Path, PathBuf};
use std::sync::Weak;

use super::{CACHE_DIR, Error, Inner, colour};
use crate::fidelity::{DEFAULT_DOWNSCALE, Downscale, render};

/// 缩略图管线版本。解码器、色彩策略、缩放或存储格式变化时提升。
/// v0：#44 的 sRGB 管线；v1：#45 的色彩管理管线。
/// 缩小方式（#48）也是版本的一部分：改 `DEFAULT_DOWNSCALE` 即换目录，旧缓存整体作废。
pub(crate) const PIPELINE: &str = pipeline(DEFAULT_DOWNSCALE);

const fn pipeline(downscale: Downscale) -> &'static str {
    match downscale {
        Downscale::LinearLight => "v1",
        Downscale::EncodedValue => "v1-encoded",
    }
}

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

/// 精确宽度（设备像素，不取档位）的 `sdr` 派生图，供查看器缩小显示（#47）。
pub(super) fn exact(inner: &Inner, image_id: &str, px: u32) -> Result<PathBuf, Error> {
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
    let rendered =
        render::render_sdr(&bytes, max_width, DEFAULT_DOWNSCALE).map_err(Error::Undecodable)?;
    write_atomic(&path, &rendered.bytes)?;
    Ok(path)
}

/// 占位图长边（像素）。
const PLACEHOLDER_PX: u32 = 32;
const PLACEHOLDER: &str = "p32";

/// 占位图的宽度上限：长边不超过 [`PLACEHOLDER_PX`]，按转正后的尺寸保持比例。
fn placeholder_width(width: u32, height: u32) -> u32 {
    if width >= height {
        PLACEHOLDER_PX
    } else {
        ((u64::from(PLACEHOLDER_PX) * u64::from(width) + u64::from(height) / 2)
            / u64::from(height).max(1))
        .max(1) as u32
    }
}

fn placeholder_dir(root: &Path, sha: &str) -> PathBuf {
    root.join(CACHE_DIR)
        .join(THUMBS_DIR)
        .join(PIPELINE)
        .join(SDR)
        .join(&sha[..2])
}

/// 已生成的占位图文件；容器随来源分档（`webp` 或 `png`），两种都找。
fn placeholder_file(root: &Path, sha: &str) -> Option<PathBuf> {
    if sha.len() < 2 {
        return None;
    }
    let dir = placeholder_dir(root, sha);
    ["webp", "png"]
        .into_iter()
        .map(|ext| dir.join(format!("{sha}-{PLACEHOLDER}.{ext}")))
        .find(|path| path.is_file())
}

/// 已生成的占位图，作为 `data:` 地址随浏览页返回；还没有时为 `None`。只读，不生成。
pub(crate) fn placeholder(root: &Path, sha: &str) -> Option<String> {
    use base64::Engine;
    let path = placeholder_file(root, sha)?;
    let bytes = std::fs::read(&path).ok()?;
    let mime = match path.extension()?.to_str()? {
        "png" => "image/png",
        _ => "image/webp",
    };
    let payload = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{mime};base64,{payload}"))
}

/// 生成占位图要知道的事实：原图位置与转正后的尺寸。只涉及文件，不占用资料库连接。
struct PlaceholderSource {
    sha: String,
    rel_path: String,
    width: u32,
    height: u32,
}

/// 生成一张参考图的占位图（已有时什么也不做）。
pub(super) fn make_placeholder(inner: &Inner, image_id: &str) -> Result<(), Error> {
    use rusqlite::OptionalExtension;
    let source = inner
        .readers
        .get()
        .query_row(
            "SELECT sha256, rel_path, width, height FROM image WHERE id = ?1",
            [image_id],
            |row| {
                Ok(PlaceholderSource {
                    sha: row.get(0)?,
                    rel_path: row.get(1)?,
                    width: row.get(2)?,
                    height: row.get(3)?,
                })
            },
        )
        .optional()?
        .ok_or(Error::UnknownImage)?;
    render_placeholder(&inner.root, &source)
}

/// 与缩略图同一管线（ADR-0005）：同样的色彩声明规则、f32 预乘缩放与按来源分档的无损容器。
fn render_placeholder(root: &Path, source: &PlaceholderSource) -> Result<(), Error> {
    if placeholder_file(root, &source.sha).is_some() {
        return Ok(());
    }
    let bytes = std::fs::read(root.join(&source.rel_path))?;
    let max_width = placeholder_width(source.width, source.height);
    let rendered =
        render::render_sdr(&bytes, max_width, DEFAULT_DOWNSCALE).map_err(Error::Undecodable)?;
    let ext = if rendered.mime == "image/png" {
        "png"
    } else {
        "webp"
    };
    let path =
        placeholder_dir(root, &source.sha).join(format!("{}-{PLACEHOLDER}.{ext}", source.sha));
    write_atomic(&path, &rendered.bytes)
}

/// 为缺少占位图的参考图补生成，从新到旧（先补最可能在眼前的）。在后台线程里调用。
/// 只持有弱引用：资料库关闭后在下一张之前停下，不让数据库连接活得比资料库久。
/// 失败只是这张图继续退回中性底色，下次打开再试。
pub(super) fn fill_placeholders(inner: Weak<Inner>) {
    let (root, sources) = {
        let Some(inner) = inner.upgrade() else {
            return;
        };
        let conn = inner.readers.get();
        let sources = conn
            .prepare(
                "SELECT sha256, rel_path, width, height FROM image
                 GROUP BY sha256 ORDER BY MAX(seq) DESC",
            )
            .and_then(|mut stmt| {
                stmt.query_map([], |row| {
                    Ok(PlaceholderSource {
                        sha: row.get(0)?,
                        rel_path: row.get(1)?,
                        width: row.get(2)?,
                        height: row.get(3)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()
            });
        match sources {
            Ok(sources) => (inner.root.clone(), sources),
            Err(_) => return,
        }
    };
    for source in sources {
        if inner.strong_count() == 0 {
            return;
        }
        let _ = render_placeholder(&root, &source);
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    std::fs::create_dir_all(path.parent().expect("缓存路径有父目录"))?;
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    let written = std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(written?)
}

/// 删除一个原文件（按 SHA-256）的全部缩略图与派生图（永久删除后）。失败只影响磁盘占用。
pub(super) fn remove_for(root: &Path, sha: &str) {
    let Some(prefix) = sha.get(..2) else {
        return;
    };
    let dir = root
        .join(CACHE_DIR)
        .join(THUMBS_DIR)
        .join(PIPELINE)
        .join(SDR)
        .join(prefix);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let start = format!("{sha}-");
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(&start) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changing_the_downscale_changes_the_pipeline_version() {
        assert_ne!(
            pipeline(Downscale::LinearLight),
            pipeline(Downscale::EncodedValue)
        );
    }

    #[test]
    fn placeholders_keep_the_long_side_near_32_pixels() {
        assert_eq!(placeholder_width(4000, 3000), 32);
        assert_eq!(placeholder_width(1000, 4000), 8);
        assert_eq!(placeholder_width(1, 10_000), 1);
    }
}
