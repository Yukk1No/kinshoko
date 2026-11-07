//! 文件夹（Folder）：资料库内组织参考图的层级分组。建、改名、移动在这里；
//! 放入与移出参考图走 [`super::Library::edit`]。

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
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

/// 删掉的一棵文件夹（根在前、父在子前），连同让它原样放回所需的一切。
/// 由 [`delete`] 返回、交给 [`restore`]；后端不留存，前端拿着它就是“可撤销”，丢了就不能撤销。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeletedFolders {
    folders: Vec<DeletedFolder>,
    members: Vec<DeletedMember>,
    decisions: Vec<DeletedDecision>,
    eagle: Vec<DeletedEagleLink>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeletedFolder {
    id: String,
    name: String,
    parent_id: Option<String>,
    #[ts(type = "number")]
    ord: i64,
    #[ts(type = "number")]
    created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeletedMember {
    folder_id: String,
    image_id: String,
    #[ts(type = "number")]
    added_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeletedDecision {
    folder_id: String,
    image_id: String,
    member: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeletedEagleLink {
    source_id: String,
    external_id: String,
    folder_id: String,
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

/// 删除文件夹及其子文件夹。图片不删，只去掉这些文件夹的归属；没有其他文件夹的图因此回到
/// 未归类。Eagle 文件夹的对应一并去掉：重导时 Eagle 还有、本库却没有对应的文件夹视为画师删掉的，
/// 不再建回来（见 `eagle::sync_folders`）。
///
/// 这个文件夹或它的子文件夹是正在进行的导入的保存位置时拒绝（[`Error::FolderReceivingImport`]），
/// 导入结束后再删。从核对到提交一直持有导入登记表的锁；导入在同一把锁里核对保存位置并登记
/// （[`super::Library::import_to`]），所以导入要么先登记（这里拒绝），要么等提交后看到文件夹已不在。
pub(super) fn delete(inner: &Inner, id: &str) -> Result<DeletedFolders, Error> {
    let id = id.to_owned();
    inner.write_holding(inner.import_folders.clone(), move |tx, receiving| {
        let parent: Option<String> = tx
            .query_row("SELECT parent_id FROM folder WHERE id = ?1", [&id], |row| {
                row.get(0)
            })
            .optional()?
            .ok_or(Error::UnknownFolder)?;
        const SUBTREE: &str = "WITH RECURSIVE subtree(id) AS (
                SELECT ?1 UNION ALL SELECT f.id FROM folder f JOIN subtree s ON f.parent_id = s.id
            )";
        if !receiving.is_empty() {
            let mut stmt = tx.prepare(&format!("{SUBTREE} SELECT id FROM subtree"))?;
            let subtree = stmt
                .query_map([&id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            if subtree.iter().any(|folder| receiving.contains(folder)) {
                return Err(Error::FolderReceivingImport);
            }
        }
        #[cfg(test)]
        tests::after_receiving_check(&id);
        let deleted = snapshot(tx, &id)?;
        for table in ["folder_member", "folder_decision", "eagle_folder"] {
            tx.execute(
                &format!(
                    "{SUBTREE} DELETE FROM {table} WHERE folder_id IN (SELECT id FROM subtree)"
                ),
                [&id],
            )?;
        }
        tx.execute(
            &format!("{SUBTREE} DELETE FROM folder WHERE id IN (SELECT id FROM subtree)"),
            [&id],
        )?;
        let rest = siblings(tx, parent.as_deref())?;
        renumber(tx, parent.as_deref(), &rest)?;
        Ok(deleted)
    })
}

/// 记下以 `root` 为根的整棵文件夹：每个文件夹的名称、父级、顺序，以及成员、取舍与 Eagle 对应。
fn snapshot(conn: &Connection, root: &str) -> Result<DeletedFolders, Error> {
    const SUBTREE: &str = "WITH RECURSIVE subtree(id) AS (
            SELECT ?1 UNION ALL SELECT f.id FROM folder f JOIN subtree s ON f.parent_id = s.id
        )";
    let mut all: Vec<DeletedFolder> = conn
        .prepare(&format!(
            "{SUBTREE} SELECT id, name, parent_id, ord, created_at FROM folder
             WHERE id IN (SELECT id FROM subtree)"
        ))?
        .query_map([root], |row| {
            Ok(DeletedFolder {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                ord: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    // 根在前、父在子前：放回时按这个顺序插入，外键才成立。
    let mut folders = Vec::with_capacity(all.len());
    let at = all
        .iter()
        .position(|f| f.id == root)
        .ok_or(Error::UnknownFolder)?;
    folders.push(all.swap_remove(at));
    let mut next = 0;
    while next < folders.len() {
        let parent = folders[next].id.clone();
        let (children, rest): (Vec<_>, Vec<_>) = all
            .into_iter()
            .partition(|f| f.parent_id.as_deref() == Some(parent.as_str()));
        all = rest;
        folders.extend(children);
        next += 1;
    }
    let members = conn
        .prepare(&format!(
            "{SUBTREE} SELECT folder_id, image_id, added_at FROM folder_member
             WHERE folder_id IN (SELECT id FROM subtree) ORDER BY rowid"
        ))?
        .query_map([root], |row| {
            Ok(DeletedMember {
                folder_id: row.get(0)?,
                image_id: row.get(1)?,
                added_at: row.get(2)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let decisions = conn
        .prepare(&format!(
            "{SUBTREE} SELECT folder_id, image_id, member FROM folder_decision
             WHERE folder_id IN (SELECT id FROM subtree)"
        ))?
        .query_map([root], |row| {
            Ok(DeletedDecision {
                folder_id: row.get(0)?,
                image_id: row.get(1)?,
                member: row.get::<_, i64>(2)? != 0,
            })
        })?
        .collect::<Result<_, _>>()?;
    let eagle = conn
        .prepare(&format!(
            "{SUBTREE} SELECT source_id, external_id, folder_id FROM eagle_folder
             WHERE folder_id IN (SELECT id FROM subtree)"
        ))?
        .query_map([root], |row| {
            Ok(DeletedEagleLink {
                source_id: row.get(0)?,
                external_id: row.get(1)?,
                folder_id: row.get(2)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(DeletedFolders {
        folders,
        members,
        decisions,
        eagle,
    })
}

/// 把 [`delete`] 删掉的文件夹原样放回：名称、子文件夹、成员、同级里的位置都照旧。
/// 原来的上级已经不在了就放到顶层；删除之后被永久删除的图、被去掉的导入来源不再放回。
pub(super) fn restore(inner: &Inner, deleted: DeletedFolders) -> Result<(), Error> {
    inner.write(move |tx| {
        let root = deleted.folders.first().ok_or(Error::UnknownFolder)?;
        let parent = match &root.parent_id {
            Some(p) if ensure_folder(tx, p).is_ok() => Some(p.clone()),
            _ => None,
        };
        let mut order = siblings(tx, parent.as_deref())?;
        let at = (root.ord.max(0) as usize).min(order.len());
        order.insert(at, root.id.clone());
        for (i, folder) in deleted.folders.iter().enumerate() {
            let parent_id = if i == 0 {
                parent.as_deref()
            } else {
                folder.parent_id.as_deref()
            };
            tx.execute(
                "INSERT INTO folder (id, name, parent_id, ord, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![folder.id, folder.name, parent_id, folder.ord, folder.created_at],
            )?;
        }
        renumber(tx, parent.as_deref(), &order)?;
        let exists = |sql: &str, id: &str| -> Result<bool, Error> {
            Ok(tx.query_row(sql, [id], |_| Ok(())).optional()?.is_some())
        };
        for m in &deleted.members {
            if exists("SELECT 1 FROM image WHERE id = ?1", &m.image_id)? {
                tx.execute(
                    "INSERT INTO folder_member (folder_id, image_id, added_at) VALUES (?1, ?2, ?3)",
                    params![m.folder_id, m.image_id, m.added_at],
                )?;
            }
        }
        for d in &deleted.decisions {
            if exists("SELECT 1 FROM image WHERE id = ?1", &d.image_id)? {
                tx.execute(
                    "INSERT INTO folder_decision (folder_id, image_id, member) VALUES (?1, ?2, ?3)",
                    params![d.folder_id, d.image_id, d.member as i64],
                )?;
            }
        }
        for e in &deleted.eagle {
            if exists("SELECT 1 FROM import_source WHERE id = ?1", &e.source_id)? {
                tx.execute(
                    "INSERT OR IGNORE INTO eagle_folder (source_id, external_id, folder_id) VALUES (?1, ?2, ?3)",
                    params![e.source_id, e.external_id, e.folder_id],
                )?;
            }
        }
        Ok(())
    })
}

/// 文件夹树，计数只算可见的图；`lens` 是浏览视角的过滤条件（安全模式）。
pub(super) fn tree(conn: &Connection, lens: &str) -> Result<Vec<FolderNode>, Error> {
    let mut counts = std::collections::HashMap::<String, u32>::new();
    {
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT m.folder_id, COUNT(*) FROM folder_member m
             JOIN image ON image.id = m.image_id WHERE {LIVE} AND {lens} GROUP BY m.folder_id"
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

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::mpsc;
    use std::time::Duration;

    use super::super::{ImportOptions, ImportSource, Library, SaveDestination};
    use super::Error;

    type Hook = Box<dyn FnOnce() + Send>;
    /// 删除某个文件夹、核对完“是否正在接收导入”之后要做的事（按文件夹 id，测试并行时互不影响）。
    static AFTER_CHECK: Mutex<Vec<(String, Hook)>> = Mutex::new(Vec::new());

    pub(super) fn after_receiving_check(folder: &str) {
        let hook = {
            let mut hooks = AFTER_CHECK.lock().unwrap_or_else(|e| e.into_inner());
            hooks
                .iter()
                .position(|(id, _)| id == folder)
                .map(|at| hooks.swap_remove(at).1)
        };
        if let Some(hook) = hook {
            hook();
        }
    }

    /// 删除核对完、还没提交时开始一次导入到这个文件夹：两者不能都成功。导入要么先登记（删除被拒），
    /// 要么等删除提交后再核对保存位置（导入不开始），不会出现删除成功、导入的每一项都落不进去。
    #[test]
    fn an_import_started_while_its_folder_is_being_deleted_does_not_start() {
        let dir = tempfile::tempdir().unwrap();
        let library = std::sync::Arc::new(Library::create(&dir.path().join("lib"), "库").unwrap());
        let folder = library.create_folder("手部", None).unwrap();
        let destination = SaveDestination {
            library_id: library.info().id.clone(),
            folder_id: Some(folder.clone()),
        };
        let (started_tx, started) = mpsc::channel();
        let (import_tx, import) = mpsc::channel();
        {
            let (library, destination) = (library.clone(), destination.clone());
            AFTER_CHECK.lock().unwrap().push((
                folder.clone(),
                Box::new(move || {
                    std::thread::spawn(move || {
                        let task = library.import_to(
                            ImportSource {
                                paths: vec!["不存在.png".into()],
                            },
                            ImportOptions::default(),
                            &destination,
                        );
                        let _ = started_tx.send(());
                        let _ = import_tx.send(task.map(|task| task.wait()));
                    });
                    // 导入能在删除提交前开始就让它开始；被挡住时等一会儿再提交。
                    let _ = started.recv_timeout(Duration::from_millis(500));
                }),
            ));
        }
        let deleted = library.delete_folder(&folder);
        let imported = import.recv().unwrap();
        match (&deleted, &imported) {
            (Ok(_), Err(Error::UnknownFolder)) | (Err(Error::FolderReceivingImport), Ok(_)) => {}
            other => panic!("删除与导入交错：{other:?}"),
        }
    }
}
