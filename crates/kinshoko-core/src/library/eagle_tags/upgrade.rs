//! beta1 资料库的 Eagle 标签名称升级（#217）。

use super::*;

/// 迁移钩子：beta1 把 Eagle 原文记成了简体中文名称（#217）。来自 Eagle 的标签，名称与某个 Eagle
/// 原文完全相同的改为来源名称，再按随软件分发的词表重判、重新匹配；名称不同的视为画师改过，
/// 不动（名称来源待处理，交给 #182）。
pub(in crate::library) fn upgrade_source_names(tx: &Transaction) -> rusqlite_migration::HookResult {
    upgrade(tx).map_err(|e| rusqlite_migration::HookError::Hook(e.to_string()))
}

pub(super) fn upgrade(tx: &Transaction) -> Result<(), Error> {
    let eagle = eagle_tag_ids(tx)?;
    if eagle.is_empty() {
        return Ok(());
    }
    let mut originals = HashSet::new();
    {
        let mut stmt = tx.prepare("SELECT raw_item_json FROM source_binding")?;
        for raw in stmt.query_map([], |r| r.get::<_, String>(0))? {
            let raw = raw?;
            let item: serde_json::Value =
                serde_json::from_str(raw.trim_start_matches('\u{feff}')).unwrap_or_default();
            for tag in item["tags"].as_array().into_iter().flatten() {
                if let Some(tag) = tag.as_str() {
                    originals.insert(tag.trim().to_owned());
                }
            }
        }
    }
    let named: Vec<(String, String, String)> = {
        let mut stmt = tx.prepare(
            "SELECT n.tag_id, n.lang, n.name FROM tag_name n JOIN tag t ON t.id = n.tag_id
             WHERE t.namespace = 'general'
               AND EXISTS (SELECT 1 FROM tag_fact f WHERE f.tag_id = n.tag_id AND f.source LIKE 'eagle:%')",
        )?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?
    };
    for (tag_id, lang, name) in named {
        if !originals.contains(&name) {
            continue;
        }
        tx.execute(
            "DELETE FROM tag_name WHERE tag_id = ?1 AND lang = ?2",
            params![tag_id, lang],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO tag_source_name (tag_id, name, lang, source) VALUES (?1, ?2, ?3, ?4)",
            params![
                tag_id,
                name,
                source_names::detect_lang(&name, source_names::INTERFACE_LANG),
                source_names::EAGLE
            ],
        )?;
    }
    let vocabulary = ExternalVocabulary::new(
        ExternalVocabulary::builtin_names(&BuiltinApproxTable::bundled()),
        &TagTranslations::bundled(),
    );
    let mut changed = Vec::new();
    for tag_id in eagle {
        // 并入别的标签后就不在了。
        let exists: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM tag WHERE id = ?1)",
            [&tag_id],
            |r| r.get(0),
        )?;
        if !exists {
            continue;
        }
        let external: Option<String> = tx
            .query_row(
                "SELECT name FROM tag_external WHERE tag_id = ?1 ORDER BY name LIMIT 1",
                [&tag_id],
                |r| r.get(0),
            )
            .optional()?;
        match external {
            Some(external) => settle(tx, &vocabulary, &tag_id, &external)?,
            None => {
                match_tag(tx, &vocabulary, &tag_id, &mut changed)?;
            }
        }
    }
    tx.execute("UPDATE vocabulary_revision SET value = value + 1", [])?;
    Ok(())
}
