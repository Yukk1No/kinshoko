//! 内容分级与打标子接口（#52）。
//!
//! - 分级建议按来源分层（[`FactSource`]），和标签事实同一规则：某个来源重写只替换自己那一行。
//!   人工分级（#53）优先于建议；目前有效分级就是各来源建议中最严格的一档。
//! - 有效分级只在 [`effective_rank_sql`] 定义：[`image_rating`] 的 `effective` 与安全模式（#60）的
//!   封印都由它算出，人工分级接进这里就同时作用于两者。
//! - 打标进度按模型来源记录：没有记录的图就是待打标的图；无法打标的图记下原因，不再重试。

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::events::LibraryEvent;
use super::tags::FactSource;
use super::{Error, Inner, now_ms};

/// 内容分级，从宽到严排列。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ContentRating {
    /// 全年龄。
    General,
    /// 轻微敏感。
    Sensitive,
    /// 可疑（含成人内容）。
    Questionable,
    /// 露骨（含成人内容）。
    Explicit,
}

impl ContentRating {
    pub fn as_str(self) -> &'static str {
        match self {
            ContentRating::General => "general",
            ContentRating::Sensitive => "sensitive",
            ContentRating::Questionable => "questionable",
            ContentRating::Explicit => "explicit",
        }
    }

    fn from_rank(rank: i64) -> Option<ContentRating> {
        Some(match rank {
            0 => ContentRating::General,
            1 => ContentRating::Sensitive,
            2 => ContentRating::Questionable,
            3 => ContentRating::Explicit,
            _ => return None,
        })
    }

    /// 是否含成人内容（questionable 与 explicit）：安全模式开启时封印这样的图。
    pub fn is_adult(self) -> bool {
        self >= ContentRating::Questionable
    }

    /// 按名称解析，接受 `general`、`rating:g`、`g` 等写法。
    pub fn parse(s: &str) -> Option<ContentRating> {
        let s = s.trim().to_ascii_lowercase();
        let s = s.strip_prefix("rating:").unwrap_or(&s);
        Some(match s {
            "general" | "g" | "safe" => ContentRating::General,
            "sensitive" | "s" => ContentRating::Sensitive,
            "questionable" | "q" => ContentRating::Questionable,
            "explicit" | "e" => ContentRating::Explicit,
            _ => return None,
        })
    }
}

/// 来源给出的一条分级建议。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RatingFact {
    pub rating: ContentRating,
    /// 模型给出的分数。
    pub score: Option<f32>,
}

/// 一张参考图的内容分级。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageRating {
    pub image_id: String,
    /// 自动分级：各来源建议中最严格的一档；还没有建议时为空。
    pub suggested: Option<ContentRating>,
    /// 有效分级（人工分级优先，#53）。
    pub effective: Option<ContentRating>,
}

/// 一张图的打标结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaggingOutcome {
    /// 建议已写入。
    Done,
    /// 这张图无法打标（例如解码失败或反复让打标子进程崩溃），附原因；不再重试。
    Failed(String),
}

/// 参考图有效分级的档位（`general` 0 … `explicit` 3），没有分级时为 NULL。
/// `image_id` 是引用参考图 id 的 SQL 表达式（例如 `image.id`）。
///
/// 有效分级的唯一定义：人工分级（#53）覆盖建议时只改这里。
pub(super) fn effective_rank_sql(image_id: &str) -> String {
    format!(
        "(SELECT max(CASE rf.rating WHEN 'general' THEN 0 WHEN 'sensitive' THEN 1          WHEN 'questionable' THEN 2 WHEN 'explicit' THEN 3 END)          FROM rating_fact rf WHERE rf.image_id = {image_id})"
    )
}

/// 有效分级含成人内容（questionable 或 explicit）的条件。还没有分级的图不算。
pub(super) fn adult_sql(image_id: &str) -> String {
    format!("coalesce({}, 0) >= 2", effective_rank_sql(image_id))
}

pub(super) fn replace_source_rating(
    inner: &Inner,
    source: &FactSource,
    image_id: &str,
    fact: Option<RatingFact>,
) -> Result<(), Error> {
    let (source, id) = (source.as_str().to_owned(), image_id.to_owned());
    inner.writer.run(move |conn| {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        require_image(&tx, &id)?;
        tx.execute(
            "DELETE FROM rating_fact WHERE image_id = ?1 AND source = ?2",
            params![id, source],
        )?;
        if let Some(f) = fact {
            tx.execute(
                "INSERT INTO rating_fact (image_id, source, rating, score) VALUES (?1, ?2, ?3, ?4)",
                params![id, source, f.rating.as_str(), f.score],
            )?;
        }
        tx.commit()?;
        Ok::<_, Error>(())
    })?;
    inner.hub.publish(LibraryEvent::ImagesChanged {
        library_id: inner.info.id.clone(),
        image_ids: vec![image_id.to_owned()],
    });
    Ok(())
}

pub(super) fn image_rating(inner: &Inner, image_id: &str) -> Result<ImageRating, Error> {
    let conn = inner.readers.get();
    inner.require_visible(&conn, image_id)?;
    let effective: Option<i64> = conn.query_row(
        &format!("SELECT {}", effective_rank_sql("?1")),
        [image_id],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare_cached("SELECT rating FROM rating_fact WHERE image_id = ?1")?;
    let suggested = stmt
        .query_map([image_id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .filter_map(|s| ContentRating::parse(s))
        .max();
    Ok(ImageRating {
        image_id: image_id.to_owned(),
        suggested,
        effective: effective.and_then(ContentRating::from_rank),
    })
}

pub(super) fn images_to_tag(
    inner: &Inner,
    source: &FactSource,
    limit: u32,
) -> Result<Vec<String>, Error> {
    let conn = inner.readers.get();
    let mut stmt = conn.prepare_cached(
        "SELECT i.id FROM image i
         WHERE i.deleted_at IS NULL AND NOT EXISTS (
            SELECT 1 FROM tagging_state s WHERE s.image_id = i.id AND s.source = ?1)
         ORDER BY i.seq DESC LIMIT ?2",
    )?;
    let ids = stmt
        .query_map(params![source.as_str(), limit], |r| r.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(ids)
}

pub(super) fn finish_tagging(
    inner: &Inner,
    source: &FactSource,
    image_id: &str,
    outcome: TaggingOutcome,
) -> Result<(), Error> {
    let (source, id) = (source.as_str().to_owned(), image_id.to_owned());
    inner.writer.run(move |conn| {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        require_image(&tx, &id)?;
        let (status, reason) = match outcome {
            TaggingOutcome::Done => ("done", None),
            TaggingOutcome::Failed(reason) => ("failed", Some(reason)),
        };
        tx.execute(
            "INSERT INTO tagging_state (image_id, source, status, reason, at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (image_id, source)
             DO UPDATE SET status = excluded.status, reason = excluded.reason, at = excluded.at",
            params![id, source, status, reason, now_ms()],
        )?;
        tx.commit()?;
        Ok::<_, Error>(())
    })
}

fn require_image(tx: &rusqlite::Transaction, image_id: &str) -> Result<(), Error> {
    tx.query_row("SELECT 1 FROM image WHERE id = ?1", [image_id], |_| Ok(()))
        .optional()?
        .ok_or(Error::UnknownImage)
}
