//! 改了收进的资料库以后，留在旧库的已收作品与把它们记到新库（#461）。

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{Store, StoreError};

/// 一条订阅收进旧库、还没移到现在这个库的一页。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OldPage {
    pub subscription_id: String,
    /// 这一页现在所在的库。
    pub library_id: String,
    /// 订阅现在收进的库。
    pub target_library_id: String,
    pub source: String,
    pub work_id: String,
    pub page: u32,
    pub image_id: String,
    /// 现在的库里已经记着这个作品（别的订阅或亲手收过），这个作品不能移过去。
    pub blocked: bool,
}

/// 移到新库的一个作品，也是撤销的依据。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MovedWork {
    pub subscription_id: String,
    pub source: String,
    pub work_id: String,
    pub from_library_id: String,
    pub to_library_id: String,
    pub pages: Vec<MovedPage>,
}

/// 移到新库的一页。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MovedPage {
    pub page: u32,
    pub from_image_id: String,
    pub to_image_id: String,
    /// 新库的这张图是这次移过来才有的（不是和新库已有的图合并）。
    pub created: bool,
    /// 新库的这张图原来在回收站里，这次恢复了；撤销时放回回收站。
    pub restored: bool,
    /// 新库的这张图原来就有这个作品的来源；撤销时不去掉。
    pub layer_existed: bool,
}

impl MovedWork {
    /// 反过来：撤销时把记录移回去。
    pub fn reversed(&self) -> MovedWork {
        MovedWork {
            subscription_id: self.subscription_id.clone(),
            source: self.source.clone(),
            work_id: self.work_id.clone(),
            from_library_id: self.to_library_id.clone(),
            to_library_id: self.from_library_id.clone(),
            pages: self
                .pages
                .iter()
                .map(|p| MovedPage {
                    page: p.page,
                    from_image_id: p.to_image_id.clone(),
                    to_image_id: p.from_image_id.clone(),
                    created: p.created,
                    restored: p.restored,
                    layer_existed: p.layer_existed,
                })
                .collect(),
        }
    }
}

impl Store {
    /// 还有订阅记录的页指着这张图。
    pub fn image_in_use(&self, library_id: &str, image_id: &str) -> Result<bool, StoreError> {
        Ok(self.conn().query_row(
            "SELECT EXISTS (SELECT 1 FROM received_page WHERE library_id = ?1 AND image_id = ?2)",
            params![library_id, image_id],
            |row| row.get(0),
        )?)
    }

    /// `ids` 这几条订阅收进别的库（不是现在收进的库）的页，按订阅、库、作品、页排。
    pub fn old_pages(&self, ids: &[String]) -> Result<Vec<OldPage>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT w.subscription_id, p.library_id, s.library_id, p.source, p.work_id, p.page,
                    p.image_id,
                    EXISTS (SELECT 1 FROM received_work o
                            WHERE o.library_id = s.library_id AND o.source = p.source
                              AND o.work_id = p.work_id)
                 OR EXISTS (SELECT 1 FROM received_page o
                            WHERE o.library_id = s.library_id AND o.source = p.source
                              AND o.work_id = p.work_id)
             FROM subscription s
             JOIN received_work w ON w.subscription_id = s.id AND w.library_id != s.library_id
             JOIN received_page p
               ON p.library_id = w.library_id AND p.source = w.source AND p.work_id = w.work_id
             WHERE s.id = ?1 AND w.outcome = 'collected'
             ORDER BY p.library_id, p.source, p.work_id, p.page",
        )?;
        let mut out = Vec::new();
        for id in ids {
            let rows = stmt.query_map([id], |row| {
                Ok(OldPage {
                    subscription_id: row.get(0)?,
                    library_id: row.get(1)?,
                    target_library_id: row.get(2)?,
                    source: row.get(3)?,
                    work_id: row.get(4)?,
                    page: row.get(5)?,
                    image_id: row.get(6)?,
                    blocked: row.get(7)?,
                })
            })?;
            for row in rows {
                out.push(row?);
            }
        }
        Ok(out)
    }

    /// 把这些作品的记录从旧库改到新库，一起改或都不改。新库里已经记着同一个作品时不改，
    /// 返回 [`StoreError::AlreadyReceived`]；旧库里已经没有这条记录（又移过）时返回
    /// [`StoreError::MovedElsewhere`]。
    pub fn move_works(&self, works: &[MovedWork]) -> Result<(), StoreError> {
        self.move_works_in(works, true)
    }

    /// 核对 [`Store::move_works`] 能不能做，不改记录。
    pub fn check_move_works(&self, works: &[MovedWork]) -> Result<(), StoreError> {
        self.move_works_in(works, false)
    }

    fn move_works_in(&self, works: &[MovedWork], commit: bool) -> Result<(), StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for work in works {
            let taken: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM received_work WHERE library_id = ?1 AND source = ?2 AND work_id = ?3
                     UNION SELECT 1 FROM received_page
                     WHERE library_id = ?1 AND source = ?2 AND work_id = ?3",
                    params![work.to_library_id, work.source, work.work_id],
                    |row| row.get(0),
                )
                .optional()?;
            if taken.is_some() {
                return Err(StoreError::AlreadyReceived);
            }
            let there: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM received_work
                                WHERE library_id = ?1 AND source = ?2 AND work_id = ?3
                                  AND subscription_id = ?4)",
                params![
                    work.from_library_id,
                    work.source,
                    work.work_id,
                    work.subscription_id
                ],
                |row| row.get(0),
            )?;
            if !there {
                return Err(StoreError::MovedElsewhere);
            }
            // 页也得和记下时一样：之后又收了几页、或页换了图，这条记录作废，免得作品和页分在两个库。
            let live: Vec<(u32, String)> = {
                let mut stmt = tx.prepare_cached(
                    "SELECT page, image_id FROM received_page
                     WHERE library_id = ?1 AND source = ?2 AND work_id = ?3 ORDER BY page",
                )?;
                stmt.query_map(
                    params![work.from_library_id, work.source, work.work_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?
                .collect::<Result<_, _>>()?
            };
            let mut expected: Vec<(u32, String)> = work
                .pages
                .iter()
                .map(|p| (p.page, p.from_image_id.clone()))
                .collect();
            expected.sort();
            if live != expected {
                return Err(StoreError::MovedElsewhere);
            }
            tx.execute(
                "UPDATE received_work SET library_id = ?4
                 WHERE library_id = ?1 AND source = ?2 AND work_id = ?3",
                params![
                    work.from_library_id,
                    work.source,
                    work.work_id,
                    work.to_library_id
                ],
            )?;
            for page in &work.pages {
                tx.execute(
                    "UPDATE received_page SET library_id = ?5, image_id = ?6
                     WHERE library_id = ?1 AND source = ?2 AND work_id = ?3 AND page = ?4",
                    params![
                        work.from_library_id,
                        work.source,
                        work.work_id,
                        page.page,
                        work.to_library_id,
                        page.to_image_id
                    ],
                )?;
            }
        }
        if commit {
            tx.commit()?;
        }
        Ok(())
    }
}
