//! Eagle 文件夹与本库文件夹的对应。

use super::*;
use crate::CommandError;

/// 这个来源的 Eagle 文件夹在本库对应的文件夹。
pub(super) fn local_folder(
    conn: &rusqlite::Connection,
    source_id: &str,
    external_id: &str,
) -> Result<Option<String>, Error> {
    Ok(conn
        .query_row(
            "SELECT folder_id FROM eagle_folder WHERE source_id = ?1 AND external_id = ?2",
            params![source_id, external_id],
            |r| r.get(0),
        )
        .optional()?)
}

/// 这个来源上次迁入时 Eagle 资料库里的全部文件夹 id（含子文件夹）。
pub(super) fn source_folder_ids(
    conn: &rusqlite::Connection,
    source_id: &str,
) -> Result<HashSet<String>, CommandError> {
    fn collect(folders: &[Folder], out: &mut HashSet<String>) {
        for folder in folders {
            out.insert(folder.id.clone());
            collect(&folder.children, out);
        }
    }
    let raw: String = conn
        .query_row(
            "SELECT raw_library_json FROM import_source WHERE id = ?1",
            [source_id],
            |r| r.get(0),
        )
        .map_err(CommandError::system)?;
    let mut ids = HashSet::new();
    collect(&parse::<LibraryMetadata>(&raw)?.folders, &mut ids);
    Ok(ids)
}

/// Eagle 文件夹层级进本库。`old` 是上次迁入时的层级：只跟随 Eagle 自那以后的改动
/// （新建、改名、移动），画师在本库改过名或挪过的文件夹不动；Eagle 删掉的文件夹本库保留。
pub(super) fn sync_folders(
    tx: &Transaction,
    source_id: &str,
    old: Option<&LibraryMetadata>,
    new: &LibraryMetadata,
) -> Result<(), Error> {
    type Before = HashMap<String, (String, Option<String>)>;
    fn index(folders: &[Folder], parent: Option<&str>, out: &mut Before) {
        for folder in folders {
            out.insert(
                folder.id.clone(),
                (folder.name.clone(), parent.map(str::to_owned)),
            );
            index(&folder.children, Some(&folder.id), out);
        }
    }
    let mut before = Before::new();
    if let Some(old) = old {
        index(&old.folders, None, &mut before);
    }
    fn next_ord(tx: &Transaction, parent: Option<&str>) -> Result<i64, Error> {
        Ok(tx.query_row(
            "SELECT coalesce(max(ord) + 1, 0) FROM folder WHERE parent_id IS ?1",
            [parent],
            |r| r.get(0),
        )?)
    }
    /// `id` 移到 `parent` 之下会不会成环。
    fn cycle(tx: &Transaction, id: &str, parent: Option<&str>) -> Result<bool, Error> {
        let mut cursor = parent.map(str::to_owned);
        while let Some(at) = cursor {
            if at == id {
                return Ok(true);
            }
            cursor = tx
                .query_row("SELECT parent_id FROM folder WHERE id = ?1", [&at], |r| {
                    r.get(0)
                })
                .optional()?
                .flatten();
        }
        Ok(false)
    }
    fn walk(
        tx: &Transaction,
        source_id: &str,
        before: &Before,
        folders: &[Folder],
        eagle_parent: Option<&str>,
        local_parent: Option<&str>,
    ) -> Result<(), Error> {
        for folder in folders {
            let local: Option<(String, String, Option<String>)> = tx
                .query_row(
                    "SELECT f.id, f.name, f.parent_id FROM eagle_folder e JOIN folder f ON f.id = e.folder_id
                     WHERE e.source_id = ?1 AND e.external_id = ?2",
                    params![source_id, folder.id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let id = match local {
                // 上次迁入时就有、本库却没有对应：画师在本库删掉了它（#114），不建回来；
                // 它下面 Eagle 新建的文件夹放到它原来的位置。
                None if before.contains_key(&folder.id) => {
                    walk(
                        tx,
                        source_id,
                        before,
                        &folder.children,
                        Some(&folder.id),
                        local_parent,
                    )?;
                    continue;
                }
                None => {
                    let id = uuid::Uuid::now_v7().simple().to_string();
                    tx.execute(
                        "INSERT INTO folder (id, name, parent_id, ord, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![id, folder.name, local_parent, next_ord(tx, local_parent)?, now_ms()],
                    )?;
                    tx.execute(
                        "INSERT INTO eagle_folder (source_id, external_id, folder_id) VALUES (?1, ?2, ?3)",
                        params![source_id, folder.id, id],
                    )?;
                    id
                }
                Some((id, name, parent)) => {
                    if let Some((old_name, old_parent)) = before.get(&folder.id) {
                        if *old_name != folder.name && name == *old_name {
                            tx.execute(
                                "UPDATE folder SET name = ?2 WHERE id = ?1",
                                params![id, folder.name],
                            )?;
                        }
                        if old_parent.as_deref() != eagle_parent {
                            let was = match old_parent {
                                Some(p) => local_folder(tx, source_id, p)?,
                                None => None,
                            };
                            if parent == was && !cycle(tx, &id, local_parent)? {
                                tx.execute(
                                    "UPDATE folder SET parent_id = ?2, ord = ?3 WHERE id = ?1",
                                    params![id, local_parent, next_ord(tx, local_parent)?],
                                )?;
                            }
                        }
                    }
                    id
                }
            };
            walk(
                tx,
                source_id,
                before,
                &folder.children,
                Some(&folder.id),
                Some(&id),
            )?;
        }
        Ok(())
    }
    walk(tx, source_id, &before, &new.folders, None, None)
}
