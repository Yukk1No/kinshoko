//! 打标进度（#52、#475）：按模型来源记下每张参考图打没打过。没有记录的图就是待打标的图；打不上标的图
//! 分两类记下原因：无法解码的只在画师手动重试时再打，反复让打标子进程崩溃的下次启动时重试一次。

use rusqlite::params;

use super::rating::require_image;
use super::tags::FactSource;
use super::{Error, Inner, now_ms};

/// 一张图的打标结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaggingOutcome {
    /// 建议已写入。
    Done,
    /// 这张图无法解码，附原因；只有画师手动重试时才再打（[`RetryTagging::AllFailed`]）。
    BadImage(String),
    /// 这张图反复让打标子进程崩溃，附原因。不一定怪这张图（驱动或子进程的偶发故障），
    /// 下次启动时重试一次（[`RetryTagging::CrashedOnly`]）。
    Crashed(String),
}

/// 让哪些打不上标的图重新成为待打标的图（#475）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryTagging {
    /// 只重试反复崩溃的图：启动时自动重试用。
    CrashedOnly,
    /// 两类都重试：画师手动重试用。
    AllFailed,
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

pub(super) fn count_images_to_tag(inner: &Inner, source: &FactSource) -> Result<u32, Error> {
    let conn = inner.readers.get();
    let count = conn.query_row(
        "SELECT COUNT(*) FROM image i
         WHERE i.deleted_at IS NULL AND NOT EXISTS (
            SELECT 1 FROM tagging_state s WHERE s.image_id = i.id AND s.source = ?1)",
        [source.as_str()],
        |r| r.get(0),
    )?;
    Ok(count)
}

/// 反复崩溃时记下的原因以它开头；#475 之前的失败记录靠它分类。
// 不上界面：只记进资料库的打标记录，界面不读
pub(crate) const CRASHED_REASON: &str = "打标子进程在这张图上反复出错";

/// 迁移（#475）：打不上标的图分两类。`failure` 只在 `status = 'failed'` 的行有值：`bad_image` 无法解码，
/// 只在画师手动重试时再打；`crashed` 反复让打标子进程崩溃，不一定怪这张图，下次启动时重试一次。
/// 之前的失败只有原因文字，按 [`CRASHED_REASON`] 前缀分类。可以重跑：列已经在时只补分类。
pub(super) fn add_tagging_failure(tx: &rusqlite::Transaction) -> rusqlite_migration::HookResult {
    let has_column = tx
        .prepare("SELECT 1 FROM pragma_table_info('tagging_state') WHERE name = 'failure'")?
        .exists([])?;
    if !has_column {
        tx.execute_batch(
            "ALTER TABLE tagging_state
             ADD COLUMN failure TEXT CHECK (failure IN ('bad_image', 'crashed'))",
        )?;
    }
    tx.execute(
        "UPDATE tagging_state
         SET failure = CASE WHEN reason LIKE ?1 || '%' THEN 'crashed' ELSE 'bad_image' END
         WHERE status = 'failed' AND failure IS NULL",
        [CRASHED_REASON],
    )?;
    Ok(())
}

pub(super) fn count_failed_tagging(inner: &Inner, source: &FactSource) -> Result<u32, Error> {
    let conn = inner.readers.get();
    let count = conn.query_row(
        "SELECT COUNT(*) FROM tagging_state s JOIN image i ON i.id = s.image_id
         WHERE s.source = ?1 AND s.status = 'failed' AND i.deleted_at IS NULL",
        [source.as_str()],
        |r| r.get(0),
    )?;
    Ok(count)
}

pub(super) fn retry_failed_tagging(
    inner: &Inner,
    source: &FactSource,
    which: RetryTagging,
) -> Result<u32, Error> {
    let source = source.clone();
    inner.writer.run(move |conn| {
        let sql = match which {
            RetryTagging::CrashedOnly => {
                "DELETE FROM tagging_state
                 WHERE source = ?1 AND status = 'failed' AND failure = 'crashed'"
            }
            RetryTagging::AllFailed => {
                "DELETE FROM tagging_state WHERE source = ?1 AND status = 'failed'"
            }
        };
        let cleared = conn.execute(sql, [source.as_str()])?;
        Ok::<_, Error>(u32::try_from(cleared).unwrap_or(u32::MAX))
    })
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

pub(super) fn record_tagging_in(
    tx: &rusqlite::Transaction,
    source: &FactSource,
    id: &str,
    outcome: &TaggingOutcome,
) -> Result<(), Error> {
    require_image(tx, id)?;
    let (status, failure, reason) = match outcome {
        TaggingOutcome::Done => ("done", None, None),
        TaggingOutcome::BadImage(reason) => ("failed", Some("bad_image"), Some(reason.as_str())),
        TaggingOutcome::Crashed(reason) => ("failed", Some("crashed"), Some(reason.as_str())),
    };
    tx.execute(
        "INSERT INTO tagging_state (image_id, source, status, failure, reason, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (image_id, source)
         DO UPDATE SET status = excluded.status, failure = excluded.failure,
                       reason = excluded.reason, at = excluded.at",
        params![id, source.as_str(), status, failure, reason, now_ms()],
    )?;
    Ok(())
}
