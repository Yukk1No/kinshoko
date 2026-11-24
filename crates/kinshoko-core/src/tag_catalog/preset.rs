//! 预置标签分组（#484）。
use super::*;

/// 预置分组的成员（外部名称，Danbooru 词表）：发色、瞳色里最常用的纯色。随软件发布，
/// 不依赖自动标签有没有装好；名称由内置翻译表提供默认名称。
const PRESET_HAIR: &[&str] = &[
    "black_hair",
    "brown_hair",
    "blonde_hair",
    "orange_hair",
    "red_hair",
    "pink_hair",
    "purple_hair",
    "blue_hair",
    "aqua_hair",
    "green_hair",
    "grey_hair",
    "white_hair",
    "multicolored_hair",
];
const PRESET_EYES: &[&str] = &[
    "black_eyes",
    "brown_eyes",
    "orange_eyes",
    "red_eyes",
    "pink_eyes",
    "purple_eyes",
    "blue_eyes",
    "aqua_eyes",
    "green_eyes",
    "yellow_eyes",
    "grey_eyes",
    "white_eyes",
    "multicolored_eyes",
];
const PRESET_KEY: &str = "groups-v1";

/// 预置分组的成员标签（外部名称）：没有资料库带它们时，界面也要列出。
pub(crate) fn is_preset_member(external: &str) -> bool {
    PRESET_HAIR.contains(&external) || PRESET_EYES.contains(&external)
}

impl TagCatalog {
    /// 全局还没有任何分组时，只预置一次“发色”“瞳色”（#484）。画师删掉后不再加回；已经有过分组
    /// （含迁入后又删掉的）的用户只记下“已预置”，不增加分组。`local_groups_pending` 为真表示
    /// 资料库里还有旧分组，这时不决定，等迁完再说。
    pub fn ensure_preset_groups(&mut self, local_groups_pending: bool) -> Result<(), CatalogError> {
        let done = self
            .conn
            .query_row(
                "SELECT 1 FROM catalog_preset WHERE key=?1",
                [PRESET_KEY],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if done {
            return Ok(());
        }
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let used: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM catalog_group) OR EXISTS(SELECT 1 FROM catalog_group_migration)",
            [],
            |r| r.get(0),
        )?;
        if !used {
            if local_groups_pending {
                return Ok(());
            }
            let names = crate::written_names::preset_group_names(crate::interface_lang::current());
            let ns = serde_json::to_string(&TagNamespace::General)?;
            for (name, members) in names.into_iter().zip([PRESET_HAIR, PRESET_EYES]) {
                let id = uuid::Uuid::now_v7().simple().to_string();
                tx.execute("INSERT INTO catalog_group(id,name,namespace,ord) VALUES (?1,?2,NULL,(SELECT coalesce(max(ord),-1)+1 FROM catalog_group))", params![id, name])?;
                for (ord, external) in members.iter().enumerate() {
                    let existing = tx
                        .query_row("SELECT catalog_id FROM catalog_external WHERE namespace=?1 AND vocabulary='danbooru' AND name=?2", params![ns, external], |r| r.get::<_, String>(0))
                        .optional()?;
                    let tag = match existing {
                        Some(tag) => tag,
                        None => super::insert_tag(
                            &tx,
                            &crate::library::VocabularyTag {
                                id: String::new(),
                                namespace: TagNamespace::General,
                                names: Vec::new(),
                                aliases: Vec::new(),
                                external: vec![(*external).to_owned()],
                                count: 0,
                                source_names: Vec::new(),
                            },
                        )?,
                    };
                    tx.execute("INSERT OR IGNORE INTO catalog_group_member(group_id,catalog_id,ord) VALUES (?1,?2,?3)", params![id, tag, ord as i64])?;
                }
            }
            tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        }
        tx.execute(
            "INSERT OR IGNORE INTO catalog_preset(key) VALUES (?1)",
            [PRESET_KEY],
        )?;
        tx.commit()?;
        if !used && let Some(table) = self.name_defaults.clone() {
            self.update_name_defaults(&table)?;
        }
        Ok(())
    }
}
