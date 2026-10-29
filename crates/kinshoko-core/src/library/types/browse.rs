//! 单个资料库的浏览查询：游标、筛选与一页卡片（从 types.rs 原样搬出）。

use super::*;

const MAX_LIMIT: u32 = 1000;

/// 分页游标（#77 S4）。对外是不透明字符串，记下它所依据的结果集：资料库、浏览视角（安全模式）、
/// 列表修订号、条件查找时的词表修订号与查询指纹，以及最后一张的 `seq`。任何一项与当前不同，
/// 接着翻都可能遗漏或重复，于是明确失效（[`Error::CursorExpired`]），调用方从第一页重读。
#[derive(Debug, PartialEq, Eq)]
struct Cursor {
    library: String,
    /// 浏览视角：安全模式开关与范围。
    safe: SafeMode,
    /// 列表修订号：参考图增删、回收站、文件夹成员、备注、跨过安全模式范围的分级变化、
    /// 范围本身变化时前进。
    list: i64,
    /// 有条件时的词表修订号（有效标签变化会改变条件结果）；没有条件时恒为 0，
    /// 后台打标不打断浏览全部图的分页。
    vocabulary: i64,
    query: String,
    seq: i64,
}

/// 游标里的视角：`s`／`o`（开／关）加范围起点的档位，例如 `s2`。
fn lens_code(safe: SafeMode) -> String {
    format!(
        "{}{}",
        if safe.on { "s" } else { "o" },
        safe.scope.start() as u8
    )
}

fn parse_lens_code(code: &str) -> Option<SafeMode> {
    let on = match code.get(..1)? {
        "s" => true,
        "o" => false,
        _ => return None,
    };
    let rank: u8 = code.get(1..)?.parse().ok()?;
    SafeMode::decode(rank).map(|mode| SafeMode { on, ..mode })
}

impl Cursor {
    const VERSION: &'static str = "v1";

    fn encode(&self) -> String {
        format!(
            "{}.{}.{}.{}.{}.{}.{}",
            Self::VERSION,
            self.library,
            lens_code(self.safe),
            self.list,
            self.vocabulary,
            self.query,
            self.seq
        )
    }

    fn decode(text: &str) -> Result<Cursor, Error> {
        let parts: Vec<&str> = text.split('.').collect();
        let [version, library, lens, list, vocabulary, query, seq] = parts[..] else {
            return Err(Error::InvalidCursor);
        };
        let number = |s: &str| s.parse::<i64>().map_err(|_| Error::InvalidCursor);
        if version != Self::VERSION {
            return Err(Error::InvalidCursor);
        }
        let safe = parse_lens_code(lens).ok_or(Error::InvalidCursor)?;
        Ok(Cursor {
            library: library.to_owned(),
            safe,
            list: number(list)?,
            vocabulary: number(vocabulary)?,
            query: query.to_owned(),
            seq: number(seq)?,
        })
    }
}

/// 查询（范围＋条件树）的指纹：同一查询才接得上同一个游标。
fn query_fingerprint(query: &BrowseQuery) -> Result<String, Error> {
    use sha2::{Digest, Sha256};
    let json = serde_json::to_vec(&(&query.scope, &query.conditions))
        .map_err(|e| Error::Io(std::io::Error::other(e)))?;
    let digest = Sha256::digest(json);
    Ok(digest[..12].iter().map(|b| format!("{b:02x}")).collect())
}

pub(in crate::library) fn browse(inner: &Inner, query: &BrowseQuery) -> Result<BrowsePage, Error> {
    let cursor = query.cursor.as_deref().map(Cursor::decode).transpose()?;
    let limit = query.limit.clamp(1, MAX_LIMIT);
    let tier = thumbnail::tier(query.thumbnail_px);
    let library_id = &inner.info.id;
    // 视角只读一次：过滤条件、卡片的 `adult` 与游标记下的视角一致。
    let safe = inner.safe();
    let fingerprint = query_fingerprint(query)?;

    // 范围条件在前，条件树在后；参数按出现顺序编号。浏览视角的过滤（安全模式）加在中间。
    let mut args: Vec<Value> = Vec::new();
    let mut conn = inner.readers.get();
    // Scope validation, structure, revisions and rows share the same read transaction.
    let tx = conn.transaction()?;
    let scope = scope_sql(&tx, &query.scope, &mut args)?;
    let conditions = filter::sql(&query.conditions, &mut args);
    let filter = format!("{scope} AND {} AND {conditions}", lens::lens_filter(safe));
    let list: i64 = tx.query_row("SELECT value FROM list_revision", [], |r| r.get(0))?;
    let vocabulary: i64 = if query.conditions.conditions.is_empty() {
        0
    } else {
        tx.query_row("SELECT value FROM vocabulary_revision", [], |r| r.get(0))?
    };
    let after = match cursor {
        None => i64::MAX,
        Some(c) => {
            let current = c.library == *library_id
                && c.safe == safe
                && c.list == list
                && c.vocabulary == vocabulary
                && c.query == fingerprint;
            if !current {
                return Err(Error::CursorExpired);
            }
            c.seq
        }
    };
    // 计数与分页用同一个筛选，结果与计数一致。
    let total: u32 = tx.query_row(
        &format!("SELECT COUNT(*) FROM image WHERE {filter}"),
        params_from_iter(&args),
        |r| r.get(0),
    )?;
    let n = args.len();
    args.push(Value::Integer(after));
    args.push(Value::Integer(i64::from(limit) + 1));
    let mut rows = {
        let mut stmt = tx.prepare_cached(&format!(
            "SELECT seq, id, width, height, {}, sha256 FROM image WHERE {filter} AND seq < ?{}
             ORDER BY seq DESC LIMIT ?{}",
            rating::in_scope_sql("image.id", safe.scope),
            n + 1,
            n + 2
        ))?;
        stmt.query_map(params_from_iter(&args), |row| {
            let id: String = row.get(1)?;
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(5)?,
                ImageCard {
                    thumbnail: format!("{library_id}/{id}/{tier}"),
                    id,
                    width: row.get(2)?,
                    height: row.get(3)?,
                    adult: row.get(4)?,
                    placeholder: None,
                },
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?
    };
    let next_cursor = if rows.len() > limit as usize {
        rows.truncate(limit as usize);
        rows.last().map(|(seq, ..)| {
            Cursor {
                library: library_id.clone(),
                safe,
                list,
                vocabulary,
                query: fingerprint,
                seq: *seq,
            }
            .encode()
        })
    } else {
        None
    };
    // 这一页的占位图一条查询读出，与结果同一个读事务。
    let mut placeholders = thumbnail::placeholders(
        &tx,
        &rows
            .iter()
            .map(|(_, sha, _)| sha.as_str())
            .collect::<Vec<_>>(),
    )?;
    tx.finish()?;
    Ok(BrowsePage {
        cards: rows
            .into_iter()
            .map(|(_, sha, card)| ImageCard {
                placeholder: placeholders.remove(&sha),
                ..card
            })
            .collect(),
        next_cursor,
        total,
    })
}

/// Shared scope interpreter for local browsing and detached workspace providers.
pub(in crate::library) fn scope_sql(
    conn: &rusqlite::Connection,
    scope: &BrowseScope,
    args: &mut Vec<Value>,
) -> Result<String, Error> {
    Ok(match scope {
        BrowseScope::All => LIVE.to_owned(),
        BrowseScope::Trash => format!("NOT ({LIVE})"),
        BrowseScope::Unassigned => {
            format!("{LIVE} AND NOT EXISTS (SELECT 1 FROM folder_member WHERE image_id = image.id)")
        }
        BrowseScope::Folder { id } | BrowseScope::FolderTree { id } => {
            crate::library::folders::ensure_folder(conn, id)?;
            args.push(Value::Text(id.clone()));
            let parameter = args.len();
            let folders = if matches!(scope, BrowseScope::FolderTree { .. }) {
                format!(
                    "IN (WITH RECURSIVE descendants(id) AS (SELECT id FROM folder WHERE id=?{parameter} UNION ALL SELECT folder.id FROM folder JOIN descendants ON folder.parent_id=descendants.id) SELECT id FROM descendants)"
                )
            } else {
                format!("=?{parameter}")
            };
            format!(
                "{LIVE} AND image.id IN (SELECT image_id FROM folder_member WHERE folder_id {folders})"
            )
        }
    })
}
