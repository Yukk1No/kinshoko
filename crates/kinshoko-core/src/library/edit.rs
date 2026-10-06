//! 整理参考图：一次批量编辑若干张图，返回重新计算后的详情（#42 `edit(ids, 编辑列表)`）；
//! 以及查看单张时的详情 `image(id)`。

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{Error, Inner, folders, now_ms};

/// 对参考图的一项编辑。一次 `edit` 把编辑列表按顺序用在每张图上，全部成功才提交。
///
/// 新的编辑种类（例如标签决定、分级）在这里加变体，并在 [`apply`] 里处理。
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
}

/// 参考图所在的一个文件夹。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FolderRef {
    pub id: String,
    pub name: String,
}

/// 查看单张参考图所需的详情。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageDetail {
    pub id: String,
    pub width: u32,
    pub height: u32,
    /// 所在的文件夹，按名称排序。
    pub folders: Vec<FolderRef>,
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
    inner.write(move |tx| {
        for id in &ids {
            ensure_image(tx, id)?;
        }
        for edit in &edits {
            apply(tx, &ids, edit)?;
        }
        ids.iter().map(|id| detail(tx, id)).collect()
    })
}

fn ensure_image(conn: &Connection, id: &str) -> Result<(), Error> {
    conn.query_row("SELECT 1 FROM image WHERE id = ?1", [id], |_| Ok(()))
        .optional()?
        .ok_or(Error::UnknownImage)
}

fn apply(conn: &Connection, ids: &[String], edit: &ImageEdit) -> Result<(), Error> {
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
            let mut stmt = conn
                .prepare_cached("DELETE FROM folder_member WHERE folder_id = ?1 AND image_id = ?2")?;
            for id in ids {
                stmt.execute(params![folder_id, id])?;
            }
        }
    }
    Ok(())
}

pub(super) fn detail(conn: &Connection, id: &str) -> Result<ImageDetail, Error> {
    let (width, height) = conn
        .query_row(
            "SELECT width, height FROM image WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
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
    Ok(ImageDetail {
        id: id.to_owned(),
        width,
        height,
        folders,
    })
}
