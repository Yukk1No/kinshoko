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
