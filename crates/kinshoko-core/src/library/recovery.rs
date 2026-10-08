//! 打开资料库时的对账：先按 pending 撤回中断的导入项，再接受读写。
//!
//! - 每条剩下的 pending 都是没有提交的导入项：删掉它的暂存文件；它发布的原文件若没有
//!   参考图引用、内容与预期一致、且不是发布前就已存在的文件，也删掉；最后结束 pending。
//!   先删文件再删记录，对账本身中断后重来也安全。
//! - `.staging/` 里的文件都还没发布，全部清掉。
//! - 永久删除（#67）已提交、原文件还没清除的，接着清除。
//! - `originals/` 里没有参考图引用的其他文件只报告，不删除。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};

use super::import::{Pending, sha256_hex};
use super::types::RecoveryReport;
use super::{Error, ORIGINALS_DIR, STAGING_DIR};

pub(super) fn reconcile(conn: &mut Connection, root: &Path) -> Result<RecoveryReport, Error> {
    let pending = {
        let mut stmt = conn.prepare(
            "SELECT id, sha256, size, staging_path, rel_path, target_existed, location
             FROM import_pending ORDER BY created_at, rowid",
        )?;
        stmt.query_map([], |row| {
            Ok(Pending {
                id: row.get(0)?,
                sha: row.get(1)?,
                size: row.get(2)?,
                staging_path: row.get(3)?,
                rel_path: row.get(4)?,
                target_existed: row.get(5)?,
                location: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?
    };

    let mut report = RecoveryReport::default();
    for p in &pending {
        undo(conn, root, p)?;
        report.interrupted.push(PathBuf::from(&p.location));
    }

    if let Ok(entries) = std::fs::read_dir(root.join(STAGING_DIR)) {
        for entry in entries.flatten() {
            let path = entry.path();
            let removed = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            if removed.is_ok() {
                report.discarded_staging += 1;
            }
        }
    }

    // 永久删除提交后没来得及清除的原文件，接着清。
    for sha in super::permanent_delete::clear_removals(conn, root)? {
        super::thumbnail::remove_for(root, &sha);
    }

    report.orphans = orphans(conn, root)?;
    Ok(report)
}

/// 撤回一个未提交的导入项。
pub(super) fn undo(conn: &mut Connection, root: &Path, p: &Pending) -> rusqlite::Result<()> {
    let _ = std::fs::remove_file(root.join(&p.staging_path));
    if !p.target_existed {
        let referenced = conn
            .query_row(
                "SELECT 1 FROM image WHERE rel_path = ?1",
                [&p.rel_path],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        let target = root.join(&p.rel_path);
        let ours = std::fs::read(&target)
            .map(|bytes| bytes.len() as i64 == p.size && sha256_hex(&bytes) == p.sha)
            .unwrap_or(false);
        if !referenced && ours {
            let _ = std::fs::remove_file(&target);
        }
    }
    conn.execute("DELETE FROM import_pending WHERE id = ?1", params![p.id])?;
    Ok(())
}

/// `originals/` 下没有参考图引用的文件，相对资料库根目录。
fn orphans(conn: &Connection, root: &Path) -> Result<Vec<PathBuf>, Error> {
    let known: HashSet<PathBuf> = {
        let mut stmt = conn.prepare("SELECT rel_path FROM image")?;
        stmt.query_map([], |row| row.get::<_, String>(0))?
            .map(|r| r.map(|p| normalize(Path::new(&p))))
            .collect::<Result<_, _>>()?
    };
    let mut found = Vec::new();
    let mut stack = vec![PathBuf::from(ORIGINALS_DIR)];
    while let Some(rel) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(root.join(&rel)) else {
            continue;
        };
        for entry in entries.flatten() {
            let child = rel.join(entry.file_name());
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                stack.push(child);
            } else if !known.contains(&normalize(&child)) {
                found.push(child);
            }
        }
    }
    found.sort();
    Ok(found)
}

/// 统一分隔符，便于比较数据库里以 `/` 记录的相对路径。
fn normalize(path: &Path) -> PathBuf {
    path.components().collect()
}
