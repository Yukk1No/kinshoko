//! 标签写入：写事务、按来源分层写入与人工标签决定。

use super::*;

/// 在写线程上执行一个标签写入事务：词表修订号加一，提交后推送事件。
pub(in crate::library) fn write<T: Send + 'static>(
    inner: &Inner,
    changed_images: Vec<String>,
    f: impl FnOnce(&Transaction, &TranslationIndex) -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    let translations = inner.translations();
    let (value, revision) = inner.writer.run(move |conn| {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let value = f(&tx, &translations)?;
        let revision = bump_revision(&tx)?;
        tx.commit()?;
        Ok::<_, Error>((value, revision))
    })?;
    let library_id = inner.info.id.clone();
    if !changed_images.is_empty() {
        inner.hub.publish(LibraryEvent::ImagesChanged {
            library_id: library_id.clone(),
            image_ids: changed_images,
        });
    }
    inner.hub.publish(LibraryEvent::VocabularyChanged {
        library_id,
        revision,
    });
    Ok(value)
}

/// 词表修订号加一，返回新值。词表内容或计数变化的写入事务里调用。
pub(in crate::library) fn bump_revision(tx: &Transaction) -> Result<i64, Error> {
    crate::library::tag_definitions::seed(tx)?;
    Ok(tx.query_row(
        "UPDATE vocabulary_revision SET value = value + 1 RETURNING value",
        [],
        |r| r.get(0),
    )?)
}

pub(super) fn require_image(tx: &Transaction, image_id: &str) -> Result<(), Error> {
    tx.query_row("SELECT 1 FROM image WHERE id = ?1", [image_id], |_| Ok(()))
        .optional()?
        .ok_or(Error::UnknownImage)
}

pub(super) fn require_tag(tx: &Transaction, tag_id: &str) -> Result<TagNamespace, Error> {
    tx.query_row("SELECT namespace FROM tag WHERE id = ?1", [tag_id], |r| {
        TagNamespace::parse(&r.get::<_, String>(0)?)
    })
    .optional()?
    .ok_or(Error::UnknownTag)
}

/// 浏览视角下这个标签存在：`safe`（安全模式开启）时，只在被封印的图上出现的标签当作不存在
/// （与 [`Inner::sealed_only_tags`] 同一规则），画师看不见它，也不能经 id 整理它。
pub(super) fn require_visible_tag(
    tx: &Transaction,
    safe: bool,
    tag_id: &str,
) -> Result<TagNamespace, Error> {
    let namespace = require_tag(tx, tag_id)?;
    if safe {
        let adult = rating::adult_sql("image.id");
        let sealed_only: bool = tx.query_row(
            &format!(
                "SELECT EXISTS (SELECT 1 FROM effective_tag e JOIN image ON image.id = e.image_id
                                WHERE e.tag_id = ?1 AND {adult})
                    AND NOT EXISTS (SELECT 1 FROM effective_tag e JOIN image ON image.id = e.image_id
                                    WHERE e.tag_id = ?1 AND NOT ({adult}))"
            ),
            [tag_id],
            |r| r.get(0),
        )?;
        if sealed_only {
            return Err(Error::UnknownTag);
        }
    }
    Ok(namespace)
}

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
    tags: &[crate::library::package::SnapshotTag],
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
    tag: &crate::library::package::SnapshotTag,
) -> Result<Option<String>, Error> {
    if let Some(definition) = &tag.definition {
        let id = crate::library::tag_definitions::resolve_snapshot(tx, definition, tag.namespace)?;
        // 定义没有默认名称时，包带来的叫法是这个库的来源名称（#217）。
        let named: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM tag_name WHERE tag_id = ?1)
                 OR EXISTS (SELECT 1 FROM tag_source_name WHERE tag_id = ?1)",
            [&id],
            |r| r.get(0),
        )?;
        if !named {
            for name in &tag.names {
                let text = clean(&name.name)?;
                if !text_taken(tx, tag.namespace, &id, &text)? {
                    crate::library::source_names::insert(tx, &id, &text, &name.lang, "package")?;
                }
            }
        }
        return Ok(Some(id));
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
