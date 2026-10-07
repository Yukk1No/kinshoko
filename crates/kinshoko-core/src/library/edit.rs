//! 整理参考图：一次批量编辑若干张图，返回重新计算后的详情（#42 `edit(ids, 编辑列表)`）；
//! 以及查看单张时的详情 `image(id)`。

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::rating::{self, ContentRating, ImageRating};
use super::{Error, Inner, LibraryEvent, folders, lens, now_ms, tags};

/// 对参考图的一项编辑。一次 `edit` 把编辑列表按顺序用在每张图上，全部成功才提交。
///
/// 新的编辑种类（例如标签决定、分级）在这里加变体，并在本模块的 `apply` 里处理。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum ImageEdit {
    /// 放入文件夹；已在其中时不变。
    #[serde(rename_all = "camelCase")]
    AddToFolder { folder_id: String },
    /// 移出文件夹；不在其中时不变。
    #[serde(rename_all = "camelCase")]
    RemoveFromFolder { folder_id: String },
    /// 写下画师的备注。空字符串也算画师写的（清空了备注）。
    SetNote { text: String },
    /// 撤掉画师的备注，退回来源提供的备注。
    RevertNote,
    /// 可恢复删除：移进回收站，不再出现在浏览与计数中；文件夹与备注保留。
    /// 已在回收站里的图保持原来的删除时间。
    Delete,
    /// 从回收站恢复。
    Restore,
    /// 画师修正内容分级：优先于自动分级，重新打标不覆盖。
    SetRating { rating: ContentRating },
    /// 撤掉画师的分级，退回自动分级。
    RevertRating,
}

/// 参考图所在的一个文件夹。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FolderRef {
    pub id: String,
    pub name: String,
}

/// 备注：画师写的与来源提供的分开保存。画师写过时显示画师的，否则显示来源的。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageNote {
    /// 画师写的备注；`None` 表示没有写过（或已退回来源）。
    pub manual: Option<String>,
    /// 各来源提供的备注（例如 Eagle 的整图备注）。普通文件导入没有。
    pub sources: Vec<SourceNote>,
}

/// 某个来源提供的备注。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceNote {
    /// 来源种类，例如 `file`、`eagle`。
    pub source: String,
    pub text: String,
}

/// 查看单张参考图所需的详情。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageDetail {
    pub id: String,
    pub original_name: String,
    /// 收集时间（Unix 毫秒）：Eagle btime → modificationTime → 导入时间。
    #[ts(type = "number")]
    pub collected_at: i64,
    pub source_links: Vec<String>,
    pub width: u32,
    pub height: u32,
    /// 所在的文件夹，按名称排序。
    pub folders: Vec<FolderRef>,
    pub note: ImageNote,
    /// 移进回收站的时间（Unix 毫秒）；不在回收站时为空。
    #[ts(type = "number | null")]
    pub deleted_at: Option<i64>,
    /// 内容分级：自动、人工与有效。
    pub rating: ImageRating,
}

pub(super) fn edit(
    inner: &Inner,
    ids: &[String],
    edits: &[ImageEdit],
) -> Result<Vec<ImageDetail>, Error> {
    let mut ids = ids.to_vec();
    let mut seen = std::collections::HashSet::new();
    ids.retain(|id| seen.insert(id.clone()));
    let edits = edits.to_vec();
    // 删除与恢复改变标签计数：词表修订号随之前进。人工分级跨过“含成人内容”时，安全模式下
    // 可见的词表也变了，同样前进（见下方 `resealed`）。
    let recount = edits
        .iter()
        .any(|e| matches!(e, ImageEdit::Delete | ImageEdit::Restore));
    let changed = ids.clone();
    let lens = inner.lens_filter();
    let (details, revision, resealed) = inner.write(move |tx| {
        for id in &ids {
            lens::require_visible(tx, &lens, id)?;
        }
        let mut resealed = false;
        for edit in &edits {
            resealed |= apply(tx, &ids, edit)?;
        }
        let details = ids
            .iter()
            .map(|id| detail(tx, id))
            .collect::<Result<Vec<_>, _>>()?;
        let revision = if recount || resealed {
            Some(tags::bump_revision(tx)?)
        } else {
            None
        };
        Ok((details, revision, resealed))
    })?;
    let library_id = inner.info.id.clone();
    // 人工分级跨过“含成人内容”：安全模式下这些图被封印或放出，浏览结果与计数都过期。
    if resealed {
        inner.hub.publish(LibraryEvent::ListStale {
            library_id: library_id.clone(),
        });
    }
    inner.hub.publish(LibraryEvent::ImagesChanged {
        library_id: library_id.clone(),
        image_ids: changed,
    });
    if let Some(revision) = revision {
        inner.hub.publish(LibraryEvent::VocabularyChanged {
            library_id,
            revision,
        });
    }
    Ok(details)
}

/// 返回是否有图因分级改变而被安全模式封印或放出。
fn apply(conn: &Connection, ids: &[String], edit: &ImageEdit) -> Result<bool, Error> {
    match edit {
        ImageEdit::AddToFolder { folder_id } => {
            folders::ensure_folder(conn, folder_id)?;
            let mut stmt = conn.prepare_cached(
                "INSERT OR IGNORE INTO folder_member (folder_id, image_id, added_at)
                 VALUES (?1, ?2, ?3)",
            )?;
            let now = now_ms();
            for id in ids {
                stmt.execute(params![folder_id, id, now])?;
            }
        }
        ImageEdit::RemoveFromFolder { folder_id } => {
            folders::ensure_folder(conn, folder_id)?;
            let mut stmt = conn.prepare_cached(
                "DELETE FROM folder_member WHERE folder_id = ?1 AND image_id = ?2",
            )?;
            for id in ids {
                stmt.execute(params![folder_id, id])?;
            }
        }
        ImageEdit::SetNote { text } => {
            let mut stmt =
                conn.prepare_cached("UPDATE image SET note_manual = ?1 WHERE id = ?2")?;
            for id in ids {
                stmt.execute(params![text, id])?;
            }
        }
        ImageEdit::RevertNote => {
            let mut stmt =
                conn.prepare_cached("UPDATE image SET note_manual = NULL WHERE id = ?1")?;
            for id in ids {
                stmt.execute([id])?;
            }
        }
        ImageEdit::Delete => {
            let mut stmt = conn.prepare_cached(
                "UPDATE image SET deleted_at = coalesce(deleted_at, ?1), eagle_initial_trash = 0
                 WHERE id = ?2",
            )?;
            let now = now_ms();
            for id in ids {
                stmt.execute(params![now, id])?;
            }
        }
        ImageEdit::Restore => {
            let mut stmt = conn.prepare_cached(
                "UPDATE image SET deleted_at = NULL, eagle_initial_trash = 0 WHERE id = ?1",
            )?;
            for id in ids {
                stmt.execute([id])?;
            }
        }
        ImageEdit::SetRating { rating } => return rating::set_manual(conn, ids, Some(*rating)),
        ImageEdit::RevertRating => return rating::set_manual(conn, ids, None),
    }
    Ok(false)
}

pub(super) fn detail(conn: &Connection, id: &str) -> Result<ImageDetail, Error> {
    let (width, height, manual_note, deleted_at, original_name, collected_at) = conn
        .query_row(
            "SELECT width, height, note_manual, deleted_at, original_name, coalesce(collected_at, imported_at) FROM image WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .optional()?
        .ok_or(Error::UnknownImage)?;
    let mut stmt = conn.prepare_cached(
        "SELECT f.id, f.name FROM folder_member m JOIN folder f ON f.id = m.folder_id
         WHERE m.image_id = ?1 ORDER BY f.name, f.id",
    )?;
    let folders = stmt
        .query_map([id], |row| {
            Ok(FolderRef {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let mut stmt = conn.prepare_cached(
        "SELECT source, note FROM image_source WHERE image_id = ?1 AND note IS NOT NULL
         ORDER BY recorded_at, source, location",
    )?;
    let sources = stmt
        .query_map([id], |row| {
            Ok(SourceNote {
                source: row.get(0)?,
                text: row.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let mut stmt = conn.prepare_cached("SELECT DISTINCT url FROM image_source WHERE image_id = ?1 AND url IS NOT NULL AND url <> '' ORDER BY url")?;
    let source_links = stmt
        .query_map([id], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(ImageDetail {
        id: id.to_owned(),
        original_name,
        collected_at,
        source_links,
        width,
        height,
        folders,
        note: ImageNote {
            manual: manual_note,
            sources,
        },
        deleted_at,
        rating: rating::rating_of(conn, id)?,
    })
}
