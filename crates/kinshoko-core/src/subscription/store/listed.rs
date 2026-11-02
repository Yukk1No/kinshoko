//! 收藏夹列出过的作品（#371）：检查翻到它们就停，比它们近的才是新收藏。

use std::collections::HashSet;

use rusqlite::{OptionalExtension, params};

use super::{MAX_ATTEMPTS, Store, StoreError};

impl Store {
    /// 这条订阅列出过这个作品。
    pub(in crate::subscription) fn listed(
        &self,
        subscription_id: &str,
        work_id: &str,
    ) -> Result<bool, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT 1 FROM listed_work WHERE subscription_id = ?1 AND work_id = ?2",
                params![subscription_id, work_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// 这条收藏流列出过作品。
    pub(in crate::subscription) fn feed_listed(
        &self,
        subscription_id: &str,
        feed: usize,
    ) -> Result<bool, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT 1 FROM listed_work WHERE subscription_id = ?1 AND feed = ?2 LIMIT 1",
                params![subscription_id, feed as i64],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// 记下列出过的作品。已记过的留着原来的流。
    pub(in crate::subscription) fn mark_listed<'a>(
        &self,
        subscription_id: &str,
        feed: usize,
        work_ids: impl IntoIterator<Item = &'a str>,
    ) -> Result<(), StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT OR IGNORE INTO listed_work (subscription_id, work_id, feed)
                 VALUES (?1, ?2, ?3)",
            )?;
            for work_id in work_ids {
                stmt.execute(params![subscription_id, work_id, feed as i64])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// 收藏夹第一次检查已定下基线。
    pub(in crate::subscription) fn bookmarks_baseline(
        &self,
        subscription_id: &str,
    ) -> Result<bool, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT bookmarks_baseline_at IS NOT NULL FROM subscription WHERE id = ?1",
                [subscription_id],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(false))
    }

    pub(in crate::subscription) fn set_bookmarks_baseline(
        &self,
        subscription_id: &str,
        at: i64,
    ) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE subscription SET bookmarks_baseline_at = ?2 WHERE id = ?1",
            params![subscription_id, at],
        )?;
        Ok(())
    }

    /// 记下某个作品只收前几页（最近若干张数到的最后一个作品）。
    pub(in crate::subscription) fn set_page_limit(
        &self,
        subscription_id: &str,
        work_id: &str,
        pages: u32,
    ) -> Result<(), StoreError> {
        self.conn().execute(
            "INSERT OR REPLACE INTO page_limit (subscription_id, work_id, pages)
             VALUES (?1, ?2, ?3)",
            params![subscription_id, work_id, pages],
        )?;
        Ok(())
    }

    /// 某个作品只收前几页；没有限制时为空。
    pub(in crate::subscription) fn page_limit(
        &self,
        subscription_id: &str,
        work_id: &str,
    ) -> Result<Option<u32>, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT pages FROM page_limit WHERE subscription_id = ?1 AND work_id = ?2",
                params![subscription_id, work_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// 这条订阅没收成、还要重试的作品。
    pub(in crate::subscription) fn retry_works(
        &self,
        subscription_id: &str,
    ) -> Result<HashSet<String>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT work_id FROM failed_work WHERE subscription_id = ?1 AND attempts < ?2",
        )?;
        let ids = stmt.query_map(params![subscription_id, MAX_ATTEMPTS], |r| r.get(0))?;
        Ok(ids.collect::<Result<_, _>>()?)
    }
}
