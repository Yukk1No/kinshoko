//! 库内遗留标签分组的读取；分组改写由应用统一标签目录负责。

use super::*;

pub(in crate::library) fn tag_group_definitions(
    inner: &Inner,
) -> Result<Vec<TagGroupDefinition>, Error> {
    let mut conn = inner.readers.get();
    let tx = conn.transaction()?;
    let mut groups = tx
        .prepare_cached("SELECT id, name, namespace FROM tag_group ORDER BY ord, created_at, id")?;
    let mut members = tx.prepare_cached(
        "SELECT tag_id FROM tag_group_member WHERE group_id=?1 ORDER BY ord, tag_id",
    )?;
    let mut out = Vec::new();
    for row in groups.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })? {
        let (id, name, namespace) = row?;
        let namespace = namespace.as_deref().map(TagNamespace::parse).transpose()?;
        let tag_ids = if namespace.is_none() {
            members
                .query_map([&id], |r| r.get(0))?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            Vec::new()
        };
        out.push(TagGroupDefinition {
            id,
            name,
            namespace,
            members: tag_ids,
        });
    }
    Ok(out)
}

pub(in crate::library) fn tag_groups(
    inner: &Inner,
    lang: &str,
) -> Result<Vec<TagGroupView>, Error> {
    let conn = inner.readers.get();
    let counts = counts(inner, &conn)?;
    let hidden = inner.sealed_only_tags(&conn)?;
    let mut stmt =
        conn.prepare_cached("SELECT id, name, namespace FROM tag_group ORDER BY ord, created_at")?;
    let groups = stmt
        .query_map([], |r| {
            let namespace: Option<String> = r.get(2)?;
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                namespace.as_deref().map(TagNamespace::parse).transpose()?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut members = conn
        .prepare_cached("SELECT tag_id FROM tag_group_member WHERE group_id = ?1 ORDER BY ord")?;
    let mut in_namespace = conn.prepare_cached("SELECT id FROM tag WHERE namespace = ?1")?;
    let mut out = Vec::new();
    for (id, name, namespace) in groups {
        let mut tag_ids = match namespace {
            Some(ns) => in_namespace
                .query_map([ns.as_str()], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?,
            None => members
                .query_map([&id], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?,
        };
        tag_ids.retain(|t| !hidden.contains(t));
        let rows = load_tags(&conn, tag_ids.iter().cloned())?;
        let mut tags: Vec<TagCount> = tag_ids
            .iter()
            .map(|t| TagCount {
                tag: label(t, &rows[t], lang),
                count: counts.get(t).copied().unwrap_or(0),
            })
            .collect();
        // 命名空间分组按名称排序；画师整理的分组保持画师给出的顺序。
        if namespace.is_some() {
            tags.sort_by(|a, b| (&a.tag.name, &a.tag.id).cmp(&(&b.tag.name, &b.tag.id)));
        }
        out.push(TagGroupView {
            id,
            name,
            namespace,
            tags,
        });
    }
    Ok(out)
}
