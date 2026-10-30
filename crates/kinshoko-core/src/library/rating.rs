//! 内容分级与打标子接口（#52）。
//!
//! - 分级建议按来源分层（[`FactSource`]），和标签事实同一规则：某个来源重写只替换自己那一行。
//!   人工分级（#53，`image.rating_manual`）优先于建议；没有人工分级时，有效分级是各来源建议中
//!   最严格的一档。
//! - 有效分级只在 [`effective_rank_sql`] 定义：[`image_rating`] 的 `effective` 与安全模式（#60）的
//!   封印都由它算出，人工分级接进这里就同时作用于两者。
//! - 被封印只有一条判定（#223）：安全模式开启，且有效分级在安全模式范围（[`SafeModeScope`]）内。
//!   SQL 里用 [`in_scope_sql`]，内存里用 [`SafeMode::seals`]；不允许别处写死“≥ 敏感”。
//! - 打标进度按模型来源记录：没有记录的图就是待打标的图；无法打标的图记下原因，不再重试。
//! - 一次成功推理的模型标签、分级建议与完成状态只经 [`commit_tagging_result`] 在同一个事务里
//!   提交（#318）：要么整份结果连同完成状态都在，要么都不在。

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::events::LibraryEvent;
use super::tags::{self, FactSource};
use super::{Error, Inner, fault, now_ms};

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

    /// 档位：`general` 0 … `explicit` 3，与 [`effective_rank_sql`] 相同。
    pub(super) fn rank(self) -> i64 {
        self as i64
    }

    pub(crate) fn from_rank(rank: i64) -> Option<ContentRating> {
        Some(match rank {
            0 => ContentRating::General,
            1 => ContentRating::Sensitive,
            2 => ContentRating::Questionable,
            3 => ContentRating::Explicit,
            _ => return None,
        })
    }

    /// 是否含成人内容（questionable 与 explicit，术语表“内容分级”的后两档）。只是分级的性质，
    /// 不是封印的判定：封印看安全模式范围（[`SafeMode::seals`]）。
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

/// 安全模式范围（#223）：安全模式从哪一档内容分级开始作用，直到最严的“成人”。是本设备的
/// 应用设置，不随资料库走。不能从“全年龄”开始。
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS,
)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SafeModeScope {
    /// 轻度及以上。
    Sensitive,
    /// 敏感及以上（默认）。
    #[default]
    Questionable,
    /// 仅成人。
    Explicit,
}

impl SafeModeScope {
    /// 可选的各范围，从宽到严。
    pub const ALL: [SafeModeScope; 3] = [
        SafeModeScope::Sensitive,
        SafeModeScope::Questionable,
        SafeModeScope::Explicit,
    ];

    /// 起点是 `start` 的范围；“全年龄”不能作起点。
    pub(crate) fn from_start(start: ContentRating) -> Option<SafeModeScope> {
        Self::ALL.into_iter().find(|scope| scope.start() == start)
    }

    /// 范围的起点，即范围内最宽的一档。
    pub fn start(self) -> ContentRating {
        match self {
            SafeModeScope::Sensitive => ContentRating::Sensitive,
            SafeModeScope::Questionable => ContentRating::Questionable,
            SafeModeScope::Explicit => ContentRating::Explicit,
        }
    }

    /// 这一档在范围内。
    pub fn covers(self, rating: ContentRating) -> bool {
        rating >= self.start()
    }

    /// 范围内的各档，从宽到严：查找时“R18”代表的分级。
    pub fn ratings(self) -> Vec<ContentRating> {
        Self::ALL
            .into_iter()
            .map(SafeModeScope::start)
            .filter(|r| self.covers(*r))
            .collect()
    }

    /// 换成 `next` 是收紧（范围变大）：之前确认显示的钉图要重新遮蔽。
    pub fn tightened_by(self, next: SafeModeScope) -> bool {
        next.start() < self.start()
    }
}

/// 一个视角下的安全模式：开关与范围。被封印 = 开启且有效分级在范围内。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct SafeMode {
    pub on: bool,
    pub scope: SafeModeScope,
}

impl SafeMode {
    pub fn new(on: bool, scope: SafeModeScope) -> SafeMode {
        SafeMode { on, scope }
    }

    /// 这个有效分级的图被封印。还没有分级的图不被封印（核对不了的钉图另按封印处理）。
    pub fn seals(self, effective: Option<ContentRating>) -> bool {
        self.on && effective.is_some_and(|r| self.scope.covers(r))
    }

    /// 编成一个字节，供原子变量与游标、令牌使用。
    pub(crate) fn encode(self) -> u8 {
        (u8::from(self.on) << 7) | self.scope.start() as u8
    }

    pub(crate) fn decode(byte: u8) -> Option<SafeMode> {
        let scope = SafeModeScope::from_start(ContentRating::from_rank(i64::from(byte & 0x7f))?)?;
        Some(SafeMode {
            on: byte & 0x80 != 0,
            scope,
        })
    }
}

/// 只给开关时用默认范围。仅为调用方便（测试与只关心开关的地方），应用壳按设置给出范围。
impl From<bool> for SafeMode {
    fn from(on: bool) -> SafeMode {
        SafeMode {
            on,
            scope: SafeModeScope::default(),
        }
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
    /// 画师修正的分级；没有修正（或已退回）时为空。重新打标不覆盖它。
    pub manual: Option<ContentRating>,
    /// 有效分级：人工分级优先，否则是自动分级。
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

/// 模型来源对一张参考图的一次成功推理：标签建议与分级建议，作为一份结果整体提交
/// （[`Library::commit_tagging_result`](super::Library::commit_tagging_result)）。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TaggingResult {
    pub tags: Vec<tags::SourceTag>,
    /// 分级建议；`None` 表示这一层没有建议。
    pub rating: Option<RatingFact>,
}

/// 参考图有效分级的档位（`general` 0 … `explicit` 3），没有分级时为 NULL。
/// `image_id` 是引用参考图 id 的 SQL 表达式（例如 `image.id`）。
///
/// 有效分级的唯一定义：画师的人工分级（`image.rating_manual`，#53）优先，否则取各来源建议中
/// 最严格的一档。
pub(super) fn effective_rank_sql(image_id: &str) -> String {
    let rank = |col: &str| {
        format!(
            "CASE {col} WHEN 'general' THEN 0 WHEN 'sensitive' THEN 1 \
             WHEN 'questionable' THEN 2 WHEN 'explicit' THEN 3 END"
        )
    };
    format!(
        "coalesce((SELECT {} FROM image ri WHERE ri.id = {image_id}), \
         (SELECT max({}) FROM rating_fact rf WHERE rf.image_id = {image_id}))",
        rank("ri.rating_manual"),
        rank("rf.rating"),
    )
}

/// 有效分级在安全模式范围 `scope` 内的条件（安全模式开启时即被封印）。还没有分级的图不算。
pub(super) fn in_scope_sql(image_id: &str, scope: SafeModeScope) -> String {
    format!(
        "coalesce({}, 0) >= {}",
        effective_rank_sql(image_id),
        scope.start().rank()
    )
}

pub(super) fn replace_source_rating(
    inner: &Inner,
    source: &FactSource,
    image_id: &str,
    fact: Option<RatingFact>,
) -> Result<(), Error> {
    let (source, id) = (source.clone(), image_id.to_owned());
    // 按当前的安全模式范围判断是否跨过；范围变化本身另让修订号前进（`Library::set_safe_mode_scope`）。
    let scope = inner.safe().scope;
    let (resealed, revision) = inner.writer.run(move |conn| {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let resealed = replace_source_rating_in(&tx, scope, &source, &id, fact)?;
        // 跨过安全模式范围：安全模式下可见的词表（标签与计数）变了，修订号随之前进。
        let revision = if resealed {
            Some(tags::bump_revision(&tx)?)
        } else {
            None
        };
        tx.commit()?;
        Ok::<_, Error>((resealed, revision))
    })?;
    // 是否在安全模式范围内变了：安全模式下这张图被封印或放出，浏览结果与计数都过期。
    if resealed {
        inner.hub.publish(LibraryEvent::ListStale {
            library_id: inner.info.id.clone(),
        });
    }
    inner.hub.publish(LibraryEvent::ImagesChanged {
        library_id: inner.info.id.clone(),
        image_ids: vec![image_id.to_owned()],
    });
    if let Some(revision) = revision {
        inner.hub.publish(LibraryEvent::VocabularyChanged {
            library_id: inner.info.id.clone(),
            revision,
        });
    }
    Ok(())
}

/// 在调用方的事务里替换一个来源的分级建议。返回这张图是否因此跨过安全模式范围 `scope`；
/// 跨过时列表修订号已前进，词表修订号与事件由调用方负责。
fn replace_source_rating_in(
    tx: &rusqlite::Transaction,
    scope: SafeModeScope,
    source: &FactSource,
    id: &str,
    fact: Option<RatingFact>,
) -> Result<bool, Error> {
    require_image(tx, id)?;
    let in_scope = format!("SELECT {}", in_scope_sql("?1", scope));
    let was_in: bool = tx.query_row(&in_scope, [id], |r| r.get(0))?;
    tx.execute(
        "DELETE FROM rating_fact WHERE image_id = ?1 AND source = ?2",
        params![id, source.as_str()],
    )?;
    if let Some(f) = fact {
        tx.execute(
            "INSERT INTO rating_fact (image_id, source, rating, score) VALUES (?1, ?2, ?3, ?4)",
            params![id, source.as_str(), f.rating.as_str(), f.score],
        )?;
    }
    let is_in: bool = tx.query_row(&in_scope, [id], |r| r.get(0))?;
    let resealed = was_in != is_in;
    if resealed {
        // 安全模式下浏览结果集也变了：旧的分页游标随列表修订号失效（#77 S4）。
        tx.execute("UPDATE list_revision SET value = value + 1", [])?;
    }
    Ok(resealed)
}

/// 提交模型来源 `source` 对一张图的一次成功推理：模型标签、分级建议与完成状态在同一个短事务里
/// 写入并让修订号前进，提交后才推送事件。任何一步失败整个事务回滚：不留下半套结果，也不记完成。
/// 只替换这个来源自己的那一层，人工标签决定、人工分级与其他来源不受影响。
pub(super) fn commit_tagging_result(
    inner: &Inner,
    source: &FactSource,
    image_id: &str,
    result: &TaggingResult,
) -> Result<(), Error> {
    let (source, id, result) = (source.clone(), image_id.to_owned(), result.clone());
    let scope = inner.safe().scope;
    let resealed = tags::write(inner, vec![image_id.to_owned()], move |tx, translations| {
        tags::replace_source_tags_in(tx, translations, &source, &id, &result.tags)?;
        fault::storage(fault::TAGGING_AFTER_TAGS)?;
        let resealed = replace_source_rating_in(tx, scope, &source, &id, result.rating)?;
        fault::storage(fault::TAGGING_AFTER_RATING)?;
        record_tagging_in(tx, &source, &id, &TaggingOutcome::Done)?;
        fault::storage(fault::TAGGING_AFTER_STATE)?;
        Ok(resealed)
    })?;
    if resealed {
        inner.hub.publish(LibraryEvent::ListStale {
            library_id: inner.info.id.clone(),
        });
    }
    Ok(())
}

pub(super) fn image_rating(inner: &Inner, image_id: &str) -> Result<ImageRating, Error> {
    let conn = inner.readers.get();
    inner.require_visible(&conn, image_id)?;
    rating_of(&conn, image_id)
}

/// 一张图的分级：自动、人工与有效（有效分级由 [`effective_rank_sql`] 算出）。
pub(super) fn rating_of(conn: &Connection, image_id: &str) -> Result<ImageRating, Error> {
    let (manual, effective): (Option<String>, Option<i64>) = conn
        .query_row(
            &format!(
                "SELECT rating_manual, {} FROM image WHERE id = ?1",
                effective_rank_sql("?1")
            ),
            [image_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or(Error::UnknownImage)?;
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
        manual: manual.as_deref().and_then(ContentRating::parse),
        effective: effective.and_then(ContentRating::from_rank),
    })
}

/// 设置（`Some`）或退回（`None`）人工分级。返回是否有图因此跨过安全模式范围 `scope`
/// （安全模式下它们被封印或放出，浏览结果与计数都过期）。
pub(super) fn set_manual(
    conn: &Connection,
    ids: &[String],
    rating: Option<ContentRating>,
    scope: SafeModeScope,
) -> Result<bool, Error> {
    let in_scope = format!("SELECT {}", in_scope_sql("?1", scope));
    let mut update = conn.prepare_cached("UPDATE image SET rating_manual = ?1 WHERE id = ?2")?;
    let mut resealed = false;
    for id in ids {
        let was: bool = conn.query_row(&in_scope, [id], |r| r.get(0))?;
        update.execute(params![rating.map(ContentRating::as_str), id])?;
        let is: bool = conn.query_row(&in_scope, [id], |r| r.get(0))?;
        resealed |= was != is;
    }
    Ok(resealed)
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
    let (source, id) = (source.clone(), image_id.to_owned());
    inner.writer.run(move |conn| {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        record_tagging_in(&tx, &source, &id, &outcome)?;
        tx.commit()?;
        Ok::<_, Error>(())
    })
}

fn record_tagging_in(
    tx: &rusqlite::Transaction,
    source: &FactSource,
    id: &str,
    outcome: &TaggingOutcome,
) -> Result<(), Error> {
    require_image(tx, id)?;
    let (status, reason) = match outcome {
        TaggingOutcome::Done => ("done", None),
        TaggingOutcome::Failed(reason) => ("failed", Some(reason.as_str())),
    };
    tx.execute(
        "INSERT INTO tagging_state (image_id, source, status, reason, at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (image_id, source)
         DO UPDATE SET status = excluded.status, reason = excluded.reason, at = excluded.at",
        params![id, source.as_str(), status, reason, now_ms()],
    )?;
    Ok(())
}

fn require_image(tx: &rusqlite::Transaction, image_id: &str) -> Result<(), Error> {
    tx.query_row("SELECT 1 FROM image WHERE id = ?1", [image_id], |_| Ok(()))
        .optional()?
        .ok_or(Error::UnknownImage)
}
