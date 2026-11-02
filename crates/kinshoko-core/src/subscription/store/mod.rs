//! 订阅名单与已收作品，存在本设备数据目录的 `subscriptions.db`。

use std::collections::HashSet;
use std::fmt;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use rusqlite_migration::{M, Migrations};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{Backlog, NewSubscription, SourceError, SourceId, Subscription, Target};

mod failures;
mod listed;
mod window;

pub(super) use window::Window;

const FILE: &str = "subscriptions.db";
/// 一个作品失败这么多次后不再重试，也不再让来源为它翻到底。
const MAX_ATTEMPTS: u32 = 5;

fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(include_str!("../migrations/0368_subscription.sql")),
        M::up(include_str!("../migrations/0369_backlog.sql")),
        M::up(include_str!("../migrations/0371_bookmarks.sql")),
    ])
}

#[derive(Debug)]
pub enum StoreError {
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
    Migration(rusqlite_migration::Error),
    /// 没有这条订阅（已被删掉）。
    UnknownSubscription,
}

// 不上界面：领域错误交给界面时转成错误代码（command_error），Display 只进日志
impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Io(e) => write!(f, "订阅记录读写失败：{e}"),
            StoreError::Sqlite(e) => write!(f, "订阅记录读写失败：{e}"),
            StoreError::Migration(e) => write!(f, "订阅记录升级失败：{e}"),
            StoreError::UnknownSubscription => write!(f, "没有这条订阅"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e)
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e)
    }
}

impl From<rusqlite_migration::Error> for StoreError {
    fn from(e: rusqlite_migration::Error) -> Self {
        StoreError::Migration(e)
    }
}

/// 订阅收进来的一张图（一页），订阅页“最近收进来的图”用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReceivedImage {
    pub library_id: String,
    pub image_id: String,
    pub subscription_id: String,
    pub work_id: String,
    pub page: u32,
    /// 来源把作品标为成人内容；安全模式开着时订阅页不显示。
    pub explicit: bool,
    /// 画师还没在订阅页看过。
    pub new: bool,
    #[ts(type = "number")]
    pub received_at: i64,
}

/// 一个作品的收取结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Outcome {
    Collected,
    /// 动图（ugoira）不收，记下来不再看它。
    SkippedAnimation,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Outcome::Collected => "collected",
            Outcome::SkippedAnimation => "skippedAnimation",
        }
    }
}

/// 一个已收作品的身份：哪个资料库的哪个来源作品。
pub(super) struct WorkKey<'a> {
    pub(super) library_id: &'a str,
    pub(super) source: SourceId,
    pub(super) work_id: &'a str,
}

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    /// 打开 `dir/subscriptions.db`；没有时新建。
    pub fn open(dir: &Path) -> Result<Store, StoreError> {
        std::fs::create_dir_all(dir)?;
        let mut conn = Connection::open(dir.join(FILE))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrations().to_latest(&mut conn)?;
        Ok(Store {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 新建一条订阅。只收新作时，发布时间早于现在的作品一律不收；榜单不看发布时间，
    /// 每次收当时榜上的前若干名；收藏夹也不看发布时间，按收藏先后认新收藏（见 `listed_work`）。
    pub fn add(&self, new: NewSubscription, now: i64) -> Result<Subscription, StoreError> {
        let since = match (&new.target, new.backlog) {
            (Target::PixivRanking { .. } | Target::PixivBookmarks, _) => None,
            (_, Backlog::NewOnly) => Some(now),
            (_, Backlog::Recent { .. } | Backlog::All) => None,
        };
        let subscription = Subscription {
            id: uuid::Uuid::now_v7().simple().to_string(),
            target: new.target,
            name: new.name,
            library_id: new.library_id,
            include_explicit: new.include_explicit,
            include_manga: new.include_manga,
            backlog: new.backlog,
            private_backlog: new.private_backlog,
            since,
            skipped: 0,
            created_at: now,
            last_checked_at: None,
            last_error: None,
            last_failed_at: None,
        };
        self.conn().execute(
            "INSERT INTO subscription (id, source, target, name, library_id, include_explicit,
                                       include_manga, backlog, since, created_at, private_backlog)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                subscription.id,
                subscription.target.source().as_str(),
                serde_json::to_string(&subscription.target).expect("订阅对象可以序列化"),
                subscription.name,
                subscription.library_id,
                subscription.include_explicit,
                subscription.include_manga,
                serde_json::to_string(&subscription.backlog).expect("旧作选项可以序列化"),
                subscription.since,
                now,
                subscription
                    .private_backlog
                    .map(|b| serde_json::to_string(&b).expect("旧作选项可以序列化"))
            ],
        )?;
        Ok(subscription)
    }

    /// 删掉一条订阅。已收作品的记录保留：重新订阅也不会把删掉的图再下回来。收藏夹列出过的作品
    /// 不留：重新同步时按那时选的旧收藏重新定。
    pub fn remove(&self, id: &str) -> Result<(), StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let removed = tx.execute("DELETE FROM subscription WHERE id = ?1", [id])?;
        tx.execute("DELETE FROM listed_work WHERE subscription_id = ?1", [id])?;
        tx.execute("DELETE FROM page_limit WHERE subscription_id = ?1", [id])?;
        tx.commit()?;
        match removed {
            0 => Err(StoreError::UnknownSubscription),
            _ => Ok(()),
        }
    }

    /// 全部订阅，按建立先后。认不出的行（新版本写的来源或对象）略过。
    pub fn list(&self) -> Result<Vec<Subscription>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT id, source, target, name, library_id, include_explicit, include_manga,
                    created_at, last_checked_at, last_error, last_failed_at, backlog, since,
                    private_backlog,
                    (SELECT COUNT(*) FROM received_work w
                     WHERE w.subscription_id = subscription.id AND w.outcome = 'skippedAnimation')
             FROM subscription ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                Subscription {
                    id: r.get(0)?,
                    target: Target::PixivBookmarks,
                    name: r.get(3)?,
                    library_id: r.get(4)?,
                    include_explicit: r.get(5)?,
                    include_manga: r.get(6)?,
                    backlog: r
                        .get::<_, String>(11)
                        .ok()
                        .and_then(|b| serde_json::from_str(&b).ok())
                        .unwrap_or(Backlog::All),
                    private_backlog: r
                        .get::<_, Option<String>>(13)?
                        .and_then(|b| serde_json::from_str(&b).ok()),
                    since: r.get(12)?,
                    skipped: r.get(14)?,
                    created_at: r.get(7)?,
                    last_checked_at: r.get(8)?,
                    last_error: r
                        .get::<_, Option<String>>(9)?
                        .and_then(|e| serde_json::from_str(&e).ok()),
                    last_failed_at: r.get(10)?,
                },
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (source, target, mut subscription) = row?;
            let Some(target) =
                SourceId::parse(&source).and_then(|_| serde_json::from_str::<Target>(&target).ok())
            else {
                continue;
            };
            subscription.target = target;
            out.push(subscription);
        }
        Ok(out)
    }

    /// 这条订阅还在（没被退订）。
    pub fn exists(&self, id: &str) -> Result<bool, StoreError> {
        Ok(self
            .conn()
            .query_row("SELECT 1 FROM subscription WHERE id = ?1", [id], |_| Ok(()))
            .optional()?
            .is_some())
    }

    pub fn get(&self, id: &str) -> Result<Subscription, StoreError> {
        self.list()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or(StoreError::UnknownSubscription)
    }

    /// 改订阅的漫画与成人作品选项；`top` 给了时还改榜单的名次（不是榜单时不管它）。资料库、
    /// 旧作与哪个榜单是订阅时定的，不再改。名次改小时已收的图留着（#366 不做自动清理）。
    pub fn set_options(
        &self,
        id: &str,
        include_explicit: bool,
        include_manga: bool,
        top: Option<u32>,
    ) -> Result<Subscription, StoreError> {
        let mut target = self.get(id)?.target;
        if let (Target::PixivRanking { top: current, .. }, Some(top)) = (&mut target, top) {
            *current = top;
        }
        // 先放开连接再读回来：`get` 也要它。
        let changed = self.conn().execute(
            "UPDATE subscription SET include_explicit = ?2, include_manga = ?3, target = ?4
             WHERE id = ?1",
            params![
                id,
                include_explicit,
                include_manga,
                serde_json::to_string(&target).expect("订阅对象可以序列化")
            ],
        )?;
        match changed {
            0 => Err(StoreError::UnknownSubscription),
            _ => self.get(id),
        }
    }

    /// 记下一次检查完成的时间。
    pub fn mark_checked(&self, id: &str, at: i64) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE subscription SET last_checked_at = ?2, last_error = NULL, last_failed_at = NULL
             WHERE id = ?1",
            params![id, at],
        )?;
        Ok(())
    }

    /// 记下检查没完成的原因；检查时间不变，下次照常到期。
    pub fn note_error(&self, id: &str, error: &SourceError, at: i64) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE subscription SET last_error = ?2, last_failed_at = ?3 WHERE id = ?1",
            params![
                id,
                serde_json::to_string(error).expect("检查错误可以序列化"),
                at
            ],
        )?;
        Ok(())
    }

    pub(super) fn is_received(&self, key: &WorkKey<'_>) -> Result<bool, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT 1 FROM received_work WHERE library_id = ?1 AND source = ?2 AND work_id = ?3",
                params![key.library_id, key.source.as_str(), key.work_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// 这条订阅自己收过（或跳过）这个作品：来源可以在这里停止翻页。别的订阅收进同一个资料库的
    /// 作品不算，免得新订阅一开始就停在别人收过的作品上。
    pub(super) fn received_by(
        &self,
        subscription_id: &str,
        key: &WorkKey<'_>,
    ) -> Result<bool, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT 1 FROM received_work
                 WHERE library_id = ?1 AND source = ?2 AND work_id = ?3 AND subscription_id = ?4",
                params![
                    key.library_id,
                    key.source.as_str(),
                    key.work_id,
                    subscription_id
                ],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    pub(super) fn received_pages(&self, key: &WorkKey<'_>) -> Result<HashSet<u32>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT page FROM received_page WHERE library_id = ?1 AND source = ?2 AND work_id = ?3",
        )?;
        let pages = stmt.query_map(
            params![key.library_id, key.source.as_str(), key.work_id],
            |r| r.get(0),
        )?;
        Ok(pages.collect::<Result<_, _>>()?)
    }

    pub(super) fn record_page(
        &self,
        key: &WorkKey<'_>,
        page: u32,
        image_id: &str,
        now: i64,
    ) -> Result<(), StoreError> {
        self.conn().execute(
            "INSERT OR REPLACE INTO received_page (library_id, source, work_id, page, image_id,
                                                   received_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                key.library_id,
                key.source.as_str(),
                key.work_id,
                page,
                image_id,
                now
            ],
        )?;
        Ok(())
    }

    pub(super) fn record_work(
        &self,
        key: &WorkKey<'_>,
        subscription_id: &str,
        outcome: Outcome,
        explicit: bool,
        now: i64,
    ) -> Result<(), StoreError> {
        self.conn().execute(
            "INSERT OR IGNORE INTO received_work (library_id, source, work_id, subscription_id,
                                                  outcome, explicit, received_at, seen)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                key.library_id,
                key.source.as_str(),
                key.work_id,
                subscription_id,
                outcome.as_str(),
                explicit,
                now,
                // 跳过的作品没有新图。
                outcome != Outcome::Collected
            ],
        )?;
        Ok(())
    }

    /// 新图数量：收进来、画师还没在订阅页看过的图（按页计）。`include_explicit` 为假时不计成人作品
    /// （安全模式开着时，入口与托盘上的数量也不透露它们）。
    pub fn new_count(&self, include_explicit: bool) -> Result<u32, StoreError> {
        Ok(self.conn().query_row(
            "SELECT COUNT(*) FROM received_page p
             JOIN received_work w USING (library_id, source, work_id)
             WHERE w.seen = 0 AND w.outcome = 'collected' AND (?1 OR w.explicit = 0)",
            [include_explicit],
            |r| r.get(0),
        )?)
    }

    /// 画师看过了订阅页：全部新图标为已看。
    pub fn mark_seen(&self) -> Result<(), StoreError> {
        self.conn()
            .execute("UPDATE received_work SET seen = 1 WHERE seen = 0", [])?;
        Ok(())
    }

    /// 最近收进来的图，从新到旧。
    pub fn recent(&self, limit: u32) -> Result<Vec<ReceivedImage>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT p.library_id, p.image_id, w.subscription_id, p.work_id, p.page, w.explicit,
                    w.seen = 0, p.received_at
             FROM received_page p
             JOIN received_work w USING (library_id, source, work_id)
             WHERE w.outcome = 'collected'
             ORDER BY p.received_at DESC, p.work_id DESC, p.page
             LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |r| {
            Ok(ReceivedImage {
                library_id: r.get(0)?,
                image_id: r.get(1)?,
                subscription_id: r.get(2)?,
                work_id: r.get(3)?,
                page: r.get(4)?,
                explicit: r.get(5)?,
                new: r.get(6)?,
                received_at: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// 某个来源的退避：到 `until` 之前不检查。
    pub fn backoff(&self, source: SourceId) -> Result<Option<(i64, u32)>, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT until, level FROM backoff WHERE source = ?1",
                [source.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }

    pub fn set_backoff(&self, source: SourceId, until: i64, level: u32) -> Result<(), StoreError> {
        self.conn().execute(
            "INSERT OR REPLACE INTO backoff (source, until, level) VALUES (?1, ?2, ?3)",
            params![source.as_str(), until, level],
        )?;
        Ok(())
    }

    pub fn clear_backoff(&self, source: SourceId) -> Result<(), StoreError> {
        self.conn()
            .execute("DELETE FROM backoff WHERE source = ?1", [source.as_str()])?;
        Ok(())
    }
}
