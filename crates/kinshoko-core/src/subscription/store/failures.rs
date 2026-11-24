//! 没收成的作品：下次重试，失败太多次的放弃。

use rusqlite::{OptionalExtension, params};

use super::{MAX_ATTEMPTS, Store, StoreError};
use crate::subscription::SourceId;

impl Store {
    /// 这条订阅有没收成、还要重试的作品。
    pub(in crate::subscription) fn has_failed(
        &self,
        subscription_id: &str,
    ) -> Result<bool, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT 1 FROM failed_work WHERE subscription_id = ?1 AND attempts < ?2 LIMIT 1",
                params![subscription_id, MAX_ATTEMPTS],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// 这个作品已失败到上限，不再下载。
    pub(in crate::subscription) fn gave_up(
        &self,
        subscription_id: &str,
        source: SourceId,
        work_id: &str,
    ) -> Result<bool, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT 1 FROM failed_work
                 WHERE subscription_id = ?1 AND source = ?2 AND work_id = ?3 AND attempts >= ?4",
                params![subscription_id, source.as_str(), work_id, MAX_ATTEMPTS],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// 记下一次没收成；返回累计失败次数。
    pub(in crate::subscription) fn record_failure(
        &self,
        subscription_id: &str,
        source: SourceId,
        work_id: &str,
    ) -> Result<u32, StoreError> {
        Ok(self.conn().query_row(
            "INSERT INTO failed_work (subscription_id, source, work_id, attempts)
             VALUES (?1, ?2, ?3, 1)
             ON CONFLICT DO UPDATE SET attempts = attempts + 1
             RETURNING attempts",
            params![subscription_id, source.as_str(), work_id],
            |r| r.get(0),
        )?)
    }

    /// 记下待收的作品（收藏夹第一次检查选上的）：同没收成的作品一样，下次翻到底把它们找回来，处理完再清掉。
    pub(in crate::subscription) fn add_pending<'a>(
        &self,
        subscription_id: &str,
        source: SourceId,
        work_ids: impl IntoIterator<Item = &'a str>,
    ) -> Result<(), StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT OR IGNORE INTO failed_work (subscription_id, source, work_id, attempts)
                 VALUES (?1, ?2, ?3, 0)",
            )?;
            for work_id in work_ids {
                stmt.execute(params![subscription_id, source.as_str(), work_id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub(in crate::subscription) fn clear_failure(
        &self,
        subscription_id: &str,
        source: SourceId,
        work_id: &str,
    ) -> Result<(), StoreError> {
        self.conn().execute(
            "DELETE FROM failed_work WHERE subscription_id = ?1 AND source = ?2 AND work_id = ?3",
            params![subscription_id, source.as_str(), work_id],
        )?;
        Ok(())
    }
}
