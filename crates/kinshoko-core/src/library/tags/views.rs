//! 标签的读取：详情里的标签、计数与词表快照（从 library/tags.rs 原样搬出）。

use super::*;

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
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT e.tag_id, COUNT(*) FROM effective_tag e
         JOIN image ON image.id = e.image_id WHERE {LIVE} AND {} GROUP BY e.tag_id",
        inner.lens_filter()
    ))?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub(in crate::library) fn revision(inner: &Inner) -> Result<i64, Error> {
    let conn = inner.readers.get();
    Ok(conn.query_row("SELECT value FROM vocabulary_revision", [], |r| r.get(0))?)
}

pub(in crate::library) fn vocabulary(inner: &Inner) -> Result<Vocabulary, Error> {
    let mut conn = inner.readers.get();
    // 修订号与内容取自同一个读事务，保证快照一致。
    let tx = conn.transaction()?;
    let revision: i64 = tx.query_row("SELECT value FROM vocabulary_revision", [], |r| r.get(0))?;
    let safe = inner.safe();
    let counts = counts(inner, &tx)?;
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
