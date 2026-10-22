//! 标签分组与个人近似对应表（从 library/tags.rs 原样搬出）。

use super::*;

pub(super) fn require_group(tx: &Transaction, group_id: &str) -> Result<Option<String>, Error> {
    tx.query_row(
        "SELECT namespace FROM tag_group WHERE id = ?1",
        [group_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()?
    .ok_or(Error::UnknownTagGroup)
}

pub(in crate::library) fn create_tag_group(
    inner: &Inner,
    name: &str,
    namespace: Option<TagNamespace>,
) -> Result<String, Error> {
    let name = clean(name)?;
    write(inner, Vec::new(), move |tx, _| {
        let id = uuid::Uuid::now_v7().simple().to_string();
        tx.execute(
            "INSERT INTO tag_group (id, name, namespace, ord, created_at)
             VALUES (?1, ?2, ?3, (SELECT coalesce(max(ord), -1) + 1 FROM tag_group), ?4)",
            params![id, name, namespace.map(TagNamespace::as_str), now_ms()],
        )?;
        Ok(id)
    })
}

pub(in crate::library) fn rename_tag_group(
    inner: &Inner,
    group_id: &str,
    name: &str,
) -> Result<(), Error> {
    let (group_id, name) = (group_id.to_owned(), clean(name)?);
    write(inner, Vec::new(), move |tx, _| {
        require_group(tx, &group_id)?;
        tx.execute(
            "UPDATE tag_group SET name = ?2 WHERE id = ?1",
            params![group_id, name],
        )?;
        Ok(())
    })
}

pub(in crate::library) fn set_tag_group_tags(
    inner: &Inner,
    group_id: &str,
    tag_ids: &[String],
) -> Result<(), Error> {
    let (group_id, tag_ids) = (group_id.to_owned(), tag_ids.to_vec());
    write(inner, Vec::new(), move |tx, _| {
        if require_group(tx, &group_id)?.is_some() {
            return Err(Error::NamespaceGroup);
        }
        tx.execute(
            "DELETE FROM tag_group_member WHERE group_id = ?1",
            [&group_id],
        )?;
        for (ord, tag_id) in tag_ids.iter().enumerate() {
            require_tag(tx, tag_id)?;
            tx.execute(
                "INSERT OR IGNORE INTO tag_group_member (group_id, tag_id, ord) VALUES (?1, ?2, ?3)",
                params![group_id, tag_id, ord as i64],
            )?;
        }
        Ok(())
    })
}

pub(in crate::library) fn add_to_tag_group(
    inner: &Inner,
    group_id: &str,
    tag_ids: &[String],
) -> Result<(), Error> {
    let (group_id, tag_ids) = (group_id.to_owned(), tag_ids.to_vec());
    let safe = inner.safe();
    write(inner, Vec::new(), move |tx, _| {
        if require_group(tx, &group_id)?.is_some() {
            return Err(Error::NamespaceGroup);
        }
        for tag_id in &tag_ids {
            require_visible_tag(tx, safe, tag_id)?;
            tx.execute(
                "INSERT OR IGNORE INTO tag_group_member (group_id, tag_id, ord)
                 VALUES (?1, ?2,
                         (SELECT coalesce(max(ord), -1) + 1 FROM tag_group_member WHERE group_id = ?1))",
                params![group_id, tag_id],
            )?;
        }
        Ok(())
    })
}

pub(in crate::library) fn remove_from_tag_group(
    inner: &Inner,
    group_id: &str,
    tag_ids: &[String],
) -> Result<(), Error> {
    let (group_id, tag_ids) = (group_id.to_owned(), tag_ids.to_vec());
    write(inner, Vec::new(), move |tx, _| {
        if require_group(tx, &group_id)?.is_some() {
            return Err(Error::NamespaceGroup);
        }
        for tag_id in &tag_ids {
            tx.execute(
                "DELETE FROM tag_group_member WHERE group_id = ?1 AND tag_id = ?2",
                params![group_id, tag_id],
            )?;
        }
        Ok(())
    })
}

pub(in crate::library) fn order_tag_groups(
    inner: &Inner,
    group_ids: &[String],
) -> Result<(), Error> {
    let group_ids = group_ids.to_vec();
    write(inner, Vec::new(), move |tx, _| {
        for (ord, id) in group_ids.iter().enumerate() {
            require_group(tx, id)?;
            tx.execute(
                "UPDATE tag_group SET ord = ?2 WHERE id = ?1",
                params![id, ord as i64],
            )?;
        }
        Ok(())
    })
}

pub(in crate::library) fn delete_tag_group(inner: &Inner, group_id: &str) -> Result<(), Error> {
    let group_id = group_id.to_owned();
    write(inner, Vec::new(), move |tx, _| {
        require_group(tx, &group_id)?;
        tx.execute("DELETE FROM tag_group WHERE id = ?1", [&group_id])?;
        Ok(())
    })
}

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

pub(super) fn relation_str(relation: ApproxRelation) -> &'static str {
    match relation {
        ApproxRelation::Similar => "similar",
        ApproxRelation::NotSimilar => "notSimilar",
    }
}

pub(super) fn parse_relation(s: &str) -> rusqlite::Result<ApproxRelation> {
    match s {
        "similar" => Ok(ApproxRelation::Similar),
        "notSimilar" => Ok(ApproxRelation::NotSimilar),
        other => Err(rusqlite::Error::InvalidColumnType(
            2,
            format!("未知的近似判断 {other}"),
            rusqlite::types::Type::Text,
        )),
    }
}

/// 删掉 `a`、`b` 这一对两种顺序的记录。
pub(super) fn delete_pair(tx: &Transaction, a: &str, b: &str) -> Result<(), Error> {
    tx.execute(
        "DELETE FROM personal_approx
         WHERE (tag_a = ?1 AND tag_b = ?2) OR (tag_a = ?2 AND tag_b = ?1)",
        params![a, b],
    )?;
    Ok(())
}

pub(in crate::library) fn set_tag_approx(
    inner: &Inner,
    a: &str,
    b: &str,
    relation: ApproxRelation,
) -> Result<(), Error> {
    if a == b {
        return Err(Error::SameTag);
    }
    let (a, b) = (a.to_owned(), b.to_owned());
    write(inner, Vec::new(), move |tx, _| {
        require_tag(tx, &a)?;
        require_tag(tx, &b)?;
        delete_pair(tx, &a, &b)?;
        tx.execute(
            "INSERT INTO personal_approx (tag_a, tag_b, relation, decided_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![a, b, relation_str(relation), now_ms()],
        )?;
        Ok(())
    })
}

pub(in crate::library) fn remove_tag_approx(inner: &Inner, a: &str, b: &str) -> Result<(), Error> {
    let (a, b) = (a.to_owned(), b.to_owned());
    write(inner, Vec::new(), move |tx, _| delete_pair(tx, &a, &b))
}

/// 个人近似对应表的全部条目，最近记下的在前。
pub(super) fn read_personal_approx(
    conn: &rusqlite::Connection,
) -> Result<Vec<PersonalApprox>, Error> {
    let mut stmt = conn.prepare_cached(
        "SELECT tag_a, tag_b, relation FROM personal_approx
         ORDER BY decided_at DESC, rowid DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(PersonalApprox {
            a: r.get(0)?,
            b: r.get(1)?,
            relation: parse_relation(&r.get::<_, String>(2)?)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub(in crate::library) fn personal_approx(
    inner: &Inner,
    lang: &str,
) -> Result<Vec<PersonalApproxEntry>, Error> {
    let conn = inner.readers.get();
    let mut entries = read_personal_approx(&conn)?;
    // 浏览视角：只出现在被封印的图上的标签不露出名称。
    let hidden = inner.sealed_only_tags(&conn)?;
    entries.retain(|e| !hidden.contains(&e.a) && !hidden.contains(&e.b));
    let rows = load_tags(
        &conn,
        entries.iter().flat_map(|e| [e.a.clone(), e.b.clone()]),
    )?;
    Ok(entries
        .into_iter()
        .map(|e| PersonalApproxEntry {
            a: label(&e.a, &rows[&e.a], lang),
            b: label(&e.b, &rows[&e.b], lang),
            relation: e.relation,
        })
        .collect())
}
