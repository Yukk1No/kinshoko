//! 标签的名称、整理与来源事实的写入（从 library/tags.rs 原样搬出）。

use super::*;

pub(super) fn clean(name: &str) -> Result<String, Error> {
    let name = name.trim();
    if name.is_empty() {
        Err(Error::InvalidTagName)
    } else {
        Ok(name.to_owned())
    }
}

pub(super) fn new_tag(tx: &Transaction, namespace: TagNamespace) -> Result<String, Error> {
    let id = uuid::Uuid::now_v7().simple().to_string();
    tx.execute(
        "INSERT INTO tag (id, namespace, created_at) VALUES (?1, ?2, ?3)",
        params![id, namespace.as_str(), now_ms()],
    )?;
    Ok(id)
}

/// 命名空间内名称（任一语言）为 `name` 的标签；没有时看别名。
pub(super) fn find_named(
    tx: &Transaction,
    namespace: TagNamespace,
    name: &str,
) -> Result<Option<String>, Error> {
    for sql in [
        "SELECT DISTINCT t.id FROM tag t JOIN tag_name n ON n.tag_id = t.id
         WHERE t.namespace = ?1 AND n.name = ?2",
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

/// 本命名空间里除 `tag_id` 以外的标签是否已用 `text` 作名称或别名。
pub(super) fn text_taken(
    tx: &Transaction,
    namespace: TagNamespace,
    tag_id: &str,
    text: &str,
) -> Result<bool, Error> {
    Ok(tx
        .query_row(
            "SELECT 1 FROM tag t WHERE t.namespace = ?1 AND t.id <> ?2 AND (
                 EXISTS (SELECT 1 FROM tag_name n WHERE n.tag_id = t.id AND n.name = ?3)
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
pub(super) fn initialise_names(
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

/// 找到或新建 `tag` 指向的标签。`create` 为假时找不到返回 `None`。
pub(super) fn resolve(
    tx: &Transaction,
    translations: &TranslationIndex,
    tag: &TagRef,
    create: bool,
) -> Result<Option<String>, Error> {
    match tag {
        TagRef::Id { id } => {
            require_tag(tx, id)?;
            Ok(Some(id.clone()))
        }
        TagRef::Named {
            namespace,
            name,
            lang,
        } => {
            let name = clean(name)?;
            if let Some(id) = find_named(tx, *namespace, &name)? {
                return Ok(Some(id));
            }
            if !create {
                return Ok(None);
            }
            let id = new_tag(tx, *namespace)?;
            tx.execute(
                "INSERT INTO tag_name (tag_id, lang, name) VALUES (?1, ?2, ?3)",
                params![id, lang, name],
            )?;
            Ok(Some(id))
        }
        TagRef::External { namespace, name } => {
            let name = clean(name)?;
            let existing: Option<String> = tx
                .query_row(
                    "SELECT tag_id FROM tag_external WHERE name = ?1",
                    [&name],
                    |r| r.get(0),
                )
                .optional()?;
            if existing.is_some() || !create {
                return Ok(existing);
            }
            let translation = translations.get(&name);
            // 翻译后的名称已是本命名空间某个标签的名称：外部对应落在那个标签上。
            // 叫这个名称的标签不止一个时不去猜，当作没有。
            let mut id = None;
            if let Some(t) = translation {
                for translated in t.names.values() {
                    match find_named(tx, *namespace, translated) {
                        Ok(Some(found)) => {
                            id = Some(found);
                            break;
                        }
                        Ok(None) | Err(Error::AmbiguousTag(_)) => {}
                        Err(e) => return Err(e),
                    }
                }
            }
            let id = match id {
                Some(id) => id,
                None => {
                    let id = new_tag(tx, *namespace)?;
                    if let Some(t) = translation {
                        initialise_names(tx, *namespace, &id, t)?;
                    }
                    id
                }
            };
            tx.execute(
                "INSERT INTO tag_external (name, tag_id) VALUES (?1, ?2)",
                params![name, id],
            )?;
            Ok(Some(id))
        }
    }
}

pub(in crate::library) fn edit_tags(
    inner: &Inner,
    image_ids: &[String],
    edits: &[TagEdit],
) -> Result<(), Error> {
    let ids = image_ids.to_vec();
    let edits = edits.to_vec();
    let lens = inner.lens_filter();
    write(inner, image_ids.to_vec(), move |tx, translations| {
        for id in &ids {
            lens::require_visible(tx, &lens, id)?;
        }
        let now = now_ms();
        for edit in &edits {
            let (tag, decision) = match edit {
                TagEdit::Add { tag } => (tag, Some("add")),
                TagEdit::Reject { tag } => (tag, Some("reject")),
                TagEdit::Clear { tag } => (tag, None),
            };
            let Some(tag_id) = resolve(tx, translations, tag, decision.is_some())? else {
                continue;
            };
            for image_id in &ids {
                match decision {
                    Some(decision) => tx.execute(
                        "INSERT INTO tag_decision (image_id, tag_id, decision, decided_at)
                         VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT (image_id, tag_id)
                         DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at",
                        params![image_id, tag_id, decision, now],
                    )?,
                    None => tx.execute(
                        "DELETE FROM tag_decision WHERE image_id = ?1 AND tag_id = ?2",
                        params![image_id, tag_id],
                    )?,
                };
            }
        }
        Ok(())
    })
}

pub(in crate::library) fn replace_source_tags(
    inner: &Inner,
    source: &FactSource,
    image_id: &str,
    tags: &[SourceTag],
) -> Result<(), Error> {
    let source = source.as_str().to_owned();
    let image_id = image_id.to_owned();
    let tags = tags.to_vec();
    write(inner, vec![image_id.clone()], move |tx, translations| {
        replace_source_tags_in(tx, translations, &FactSource(source), &image_id, &tags)
    })
}

/// 与导入事务共用来源层写入规则；调用方负责提交后再推送事件。
pub(in crate::library) fn replace_source_tags_in(
    tx: &Transaction,
    translations: &TranslationIndex,
    source: &FactSource,
    image_id: &str,
    tags: &[SourceTag],
) -> Result<(), Error> {
    require_image(tx, image_id)?;
    tx.execute(
        "DELETE FROM tag_fact WHERE image_id = ?1 AND source = ?2",
        params![image_id, source.as_str()],
    )?;
    for t in tags {
        let tag_id = resolve(tx, translations, &t.tag, true)?.ok_or(Error::UnknownTag)?;
        tx.execute(
                "INSERT INTO tag_fact (image_id, tag_id, source, score) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (image_id, tag_id, source)
                 DO UPDATE SET score = max(coalesce(score, excluded.score), coalesce(excluded.score, score))",
                params![image_id, tag_id, source.as_str(), t.score],
            )?;
    }
    Ok(())
}

/// 快照先按外部对应、再按名称找身份，再补全名称与对应。目标库已有的整理不覆盖；
/// 新标签直接使用快照的全部语言名称，只有无名称时才按内置翻译表初始化。
pub(in crate::library) fn replace_snapshot_tags(
    tx: &Transaction,
    translations: &TranslationIndex,
    source: &FactSource,
    image_id: &str,
    tags: &[super::super::package::SnapshotTag],
) -> Result<(), Error> {
    let mut resolvable = Vec::new();
    for t in tags {
        match resolve_snapshot_tag(tx, translations, t) {
            Ok(Some(id)) => resolvable.push(SourceTag {
                tag: TagRef::Id { id },
                score: None,
            }),
            Ok(None) | Err(Error::AmbiguousTag(_) | Error::InvalidTagName) => {}
            Err(e) => return Err(e),
        }
    }
    replace_source_tags_in(tx, translations, source, image_id, &resolvable)
}

pub(super) fn resolve_snapshot_tag(
    tx: &Transaction,
    translations: &TranslationIndex,
    tag: &super::super::package::SnapshotTag,
) -> Result<Option<String>, Error> {
    if let Some(definition) = &tag.definition {
        return super::super::tag_definitions::resolve_snapshot(tx, definition, tag.namespace)
            .map(Some);
    }
    let mut identity = None;
    for external in &tag.external {
        identity = resolve(
            tx,
            translations,
            &TagRef::External {
                namespace: tag.namespace,
                name: external.clone(),
            },
            false,
        )?;
        if identity.is_some() {
            break;
        }
    }
    if identity.is_none() {
        for name in &tag.names {
            identity = find_named(tx, tag.namespace, &clean(&name.name)?)?;
            if identity.is_some() {
                break;
            }
        }
    }
    if identity.is_none() && tag.names.is_empty() && tag.external.is_empty() {
        return Ok(None);
    }
    let id = match identity {
        Some(id) => id,
        None => new_tag(tx, tag.namespace)?,
    };
    let namespace = require_tag(tx, &id)?;
    for name in &tag.names {
        let text = clean(&name.name)?;
        if !text_taken(tx, namespace, &id, &text)? {
            tx.execute(
                "INSERT OR IGNORE INTO tag_name (tag_id, lang, name) VALUES (?1, ?2, ?3)",
                params![id, name.lang, text],
            )?;
        }
    }
    for external in &tag.external {
        let name = clean(external)?;
        tx.execute(
            "INSERT OR IGNORE INTO tag_external (name, tag_id) VALUES (?1, ?2)",
            params![name, id],
        )?;
    }
    let has_names: bool = tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM tag_name WHERE tag_id = ?1)",
        [&id],
        |r| r.get(0),
    )?;
    if !has_names {
        for external in &tag.external {
            if let Some(translation) = translations.get(external) {
                initialise_names(tx, namespace, &id, translation)?;
                break;
            }
        }
    }
    Ok(Some(id))
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
    let safe = inner.safe();
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
    let safe = inner.safe();
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
