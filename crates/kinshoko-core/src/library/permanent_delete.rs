//! 永久删除（#67，#42“永久删除两步”）：只删回收站里的图。
//!
//! 1. 预览：核对每张图都在回收站里，经参考组用途 port（[`ReferenceGroupUsage`]）查出用到它们的
//!    参考组，给出令牌。令牌绑定资料库、图片集合、回收站修订号、安全模式与受影响的参考组。
//! 2. 执行：重新查参考组、在写事务里重新算令牌，不一致就拒绝（[`Error::DeletePreviewStale`]），
//!    要求重新预览。参考组读不懂时无法核对，预览与执行都报错，不跳过。
//!
//! 执行时在同一个事务里删掉参考图记录及其全部整理结果，并记下待清除的原文件；提交后删除
//! 原文件与缩略图，再删记录。提交后崩溃时，下次打开资料库接着清（见 `recovery.rs`）。
//! 参考组文件不改：成员与布局都保留，核对时这张图显示为“已从资料库中删除”。

use std::path::Path;
use std::sync::OnceLock;

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use ts_rs::TS;

use super::{Error, Inner, LibraryEvent, fault, lens, tags, thumbnail};
use crate::reference_groups::{GroupUsage, ReferenceGroupUsage};

/// 永久删除预览：将删除的图、受影响的参考组和执行时要交回的令牌。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PermanentDeletePreview {
    /// 将永久删除的参考图（去重，按给出的先后）。
    pub image_ids: Vec<String>,
    /// 用到这些图的参考组；为空时直接确认。
    pub groups: Vec<GroupUsage>,
    /// 执行永久删除时交回；回收站、受影响的参考组或安全模式变化后失效。
    pub token: String,
}

fn unique(ids: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    ids.iter().filter(|id| seen.insert(*id)).cloned().collect()
}

/// 浏览视角下这张图存在且在回收站里。
fn require_in_trash(conn: &Connection, lens: &str, image_id: &str) -> Result<(), Error> {
    lens::require_visible(conn, lens, image_id)?;
    let trashed: bool = conn.query_row(
        "SELECT deleted_at IS NOT NULL FROM image WHERE id = ?1",
        [image_id],
        |r| r.get(0),
    )?;
    if trashed {
        Ok(())
    } else {
        Err(Error::NotInTrash)
    }
}

fn trash_revision(conn: &Connection) -> Result<i64, Error> {
    Ok(conn.query_row("SELECT value FROM trash_revision", [], |r| r.get(0))?)
}

/// 进程内的随机盐：令牌只在这次运行内有效，不能凭内容拼出来。
fn salt() -> &'static str {
    static SALT: OnceLock<String> = OnceLock::new();
    SALT.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}

struct Bound<'a> {
    library_id: &'a str,
    image_ids: &'a [String],
    trash_revision: i64,
    safe_mode: bool,
    groups: &'a [GroupUsage],
}

impl Bound<'_> {
    fn token(&self) -> String {
        let mut ids = self.image_ids.to_vec();
        ids.sort();
        let mut h = Sha256::new();
        for part in [salt(), self.library_id] {
            h.update(part.as_bytes());
            h.update([0]);
        }
        for id in &ids {
            h.update(id.as_bytes());
            h.update([0]);
        }
        h.update(self.trash_revision.to_le_bytes());
        h.update([u8::from(self.safe_mode)]);
        h.update(serde_json::to_vec(self.groups).unwrap_or_default());
        format!("{:x}", h.finalize())
    }
}

fn groups_using(
    inner: &Inner,
    ids: &[String],
    usage: &dyn ReferenceGroupUsage,
) -> Result<Vec<GroupUsage>, Error> {
    usage
        .groups_using(&inner.info.id, ids)
        .map_err(|e| Error::ReferenceGroups(e.to_string()))
}

pub(super) fn preview(
    inner: &Inner,
    ids: &[String],
    usage: &dyn ReferenceGroupUsage,
) -> Result<PermanentDeletePreview, Error> {
    let ids = unique(ids);
    let lens = inner.lens_filter();
    let safe_mode = inner.safe_mode();
    let revision = {
        let mut conn = inner.readers.get();
        let tx = conn.transaction()?;
        for id in &ids {
            require_in_trash(&tx, &lens, id)?;
        }
        trash_revision(&tx)?
    };
    let groups = groups_using(inner, &ids, usage)?;
    let token = Bound {
        library_id: &inner.info.id,
        image_ids: &ids,
        trash_revision: revision,
        safe_mode,
        groups: &groups,
    }
    .token();
    Ok(PermanentDeletePreview {
        image_ids: ids,
        groups,
        token,
    })
}

pub(super) fn execute(
    inner: &Inner,
    ids: &[String],
    token: &str,
    usage: &dyn ReferenceGroupUsage,
) -> Result<(), Error> {
    let ids = unique(ids);
    let groups = groups_using(inner, &ids, usage)?;
    let lens = inner.lens_filter();
    let safe_mode = inner.safe_mode();
    let library_id = inner.info.id.clone();
    let token = token.to_owned();
    let deleted = ids.clone();
    let revision = inner.write(move |tx| {
        let expected = Bound {
            library_id: &library_id,
            image_ids: &deleted,
            trash_revision: trash_revision(tx)?,
            safe_mode,
            groups: &groups,
        }
        .token();
        if expected != token {
            return Err(Error::DeletePreviewStale);
        }
        for id in &deleted {
            require_in_trash(tx, &lens, id)?;
        }
        for id in &deleted {
            remove_image(tx, id)?;
        }
        tags::bump_revision(tx)
    })?;
    fault::hit(fault::PERMANENT_DELETE_AFTER_COMMIT);
    let root = inner.root.clone();
    let removed = inner.writer.run(move |conn| clear_removals(conn, &root))?;
    for sha in removed {
        thumbnail::remove_for(&inner.root, &sha);
    }
    let library_id = inner.info.id.clone();
    inner.hub.publish(LibraryEvent::ImagesChanged {
        library_id: library_id.clone(),
        image_ids: ids,
    });
    inner.hub.publish(LibraryEvent::VocabularyChanged {
        library_id,
        revision,
    });
    Ok(())
}

/// 删掉一张参考图的记录及其全部整理结果，记下待清除的原文件。
fn remove_image(tx: &Transaction, id: &str) -> Result<(), Error> {
    let (rel_path, sha): (String, String) = tx
        .query_row(
            "SELECT rel_path, sha256 FROM image WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or(Error::UnknownImage)?;
    // 内容版本的删除决定与参考图、来源绑定的删除一起提交，不能留下已删但可重导的窗口。
    tx.execute(
        "INSERT INTO eagle_deleted_content (sha256, deleted_at) VALUES (?1, ?2)
         ON CONFLICT(sha256) DO UPDATE SET deleted_at = excluded.deleted_at",
        params![sha, super::now_ms()],
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO original_removal (rel_path, sha256) VALUES (?1, ?2)",
        params![rel_path, sha],
    )?;
    for sql in [
        "DELETE FROM region_note WHERE (source_id, external_id, sha256) IN
             (SELECT source_id, external_id, sha256 FROM source_binding WHERE image_id = ?1)",
        "DELETE FROM source_binding WHERE image_id = ?1",
        "DELETE FROM image_source WHERE image_id = ?1",
        "DELETE FROM image_colour WHERE image_id = ?1",
        "DELETE FROM folder_member WHERE image_id = ?1",
        "DELETE FROM folder_decision WHERE image_id = ?1",
        "DELETE FROM rating_fact WHERE image_id = ?1",
        "DELETE FROM tagging_state WHERE image_id = ?1",
        "DELETE FROM tag_fact WHERE image_id = ?1",
        "DELETE FROM tag_decision WHERE image_id = ?1",
        // 新版本不再指向被删的旧版本。
        "UPDATE image SET previous_image_id = NULL WHERE previous_image_id = ?1",
        "DELETE FROM image WHERE id = ?1",
    ] {
        tx.prepare_cached(sql)?.execute([id])?;
    }
    Ok(())
}

/// 清除记下的原文件，返回已清除的 SHA-256（供删除缩略图）。文件又被参考图或进行中的导入
/// 使用时保留文件；活图引用会取消清除，只有导入 pending 时留待撤回后清除。
pub(super) fn clear_removals(conn: &Connection, root: &Path) -> Result<Vec<String>, Error> {
    // 有备份正在复制这个资料库（原文件租约，#69）：一个也不清，留到之后的永久删除或下次打开。
    let library_id: String = conn.query_row("SELECT id FROM library", [], |r| r.get(0))?;
    if super::backup::leased(&library_id) {
        return Ok(Vec::new());
    }
    let pending: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT rel_path, sha256 FROM original_removal")?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?
    };
    let mut removed = Vec::new();
    for (rel_path, sha) in pending {
        let (image_uses, import_uses): (bool, bool) = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM image WHERE rel_path = ?1),
                    EXISTS (SELECT 1 FROM import_pending WHERE rel_path = ?1)",
            [&rel_path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        // pending 只暂时保护文件，不能取消永久删除：导入撤回后还要继续清除。
        if !image_uses && import_uses {
            continue;
        }
        if !image_uses {
            match std::fs::remove_file(root.join(&rel_path)) {
                Ok(()) => removed.push(sha),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => removed.push(sha),
                Err(_) => continue,
            }
        }
        conn.execute(
            "DELETE FROM original_removal WHERE rel_path = ?1",
            [&rel_path],
        )?;
    }
    Ok(removed)
}
