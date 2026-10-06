//! 侧栏：全部、回收站与文件夹树，计数都按可见的图计算。

use serde::Serialize;
use ts_rs::TS;

use super::folders::{self, FolderNode};
use super::{Error, Inner, LIVE};

/// 侧栏所需的一切。标签分组随标签切片加入。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Sidebar {
    /// “全部”里的张数（不含回收站）。
    pub all: u32,
    /// 回收站里的张数。
    pub trash: u32,
    pub folders: Vec<FolderNode>,
}

pub(super) fn get(inner: &Inner) -> Result<Sidebar, Error> {
    let conn = inner.readers.get();
    let all = conn.query_row(
        &format!("SELECT COUNT(*) FROM image WHERE {LIVE}"),
        [],
        |r| r.get(0),
    )?;
    let trash = conn.query_row(
        &format!("SELECT COUNT(*) FROM image WHERE NOT ({LIVE})"),
        [],
        |r| r.get(0),
    )?;
    Ok(Sidebar {
        all,
        trash,
        folders: folders::tree(&conn)?,
    })
}
