//! 标签读取与显示名。

use super::*;

pub(in crate::library) struct TagRow {
    namespace: TagNamespace,
    names: Vec<LocalizedName>,
    source_names: Vec<LocalizedName>,
    pub(in crate::library) external: Vec<String>,
}

/// 读取若干标签的命名空间、名称与外部对应。
pub(in crate::library) fn load_tags(
    conn: &rusqlite::Connection,
    ids: impl IntoIterator<Item = String>,
) -> Result<HashMap<String, TagRow>, Error> {
    let mut out = HashMap::new();
    let mut tag = conn.prepare_cached("SELECT namespace FROM tag WHERE id = ?1")?;
    let mut names =
        conn.prepare_cached("SELECT lang, name FROM tag_name WHERE tag_id = ?1 ORDER BY lang")?;
    let mut external =
        conn.prepare_cached("SELECT name FROM tag_external WHERE tag_id = ?1 ORDER BY name")?;
    for id in ids {
        if out.contains_key(&id) {
            continue;
        }
        let namespace = tag.query_row([&id], |r| TagNamespace::parse(&r.get::<_, String>(0)?))?;
        let names = names
            .query_map([&id], |r| {
                Ok(LocalizedName {
                    lang: r.get(0)?,
                    name: r.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let external = external
            .query_map([&id], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        let source_names = crate::library::source_names::load(conn, &id)?;
        out.insert(
            id,
            TagRow {
                namespace,
                names,
                source_names,
                external,
            },
        );
    }
    Ok(out)
}

/// 主语言子标签，例如 `zh-CN` → `zh`。
pub(super) fn primary(lang: &str) -> &str {
    lang.split(['-', '_']).next().unwrap_or(lang)
}

/// 按界面语言选择显示名：界面语言 → 同一主语言 → 其他语言 → 外部名称（尚未翻译）。
/// 本库的来源名称优先于默认名称。
pub(in crate::library) fn label(id: &str, row: &TagRow, lang: &str) -> TagLabel {
    let names = crate::library::source_names::compose(&row.names, &row.source_names, &[]);
    display_label(id, row.namespace, &names, &row.external, lang)
}

/// 同 [`label`]，供 Search 按词表快照显示标签。
pub(crate) fn display_label(
    id: &str,
    namespace: TagNamespace,
    names: &[LocalizedName],
    external: &[String],
    lang: &str,
) -> TagLabel {
    let pick = names
        .iter()
        .find(|n| n.lang.eq_ignore_ascii_case(lang))
        .or_else(|| {
            names
                .iter()
                .find(|n| primary(&n.lang).eq_ignore_ascii_case(primary(lang)))
        })
        // 未注明语言的名称排在其他语言之后。
        .or_else(|| {
            names
                .iter()
                .find(|n| n.lang != crate::library::source_names::UND)
        })
        .or_else(|| names.first());
    let (name, untranslated) = match pick {
        Some(n) => (n.name.clone(), false),
        None => (
            external
                .first()
                .map(|e| e.replace('_', " "))
                .unwrap_or_else(|| id.to_owned()),
            true,
        ),
    };
    TagLabel {
        id: id.to_owned(),
        namespace,
        name,
        untranslated,
        has_external: !external.is_empty(),
    }
}

pub(super) fn sort_labels(labels: &mut [TagLabel]) {
    labels.sort_by(|a, b| (a.namespace, &a.name, &a.id).cmp(&(b.namespace, &b.name, &b.id)));
}

pub(in crate::library) fn image_tags(
    inner: &Inner,
    image_id: &str,
    lang: &str,
) -> Result<ImageTags, Error> {
    let conn = inner.readers.get();
    inner.require_visible(&conn, image_id)?;

    let mut origins: BTreeMap<String, Vec<TagOrigin>> = BTreeMap::new();
    let mut facts = conn.prepare_cached(
        "SELECT tag_id, source, score FROM tag_fact WHERE image_id = ?1 ORDER BY source",
    )?;
    for row in facts.query_map([image_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<f64>>(2)?,
        ))
    })? {
        let (tag_id, source, score) = row?;
        origins.entry(tag_id).or_default().push(TagOrigin::Source {
            source,
            score: score.map(|s| s as f32),
        });
    }
    let mut rejected = Vec::new();
    let mut decisions =
        conn.prepare_cached("SELECT tag_id, decision FROM tag_decision WHERE image_id = ?1")?;
    for row in decisions.query_map([image_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (tag_id, decision) = row?;
        match decision.as_str() {
            "add" => origins.entry(tag_id).or_default().push(TagOrigin::Manual),
            "conflict" => origins.entry(tag_id).or_default().push(TagOrigin::Conflict),
            _ => {
                origins.remove(&tag_id);
                rejected.push(tag_id);
            }
        }
    }
    let rows = load_tags(
        &conn,
        origins.keys().cloned().chain(rejected.iter().cloned()),
    )?;
    let mut tags: Vec<ImageTag> = origins
        .into_iter()
        .map(|(id, origins)| ImageTag {
            tag: label(&id, &rows[&id], lang),
            origins,
        })
        .collect();
    tags.sort_by(|a, b| {
        (a.tag.namespace, &a.tag.name, &a.tag.id).cmp(&(b.tag.namespace, &b.tag.name, &b.tag.id))
    });
    let mut rejected: Vec<TagLabel> = rejected
        .iter()
        .map(|id| label(id, &rows[id], lang))
        .collect();
    sort_labels(&mut rejected);
    Ok(ImageTags {
        image_id: image_id.to_owned(),
        tags,
        rejected,
    })
}

/// 每个标签的有效张数，只算浏览视角下可见的图（不含回收站与被封印的图）。
pub(in crate::library) fn counts(
    inner: &Inner,
    conn: &rusqlite::Connection,
) -> Result<HashMap<String, u32>, Error> {
    counts_in(conn, inner.safe())
}

/// 视角 `safe` 下每个标签的有效张数。
fn counts_in(conn: &rusqlite::Connection, safe: SafeMode) -> Result<HashMap<String, u32>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT e.tag_id, COUNT(*) FROM effective_tag e
         JOIN image ON image.id = e.image_id WHERE {LIVE} AND {} GROUP BY e.tag_id",
        lens::lens_filter(safe)
    ))?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub(in crate::library) fn revision(inner: &Inner) -> Result<i64, Error> {
    let conn = inner.readers.get();
    Ok(conn.query_row("SELECT value FROM vocabulary_revision", [], |r| r.get(0))?)
}

pub(in crate::library) fn vocabulary(inner: &Inner) -> Result<Vocabulary, Error> {
    vocabulary_in(inner, inner.safe())
}

/// 视角 `safe` 下的词表快照；句柄自己的视角不变。
pub(in crate::library) fn vocabulary_in(
    inner: &Inner,
    safe: SafeMode,
) -> Result<Vocabulary, Error> {
    let mut conn = inner.readers.get();
    // 修订号与内容取自同一个读事务，保证快照一致。
    let tx = conn.transaction()?;
    let revision: i64 = tx.query_row("SELECT value FROM vocabulary_revision", [], |r| r.get(0))?;
    let counts = counts_in(&tx, safe)?;
    let hidden = lens::sealed_only_tags(&tx, safe)?;
    let mut tags: BTreeMap<String, VocabularyTag> = BTreeMap::new();
    {
        let mut stmt = tx.prepare("SELECT id, namespace FROM tag")?;
        for row in stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                TagNamespace::parse(&r.get::<_, String>(1)?)?,
            ))
        })? {
            let (id, namespace) = row?;
            if hidden.contains(&id) {
                continue;
            }
            tags.insert(
                id.clone(),
                VocabularyTag {
                    count: counts.get(&id).copied().unwrap_or(0),
                    id,
                    namespace,
                    names: Vec::new(),
                    aliases: Vec::new(),
                    external: Vec::new(),
                    source_names: Vec::new(),
                },
            );
        }
        let mut stmt = tx.prepare("SELECT tag_id, lang, name FROM tag_name ORDER BY lang")?;
        for row in stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get(2)?))
        })? {
            let (id, lang, name) = row?;
            if let Some(t) = tags.get_mut(&id) {
                t.names.push(LocalizedName { lang, name });
            }
        }
        let mut stmt = tx.prepare("SELECT tag_id, name, lang FROM tag_alias ORDER BY name")?;
        for row in stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get(2)?))
        })? {
            let (id, name, lang) = row?;
            if let Some(t) = tags.get_mut(&id) {
                t.aliases.push(TagAlias { name, lang });
            }
        }
        let mut stmt =
            tx.prepare("SELECT tag_id, lang, name FROM tag_source_name ORDER BY rowid")?;
        for row in stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get(2)?))
        })? {
            let (id, lang, name) = row?;
            if let Some(t) = tags.get_mut(&id) {
                t.source_names.push(LocalizedName { lang, name });
            }
        }
        let mut stmt = tx.prepare("SELECT tag_id, name FROM tag_external ORDER BY name")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get(1)?)))? {
            let (id, name) = row?;
            if let Some(t) = tags.get_mut(&id) {
                t.external.push(name);
            }
        }
    }
    let mut personal_approx = read_personal_approx(&tx)?;
    personal_approx.retain(|e| !hidden.contains(&e.a) && !hidden.contains(&e.b));
    tx.finish()?;
    Ok(Vocabulary {
        revision,
        tags: tags.into_values().collect(),
        personal_approx,
        safe_mode: safe.on,
        safe_mode_scope: safe.scope,
    })
}
