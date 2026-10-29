//! 整理信息摘要：恢复后核对整理结果与快照一致（从 backup.rs 原样搬出）。

use super::*;

/// 不进整理信息核对的表：资料库身份、恢复来源、未完成导入与待清除原文件的对账记录，以及可重建的
/// 占位图（#313：恢复后打开资料库时后台补齐会改它）。
pub(super) const NOT_CURATION: &[&str] = &[
    "library",
    "restore_provenance",
    "import_pending",
    "original_removal",
    "placeholder",
];

/// 整理信息摘要。`like` 给出时按它的表与列（快照里的列；之后的迁移只会加列）计算，顺序一致。
pub(super) fn curation(
    conn: &Connection,
    like: Option<&[TableDigest]>,
) -> Result<Vec<TableDigest>, Error> {
    let specs: Vec<(String, Vec<String>)> = match like {
        Some(like) => like
            .iter()
            .map(|d| (d.table.clone(), d.columns.clone()))
            .collect(),
        None => {
            let mut stmt = conn.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                 ORDER BY name",
            )?;
            let tables: Vec<String> = stmt
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            let mut specs = Vec::new();
            for table in tables {
                if NOT_CURATION.contains(&table.as_str()) {
                    continue;
                }
                let columns = columns(conn, &table)?;
                specs.push((table, columns));
            }
            specs
        }
    };
    let mut out = Vec::new();
    for (table, cols) in specs {
        out.push(digest(conn, &table, &cols).unwrap_or_else(|_| TableDigest {
            table: table.clone(),
            columns: cols.clone(),
            rows: 0,
            sha256: "缺少这张表或列".into(),
        }));
    }
    Ok(out)
}

fn columns(conn: &Connection, table: &str) -> Result<Vec<String>, Error> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", quote(table)))?;
    let cols = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<_, _>>()?;
    Ok(cols)
}

fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn digest(conn: &Connection, table: &str, cols: &[String]) -> Result<TableDigest, Error> {
    let list = cols.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", ");
    let order = (1..=cols.len())
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn.prepare(&format!(
        "SELECT {list} FROM {} ORDER BY {order}",
        quote(table)
    ))?;
    let mut rows = stmt.query([])?;
    let mut hasher = Sha256::new();
    let mut count = 0u64;
    while let Some(row) = rows.next()? {
        count += 1;
        for i in 0..cols.len() {
            match row.get_ref(i)? {
                ValueRef::Null => hasher.update([0u8]),
                ValueRef::Integer(v) => {
                    hasher.update([1u8]);
                    hasher.update(v.to_le_bytes());
                }
                ValueRef::Real(v) => {
                    hasher.update([2u8]);
                    hasher.update(v.to_le_bytes());
                }
                ValueRef::Text(t) => {
                    hasher.update([3u8]);
                    hasher.update((t.len() as u64).to_le_bytes());
                    hasher.update(t);
                }
                ValueRef::Blob(b) => {
                    hasher.update([4u8]);
                    hasher.update((b.len() as u64).to_le_bytes());
                    hasher.update(b);
                }
            }
        }
    }
    Ok(TableDigest {
        table: table.to_owned(),
        columns: cols.to_vec(),
        rows: count,
        sha256: hex(&hasher.finalize()),
    })
}
