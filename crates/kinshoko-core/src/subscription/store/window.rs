//! 最近若干张的窗口：第一次检查定下，之后的检查与重试都按它收。

use rusqlite::{OptionalExtension, params};

use super::{Store, StoreError};

/// 最近若干张定下的窗口。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(in crate::subscription) struct Window {
    /// 发布时间早于它的作品不收。
    pub(in crate::subscription) since: i64,
    /// 数到的最后一个作品与它只收的页数（没截断时为空）。
    pub(in crate::subscription) boundary: Option<(String, u32)>,
    /// 发布时间正好是 `since`、但没数进窗口的作品。
    pub(in crate::subscription) excluded: Vec<String>,
}

impl Store {
    /// 定下最近若干张的窗口。
    pub(in crate::subscription) fn set_window(
        &self,
        id: &str,
        window: &Window,
    ) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE subscription SET since = ?2, boundary_work = ?3, boundary_pages = ?4,
                                     cutoff_excluded = ?5
             WHERE id = ?1",
            params![
                id,
                window.since,
                window.boundary.as_ref().map(|(work, _)| work),
                window.boundary.as_ref().map(|(_, pages)| pages),
                serde_json::to_string(&window.excluded).expect("作品 id 可以序列化")
            ],
        )?;
        Ok(())
    }

    /// 定下的窗口；没定过时边界与排除的作品都为空。
    pub(in crate::subscription) fn window(&self, id: &str) -> Result<Window, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT since, boundary_work, boundary_pages, cutoff_excluded FROM subscription
                 WHERE id = ?1",
                [id],
                |r| {
                    let boundary = match (r.get::<_, Option<String>>(1)?, r.get(2)?) {
                        (Some(work), Some(pages)) => Some((work, pages)),
                        _ => None,
                    };
                    Ok(Window {
                        since: r.get::<_, Option<i64>>(0)?.unwrap_or(i64::MIN),
                        boundary,
                        excluded: r
                            .get::<_, Option<String>>(3)?
                            .and_then(|e| serde_json::from_str(&e).ok())
                            .unwrap_or_default(),
                    })
                },
            )
            .optional()?
            .unwrap_or_default())
    }
}
