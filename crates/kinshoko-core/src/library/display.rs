//! 查看器在“适应窗口”等缩小显示时的文件（#47，ADR-0005）。
//!
//! 缩小不交给 Chromium：按查看器要的设备像素宽度，由还原度管线（`crate::fidelity`，#45）
//! 生成精确尺寸的 `sdr` 派生图，与缩略图共用缓存目录与管线版本（见 `thumbnail.rs`）。
//! 1:1 与放大仍走 [`super::Library::display`]。

use rusqlite::OptionalExtension;

use super::{DisplayFile, DisplayRoute, Error, Inner, thumbnail};

/// 目标宽度不小于原图（转正后）宽度时返回 `None`，调用方改走 1:1 的显示路线。
pub(super) fn scaled(
    inner: &Inner,
    image_id: &str,
    target_px: u32,
) -> Result<Option<DisplayFile>, Error> {
    if target_px == 0 {
        return Err(Error::InvalidDisplaySize);
    }
    let width: u32 = inner
        .readers
        .get()
        .query_row("SELECT width FROM image WHERE id = ?1", [image_id], |row| {
            row.get(0)
        })
        .optional()?
        .ok_or(Error::UnknownImage)?;
    if target_px >= width {
        return Ok(None);
    }
    Ok(Some(DisplayFile {
        route: DisplayRoute::SdrDerivative,
        path: thumbnail::exact(inner, image_id, target_px)?,
    }))
}
