//! 文件夹（Folder）：资料库内组织参考图的层级分组。建、改名、移动在这里；
//! 放入与移出参考图走 [`super::Library::edit`]。

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use ts_rs::TS;

use super::{Error, Inner, LIVE, now_ms};

/// 侧栏文件夹树的一个节点。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FolderNode {
    pub id: String,
    pub name: String,
    /// 直接放在这个文件夹里、可见的参考图张数（不含子文件夹，不含回收站）。
    pub count: u32,
    pub children: Vec<FolderNode>,
}

fn valid_name(name: &str) -> Result<String, Error> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::InvalidName);
    }
    Ok(name.to_owned())
}

pub(super) fn ensure_folder(conn: &Connection, id: &str) -> Result<(), Error> {
    conn.query_row("SELECT 1 FROM folder WHERE id = ?1", [id], |_| Ok(()))
        .optional()?
        .ok_or(Error::UnknownFolder)
}

/// 同一父文件夹下的子文件夹 id，按显示顺序。
fn siblings(conn: &Connection, parent: Option<&str>) -> Result<Vec<String>, Error> {
    let mut stmt = conn.prepare_cached(
        "SELECT id FROM folder WHERE parent_id IS ?1 ORDER BY ord, created_at, id",
    )?;
    let ids = stmt
        .query_map([parent], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(ids)
}

fn renumber(conn: &Connection, parent: Option<&str>, ids: &[String]) -> Result<(), Error> {
    let mut stmt =
        conn.prepare_cached("UPDATE folder SET parent_id = ?1, ord = ?2 WHERE id = ?3")?;
    for (ord, id) in ids.iter().enumerate() {
        stmt.execute(params![parent, ord as i64, id])?;
    }
    Ok(())
}

pub(super) fn create(inner: &Inner, name: &str, parent: Option<&str>) -> Result<String, Error> {
    let name = valid_name(name)?;
    let parent = parent.map(str::to_owned);
    inner.write(move |tx| {
        if let Some(p) = &parent {
            ensure_folder(tx, p)?;
        }
        let ord = siblings(tx, parent.as_deref())?.len() as i64;
        let id = uuid::Uuid::now_v7().simple().to_string();
        tx.execute(
            "INSERT INTO folder (id, name, parent_id, ord, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name, parent, ord, now_ms()],
        )?;
        Ok(id)
    })
}

pub(super) fn rename(inner: &Inner, id: &str, name: &str) -> Result<(), Error> {
    let name = valid_name(name)?;
    let id = id.to_owned();
    inner.write(move |tx| {
        match tx.execute(
            "UPDATE folder SET name = ?1 WHERE id = ?2",
            params![name, id],
        )? {
            0 => Err(Error::UnknownFolder),
            _ => Ok(()),
        }
    })
}

pub(super) fn move_to(
    inner: &Inner,
    id: &str,
    parent: Option<&str>,
    position: u32,
) -> Result<(), Error> {
    let id = id.to_owned();
    let parent = parent.map(str::to_owned);
    inner.write(move |tx| {
        let old_parent: Option<String> = tx
            .query_row("SELECT parent_id FROM folder WHERE id = ?1", [&id], |row| {
                row.get(0)
            })
            .optional()?
            .ok_or(Error::UnknownFolder)?;
        // 新的父文件夹不能是它自己或它的子孙。
        let mut cursor = parent.clone();
        while let Some(at) = cursor {
            if at == id {
                return Err(Error::FolderCycle);
            }
            cursor = tx
                .query_row("SELECT parent_id FROM folder WHERE id = ?1", [&at], |row| {
                    row.get(0)
                })
                .optional()?
                .ok_or(Error::UnknownFolder)?;
        }

        let mut old: Vec<String> = siblings(tx, old_parent.as_deref())?;
        old.retain(|s| s != &id);
        renumber(tx, old_parent.as_deref(), &old)?;

        let mut new: Vec<String> = siblings(tx, parent.as_deref())?;
        new.retain(|s| s != &id);
        let at = (position as usize).min(new.len());
        new.insert(at, id.clone());
        renumber(tx, parent.as_deref(), &new)
    })
}

/// 文件夹树，计数只算可见的图。
pub(super) fn tree(conn: &Connection) -> Result<Vec<FolderNode>, Error> {
    let mut counts = std::collections::HashMap::<String, u32>::new();
    {
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT m.folder_id, COUNT(*) FROM folder_member m
             JOIN image ON image.id = m.image_id WHERE {LIVE} GROUP BY m.folder_id"
        ))?;
        for row in stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))? {
            let (id, n): (String, u32) = row?;
            counts.insert(id, n);
        }
    }
    let mut stmt =
        conn.prepare_cached("SELECT id, name, parent_id FROM folder ORDER BY ord, created_at, id")?;
    let rows: Vec<(String, String, Option<String>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<_, _>>()?;

    fn build(
        parent: Option<&str>,
        rows: &[(String, String, Option<String>)],
        counts: &std::collections::HashMap<String, u32>,
    ) -> Vec<FolderNode> {
        rows.iter()
            .filter(|(_, _, p)| p.as_deref() == parent)
            .map(|(id, name, _)| FolderNode {
                id: id.clone(),
                name: name.clone(),
                count: counts.get(id).copied().unwrap_or(0),
                children: build(Some(id), rows, counts),
            })
            .collect()
    }
    Ok(build(None, &rows, &counts))
}
