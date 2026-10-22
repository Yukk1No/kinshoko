//! 标签的名称、来源名称、别名与外部对应。

use super::*;

/// 命名空间内名称或来源名称（任一语言）为 `name` 的标签；没有时看别名。
pub(in crate::library) fn find_named(
    tx: &Transaction,
    namespace: TagNamespace,
    name: &str,
) -> Result<Option<String>, Error> {
    for sql in [
        "SELECT t.id FROM tag t JOIN tag_name n ON n.tag_id = t.id
         WHERE t.namespace = ?1 AND n.name = ?2
         UNION SELECT t.id FROM tag t JOIN tag_source_name s ON s.tag_id = t.id
         WHERE t.namespace = ?1 AND s.name = ?2",
        "SELECT DISTINCT t.id FROM tag t JOIN tag_alias a ON a.tag_id = t.id
         WHERE t.namespace = ?1 AND a.name = ?2",
    ] {
        let mut stmt = tx.prepare_cached(sql)?;
        let ids = stmt
            .query_map(params![namespace.as_str(), name], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        match ids.len() {
            0 => continue,
            1 => return Ok(ids.into_iter().next()),
            _ => return Err(Error::AmbiguousTag(name.to_owned())),
        }
    }
    Ok(None)
}

/// 本命名空间里除 `tag_id` 以外的标签是否已用 `text` 作名称、来源名称或别名。
pub(in crate::library) fn text_taken(
    tx: &Transaction,
    namespace: TagNamespace,
    tag_id: &str,
    text: &str,
) -> Result<bool, Error> {
    Ok(tx
        .query_row(
            "SELECT 1 FROM tag t WHERE t.namespace = ?1 AND t.id <> ?2 AND (
                 EXISTS (SELECT 1 FROM tag_name n WHERE n.tag_id = t.id AND n.name = ?3)
                 OR EXISTS (SELECT 1 FROM tag_source_name s WHERE s.tag_id = t.id AND s.name = ?3)
                 OR EXISTS (SELECT 1 FROM tag_alias a WHERE a.tag_id = t.id AND a.name = ?3))",
            params![namespace.as_str(), tag_id, text],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// 标签的首次初始化：按翻译表写入各语言名称与别名。已有的名称、别名不动；与本命名空间
/// 其他标签的名称或别名相同的跳过（否则画师输入它时对不上唯一的标签），留给画师处理。
/// 返回是否写入了任何内容。
pub(in crate::library) fn initialise_names(
    tx: &Transaction,
    namespace: TagNamespace,
    tag_id: &str,
    translation: &TagTranslation,
) -> Result<bool, Error> {
    let mut changed = false;
    for (lang, name) in &translation.names {
        if text_taken(tx, namespace, tag_id, name)? {
            continue;
        }
        changed |= tx.execute(
            "INSERT OR IGNORE INTO tag_name (tag_id, lang, name) VALUES (?1, ?2, ?3)",
            params![tag_id, lang, name],
        )? > 0;
    }
    for alias in &translation.aliases {
        if text_taken(tx, namespace, tag_id, &alias.name)? {
            continue;
        }
        changed |= tx.execute(
            "INSERT OR IGNORE INTO tag_alias (tag_id, name, lang) VALUES (?1, ?2, ?3)",
            params![tag_id, alias.name, alias.lang],
        )? > 0;
    }
    Ok(changed)
}

/// 装上（或更新）翻译表：仍尚未翻译（没有任何语言名称）的标签按表做首次初始化（ADR-0003）。
/// 已有名称的标签——不论名称来自旧表还是画师——不动，人工标签决定也不碰。
/// 有改动时词表修订号加一并推送事件。
pub(in crate::library) fn apply_translations(inner: &Inner) -> Result<(), Error> {
    let translations = inner.translations();
    if translations.is_empty() {
        return Ok(());
    }
    let revision = inner.writer.run(move |conn| {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let pending: Vec<(String, String, String)> = {
            let mut stmt = tx.prepare(
                "SELECT t.id, t.namespace, e.name FROM tag t JOIN tag_external e ON e.tag_id = t.id
                 WHERE NOT EXISTS (SELECT 1 FROM tag_name n WHERE n.tag_id = t.id)
                 ORDER BY t.id, e.name",
            )?;
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<_, _>>()?
        };
        let mut changed = false;
        let mut done = std::collections::HashSet::new();
        for (tag_id, namespace, external) in pending {
            let Some(translation) = translations.get(&external) else {
                continue;
            };
            // 一个标签有多个外部对应时，按名称序第一个有翻译的为准。
            if !done.insert(tag_id.clone()) {
                continue;
            }
            let namespace = TagNamespace::parse(&namespace)?;
            changed |= initialise_names(&tx, namespace, &tag_id, translation)?;
        }
        if !changed {
            return Ok::<_, Error>(None);
        }
        let revision = bump_revision(&tx)?;
        tx.commit()?;
        Ok(Some(revision))
    })?;
    if let Some(revision) = revision {
        inner.hub.publish(LibraryEvent::VocabularyChanged {
            library_id: inner.info.id.clone(),
            revision,
        });
    }
    Ok(())
}

/// 导入来源的标签原文（#217）：按名称、来源名称或别名找标签；没有时新建，原文按文字判断语言后
/// 记为本库的来源名称。已有的来源名称不动，画师改过的语言保留。
pub(in crate::library) fn resolve_source_named(
    tx: &Transaction,
    namespace: TagNamespace,
    name: &str,
) -> Result<String, Error> {
    let name = clean(name)?;
    if let Some(id) = find_named(tx, namespace, &name)? {
        return Ok(id);
    }
    let id = new_tag(tx, namespace)?;
    crate::library::source_names::insert(
        tx,
        &id,
        &name,
        &crate::library::source_names::detect_lang(
            &name,
            crate::library::source_names::INTERFACE_LANG,
        ),
        crate::library::source_names::EAGLE,
    )?;
    Ok(id)
}

/// 把标签 `from` 并入 `to`（#217：两边对应同一个外部名称，本来就是同一个标签，ADR-0012）。
/// 来源事实、人工标签决定（`to` 已有的决定优先）、名称、来源名称、别名、外部对应、分组与
/// 个人近似对应都转到 `to`，`from` 删除。返回标签有变化的参考图。
pub(in crate::library) fn merge(
    tx: &Transaction,
    from: &str,
    to: &str,
) -> Result<Vec<String>, Error> {
    let images: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT image_id FROM tag_fact WHERE tag_id = ?1
             UNION SELECT image_id FROM tag_decision WHERE tag_id = ?1",
        )?;
        stmt.query_map([from], |r| r.get(0))?
            .collect::<Result<_, _>>()?
    };
    for sql in [
        "INSERT OR IGNORE INTO tag_fact (image_id, tag_id, source, score)
         SELECT image_id, ?2, source, score FROM tag_fact WHERE tag_id = ?1",
        "INSERT OR IGNORE INTO tag_decision (image_id, tag_id, decision, decided_at)
         SELECT image_id, ?2, decision, decided_at FROM tag_decision WHERE tag_id = ?1",
        // 两边都叫过的名称留给 `to`；`from` 的名称成为同语言的别名。
        "INSERT OR IGNORE INTO tag_alias (tag_id, name, lang)
         SELECT ?2, name, lang FROM tag_name WHERE tag_id = ?1",
        "INSERT OR IGNORE INTO tag_source_name (tag_id, name, lang, source)
         SELECT ?2, name, lang, source FROM tag_source_name WHERE tag_id = ?1",
        "INSERT OR IGNORE INTO tag_alias (tag_id, name, lang)
         SELECT ?2, name, lang FROM tag_alias WHERE tag_id = ?1",
        "UPDATE tag_external SET tag_id = ?2 WHERE tag_id = ?1",
        "INSERT OR IGNORE INTO tag_group_member (group_id, tag_id, ord)
         SELECT group_id, ?2, ord FROM tag_group_member WHERE tag_id = ?1",
        "UPDATE OR IGNORE personal_approx SET tag_a = ?2 WHERE tag_a = ?1",
        "UPDATE OR IGNORE personal_approx SET tag_b = ?2 WHERE tag_b = ?1",
    ] {
        tx.execute(sql, params![from, to])?;
    }
    // 其余指向 `from` 的（与 `to` 重复的分组成员、个人近似对应）随标签一起删除。
    for sql in [
        "DELETE FROM tag_fact WHERE tag_id = ?1",
        "DELETE FROM tag_decision WHERE tag_id = ?1",
        // 名称、别名的删除触发器会把标签记为待发布定义；先删它们和这条记录，再删标签。
        "DELETE FROM tag_name WHERE tag_id = ?1",
        "DELETE FROM tag_alias WHERE tag_id = ?1",
        "DELETE FROM tag_definition_dirty WHERE local_tag_id = ?1",
        "DELETE FROM tag WHERE id = ?1",
    ] {
        tx.execute(sql, [from])?;
    }
    Ok(images)
}

pub(in crate::library) fn rename_tag(
    inner: &Inner,
    tag_id: &str,
    lang: &str,
    name: &str,
) -> Result<(), Error> {
    let (tag_id, lang, name) = (tag_id.to_owned(), lang.to_owned(), clean(name)?);
    write(inner, Vec::new(), move |tx, _| {
        let namespace = require_tag(tx, &tag_id)?;
        let taken: Option<String> = tx
            .query_row(
                "SELECT t.id FROM tag t JOIN tag_name n ON n.tag_id = t.id
                 WHERE t.namespace = ?1 AND n.lang = ?2 AND n.name = ?3 AND t.id <> ?4",
                params![namespace.as_str(), lang, name, tag_id],
                |r| r.get(0),
            )
            .optional()?;
        if taken.is_some() {
            return Err(Error::DuplicateTagName(name));
        }
        tx.execute(
            "INSERT INTO tag_name (tag_id, lang, name) VALUES (?1, ?2, ?3)
             ON CONFLICT (tag_id, lang) DO UPDATE SET name = excluded.name",
            params![tag_id, lang, name],
        )?;
        Ok(())
    })
}

/// 改一个来源名称的语言（纠正按文字判断的误判，ADR-0012）。重新迁入同一叫法时保留。
pub(in crate::library) fn set_source_name_lang(
    inner: &Inner,
    tag_id: &str,
    name: &str,
    lang: &str,
) -> Result<(), Error> {
    let (tag_id, name, lang) = (tag_id.to_owned(), name.trim().to_owned(), clean(lang)?);
    let safe = inner.safe_mode();
    write(inner, Vec::new(), move |tx, _| {
        require_visible_tag(tx, safe, &tag_id)?;
        if tx.execute(
            "UPDATE tag_source_name SET lang = ?3 WHERE tag_id = ?1 AND name = ?2",
            params![tag_id, name, lang],
        )? == 0
        {
            return Err(Error::InvalidTagName);
        }
        Ok(())
    })
}

pub(in crate::library) fn add_tag_alias(
    inner: &Inner,
    tag_id: &str,
    alias: &TagAlias,
) -> Result<(), Error> {
    let tag_id = tag_id.to_owned();
    let alias = TagAlias {
        name: clean(&alias.name)?,
        lang: alias.lang.clone(),
    };
    let safe = inner.safe_mode();
    write(inner, Vec::new(), move |tx, _| {
        require_visible_tag(tx, safe, &tag_id)?;
        tx.execute(
            "INSERT INTO tag_alias (tag_id, name, lang) VALUES (?1, ?2, ?3)
             ON CONFLICT (tag_id, name) DO UPDATE SET lang = excluded.lang",
            params![tag_id, alias.name, alias.lang],
        )?;
        Ok(())
    })
}

pub(in crate::library) fn remove_tag_alias(
    inner: &Inner,
    tag_id: &str,
    alias: &str,
) -> Result<(), Error> {
    let (tag_id, alias) = (tag_id.to_owned(), alias.trim().to_owned());
    let safe = inner.safe_mode();
    write(inner, Vec::new(), move |tx, _| {
        require_visible_tag(tx, safe, &tag_id)?;
        tx.execute(
            "DELETE FROM tag_alias WHERE tag_id = ?1 AND name = ?2",
            params![tag_id, alias],
        )?;
        Ok(())
    })
}

pub(in crate::library) fn add_tag_external(
    inner: &Inner,
    tag_id: &str,
    external: &str,
) -> Result<(), Error> {
    let (tag_id, external) = (tag_id.to_owned(), clean(external)?);
    write(inner, Vec::new(), move |tx, _| {
        require_tag(tx, &tag_id)?;
        let owner: Option<String> = tx
            .query_row(
                "SELECT tag_id FROM tag_external WHERE name = ?1",
                [&external],
                |r| r.get(0),
            )
            .optional()?;
        match owner {
            Some(owner) if owner == tag_id => Ok(()),
            Some(_) => Err(Error::ExternalTaken(external)),
            None => {
                tx.execute(
                    "INSERT INTO tag_external (name, tag_id) VALUES (?1, ?2)",
                    params![external, tag_id],
                )?;
                Ok(())
            }
        }
    })
}

pub(in crate::library) fn remove_tag_external(
    inner: &Inner,
    tag_id: &str,
    external: &str,
) -> Result<(), Error> {
    let (tag_id, external) = (tag_id.to_owned(), external.trim().to_owned());
    write(inner, Vec::new(), move |tx, _| {
        require_tag(tx, &tag_id)?;
        tx.execute(
            "DELETE FROM tag_external WHERE tag_id = ?1 AND name = ?2",
            params![tag_id, external],
        )?;
        Ok(())
    })
}
