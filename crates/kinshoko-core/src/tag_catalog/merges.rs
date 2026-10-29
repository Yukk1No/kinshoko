//! 库内两个标签并成一个之后（#217），把并掉的标签在统一标签目录里的状态接到留下的标签上。

use super::*;

/// `merges` 是本库并掉的标签与它并入的标签。旧对应还在、两边已是不同的统一标签时：
/// 旧统一标签不再被别的映射使用，就把名称偏好、分组、近似对应与删掉的别名移给新统一标签；
/// 然后删掉旧对应。新标签还没同步进目录时留到下次。
pub(super) fn follow(
    tx: &rusqlite::Transaction,
    library_id: &str,
    merges: &[(String, String)],
) -> Result<bool, CatalogError> {
    let mapped = |local: &str| {
        tx.query_row(
            "SELECT catalog_id FROM library_tag_mapping WHERE library_id=?1 AND local_tag_id=?2",
            params![library_id, local],
            |row| row.get::<_, String>(0),
        )
        .optional()
    };
    let mut changed = false;
    for (from, to) in merges {
        let (Some(old), Some(new)) = (mapped(from)?, mapped(to)?) else {
            continue;
        };
        for sql in [
            "DELETE FROM library_tag_mapping WHERE library_id=?1 AND local_tag_id=?2",
            "DELETE FROM library_tag_source_name WHERE library_id=?1 AND local_tag_id=?2",
            "DELETE FROM catalog_legacy_name_confirmation WHERE library_id=?1 AND local_tag_id=?2",
        ] {
            tx.execute(sql, params![library_id, from])?;
        }
        changed = true;
        let shared = tx
            .query_row(
                "SELECT 1 FROM library_tag_mapping WHERE catalog_id=?1",
                [&old],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if old == new || shared {
            continue;
        }
        for sql in [
            // 两边都有的以留下的标签为准。
            "INSERT OR IGNORE INTO catalog_name_preference (catalog_id,lang,name)
             SELECT ?2,lang,name FROM catalog_name_preference WHERE catalog_id=?1",
            "INSERT OR IGNORE INTO catalog_group_member (group_id,catalog_id,ord)
             SELECT group_id,?2,ord FROM catalog_group_member WHERE catalog_id=?1",
            "INSERT OR IGNORE INTO catalog_removed_alias (catalog_id,name,lang)
             SELECT ?2,name,lang FROM catalog_removed_alias WHERE catalog_id=?1",
            "INSERT OR IGNORE INTO catalog_approx (a,b,relation,explicit,ord)
             SELECT CASE a WHEN ?1 THEN ?2 ELSE a END, CASE b WHEN ?1 THEN ?2 ELSE b END,
                    relation,explicit,ord
             FROM catalog_approx WHERE (a=?1 AND b<>?2) OR (b=?1 AND a<>?2)",
            "UPDATE catalog_approx_migration SET a=?2 WHERE a=?1",
            "UPDATE catalog_approx_migration SET b=?2 WHERE b=?1",
        ] {
            tx.execute(sql, params![old, new])?;
        }
        for sql in [
            "DELETE FROM catalog_name_preference WHERE catalog_id=?1",
            "DELETE FROM catalog_group_member WHERE catalog_id=?1",
            "DELETE FROM catalog_removed_alias WHERE catalog_id=?1",
            "DELETE FROM catalog_approx WHERE a=?1 OR b=?1",
        ] {
            tx.execute(sql, [&old])?;
        }
    }
    Ok(changed)
}
