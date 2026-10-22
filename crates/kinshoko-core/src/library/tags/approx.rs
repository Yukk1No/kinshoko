//! 个人近似对应表。

use super::*;

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
