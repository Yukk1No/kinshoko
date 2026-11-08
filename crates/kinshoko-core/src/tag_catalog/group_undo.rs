//! 撤销删除标签分组（#479）。
use super::*;

/// 删掉的一个标签分组，连同让它原样放回所需的一切：名称、在分组栏里的位置、成员及顺序，
/// 以及它由哪些资料库的旧分组迁入。由 [`TagCatalog::delete_group`] 返回、交给
/// [`TagCatalog::restore_group`]；目录里不留存，前端拿着它就是“可撤销”，丢了就不能撤销。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeletedCatalogGroup {
    id: String,
    name: String,
    namespace: Option<TagNamespace>,
    /// 删除前在分组栏里排第几（从 0 数）。
    #[ts(type = "number")]
    position: usize,
    members: Vec<String>,
    /// 迁入这个分组的资料库旧分组（资料库 id，旧分组 id）。
    migrated_from: Vec<(String, String)>,
}

impl TagCatalog {
    /// 删除一个分组（分组只是标签的分类，不改图片标签），返回让它能原样放回的内容。
    /// 预置记录（`catalog_preset`）不动：删掉的预置分组不会被加回，撤销也不会让它被预置第二次。
    pub fn delete_group(&mut self, group_id: &str) -> Result<DeletedCatalogGroup, CatalogError> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let (name, namespace) = tx
            .query_row(
                "SELECT name,namespace FROM catalog_group WHERE id=?1",
                [group_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
            )
            .optional()?
            .ok_or(CatalogError::UnknownGroup)?;
        let namespace = namespace.map(|ns| serde_json::from_str(&ns)).transpose()?;
        let position = tx.query_row(
            "SELECT count(*) FROM catalog_group WHERE (ord,id) < (SELECT ord,id FROM catalog_group WHERE id=?1)",
            [group_id],
            |r| r.get::<_, i64>(0),
        )? as usize;
        let members = tx
            .prepare("SELECT catalog_id FROM catalog_group_member WHERE group_id=?1 ORDER BY ord,catalog_id")?
            .query_map([group_id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let migrated_from = tx
            .prepare("SELECT library_id,group_id FROM catalog_group_migration WHERE target=?1 ORDER BY library_id,group_id")?
            .query_map([group_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        tx.execute("DELETE FROM catalog_group WHERE id=?1", [group_id])?;
        tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        tx.commit()?;
        Ok(DeletedCatalogGroup {
            id: group_id.to_owned(),
            name,
            namespace,
            position,
            members,
            migrated_from,
        })
    }

    /// 撤销 [`TagCatalog::delete_group`]：名称、位置、成员及顺序放回原样，迁入记录重新指向它
    /// （否则会被当成“画师删掉了迁入的分组”）。删除之后已不存在的标签不再放回；
    /// 分组已经在时什么也不做。
    pub fn restore_group(&mut self, deleted: DeletedCatalogGroup) -> Result<(), CatalogError> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let exists = tx
            .query_row(
                "SELECT 1 FROM catalog_group WHERE id=?1",
                [&deleted.id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if exists {
            return Ok(());
        }
        let mut order = tx
            .prepare("SELECT id FROM catalog_group ORDER BY ord,id")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        order.insert(deleted.position.min(order.len()), deleted.id.clone());
        let namespace = deleted
            .namespace
            .map(|ns| serde_json::to_string(&ns))
            .transpose()?;
        tx.execute(
            "INSERT INTO catalog_group(id,name,namespace,ord) VALUES (?1,?2,?3,?4)",
            params![deleted.id, deleted.name, namespace, order.len() as i64],
        )?;
        for (ord, id) in order.iter().enumerate() {
            tx.execute(
                "UPDATE catalog_group SET ord=?2 WHERE id=?1",
                params![id, ord as i64],
            )?;
        }
        let mut ord = 0i64;
        for member in &deleted.members {
            let known = tx
                .query_row(
                    "SELECT 1 FROM catalog_tag WHERE id=?1",
                    [member],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if known {
                tx.execute(
                    "INSERT OR IGNORE INTO catalog_group_member(group_id,catalog_id,ord) VALUES (?1,?2,?3)",
                    params![deleted.id, member, ord],
                )?;
                ord += 1;
            }
        }
        for (library_id, group_id) in &deleted.migrated_from {
            tx.execute(
                "UPDATE catalog_group_migration SET target=?3 WHERE library_id=?1 AND group_id=?2 AND target IS NULL",
                params![library_id, group_id, deleted.id],
            )?;
        }
        tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        tx.commit()?;
        Ok(())
    }
}
