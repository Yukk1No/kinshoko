//! 安全模式（#60）的两种视角（Lens）。
//!
//! - **浏览视角**：[`Library`](super::Library) 自己的读写接口。安全模式开启时，被封印的图
//!   （有效分级含成人内容）不出现在浏览、查找、侧栏计数、词表计数与标签分组中，也看不出
//!   数量；按 id 查看、整理它时当作不存在（[`Error::UnknownImage`]）。
//! - **参考视角**：[`ReferenceLens`]，返回被封印的图并标记需要遮蔽。每个打开的资料库只交出
//!   一次（[`Library::take_reference_lens`](super::Library::take_reference_lens)），由应用壳在
//!   装配时取得、只交给参考组与桌面钉图；之后谁再要都拿不到。
//!
//! 安全模式的开关是全局设置，由应用壳在打开资料库时与切换时设给每个资料库；资料库刚打开时
//! 默认开启，没设之前也不会露出被封印的图。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use ts_rs::TS;

use super::{DisplayFile, Error, Inner, rating, store, thumbnail};

impl Inner {
    pub(super) fn safe_mode(&self) -> bool {
        self.safe_mode.load(Ordering::SeqCst)
    }

    /// 浏览视角的过滤条件（引用 `image`）：安全模式开启时去掉被封印的图。
    pub(super) fn lens_filter(&self) -> String {
        lens_filter(self.safe_mode())
    }

    /// 浏览视角下这张图存在：不存在或被封印时都是 [`Error::UnknownImage`]。
    pub(super) fn require_visible(&self, conn: &Connection, image_id: &str) -> Result<(), Error> {
        require_visible(conn, &self.lens_filter(), image_id)
    }

    /// 只在被封印的图上出现的标签：浏览视角下它们像不存在一样，不出现在词表与标签分组中。
    /// 安全模式关闭时为空。
    pub(super) fn sealed_only_tags(&self, conn: &Connection) -> Result<HashSet<String>, Error> {
        if !self.safe_mode() {
            return Ok(HashSet::new());
        }
        let adult = rating::adult_sql("image.id");
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT e.tag_id FROM effective_tag e JOIN image ON image.id = e.image_id WHERE {adult}
             EXCEPT
             SELECT e.tag_id FROM effective_tag e JOIN image ON image.id = e.image_id
             WHERE NOT ({adult})"
        ))?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

/// 给定安全模式开关时浏览视角的过滤条件（引用 `image`）。
pub(super) fn lens_filter(safe: bool) -> String {
    if safe {
        format!("NOT ({})", rating::adult_sql("image.id"))
    } else {
        "1".to_owned()
    }
}

/// 在给定的浏览视角过滤条件（[`Inner::lens_filter`]）下这张图存在。写线程上的事务用它。
pub(super) fn require_visible(conn: &Connection, lens: &str, image_id: &str) -> Result<(), Error> {
    conn.query_row(
        &format!("SELECT 1 FROM image WHERE image.id = ?1 AND {lens}"),
        [image_id],
        |_| Ok(()),
    )
    .optional()?
    .ok_or(Error::UnknownImage)
}

/// 参考视角下的一张参考图（参考组成员、桌面钉图用）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReferenceImage {
    pub id: String,
    pub width: u32,
    pub height: u32,
    /// 需要遮蔽：安全模式开启且这张图被封印。原位模糊并显示小圆锁，不移走。
    pub sealed: bool,
}

/// 参考视角的句柄：能取得被封印的图，并标记需要遮蔽。只交给参考组与桌面钉图。
#[derive(Clone)]
pub struct ReferenceLens {
    pub(super) inner: Arc<Inner>,
}

impl ReferenceLens {
    /// 只读打开一个未激活的资料库的参考视角（参考组跨库引用，#66）：不对账、不升级、不写数据库，
    /// 与之后作为活动资料库打开的同一个库可以并存（WAL 下只读与写入并发）。`expected_id` 不符时为
    /// [`Error::NotALibrary`]；旧版本写成、还没升级的库为 [`Error::OutdatedLibrary`]。
    /// 安全模式开启（被封印的图标记需要遮蔽），用 [`Self::set_detached_safe_mode`] 跟随设置。
    pub(crate) fn open_detached(root: &Path, expected_id: &str) -> Result<ReferenceLens, Error> {
        let info = super::Library::inspect(root)?;
        if info.id != expected_id {
            return Err(Error::NotALibrary(root.to_path_buf()));
        }
        let db = root.join(store::DB_FILE);
        if !store::is_current(&store::inspect_db(&db)?)? {
            return Err(Error::OutdatedLibrary);
        }
        let readers = store::Readers::open(&db, 1)?;
        Ok(ReferenceLens {
            inner: Arc::new(Inner {
                root: info.root.clone(),
                info,
                writer: store::read_only_writer(&db)?,
                readers,
                hub: Default::default(),
                recovery: Default::default(),
                translations: Default::default(),
                package_publication_gate: Default::default(),
                safe_mode: AtomicBool::new(true),
                reference_taken: AtomicBool::new(true),
                detached: true,
                write_revoked: Arc::new(AtomicBool::new(false)),
            }),
        })
    }

    /// 只读打开的参考视角跟随安全模式设置；活动资料库的句柄由资料库自己的开关决定，不受影响。
    pub(crate) fn set_detached_safe_mode(&self, on: bool) {
        if self.inner.detached {
            self.inner.safe_mode.store(on, Ordering::SeqCst);
        }
    }

    /// 这个句柄属于哪个资料库。资料库切换后应用壳换上新库的句柄，用前要核对。
    pub fn library_id(&self) -> &str {
        &self.inner.info.id
    }

    /// 参考图及是否需要遮蔽。回收站里的图也能取得（参考组成员不随删除消失）。
    pub fn image(&self, image_id: &str) -> Result<ReferenceImage, Error> {
        self.image_with_mode(image_id, self.inner.safe_mode())
    }

    /// Application authorization supplies its current mode. A shared library cache can have
    /// been updated by a delayed read and is not the authority for this reference operation.
    pub(crate) fn image_with_mode(
        &self,
        image_id: &str,
        safe_mode: bool,
    ) -> Result<ReferenceImage, Error> {
        let conn = self.inner.readers.get();
        let (width, height, adult) = conn
            .query_row(
                &format!(
                    "SELECT width, height, {} FROM image WHERE image.id = ?1",
                    rating::adult_sql("image.id")
                ),
                [image_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, bool>(2)?)),
            )
            .optional()?
            .ok_or(Error::UnknownImage)?;
        Ok(ReferenceImage {
            id: image_id.to_owned(),
            width,
            height,
            sealed: adult && safe_mode,
        })
    }

    /// 缩略图文件，不论是否被封印；遮蔽由显示的一方按 [`ReferenceImage::sealed`] 做。
    pub fn thumbnail(&self, image_id: &str, target_px: u32) -> Result<PathBuf, Error> {
        thumbnail::get(&self.inner, image_id, target_px)
    }

    /// 1:1 与放大时显示的文件（同 [`Library::display`](super::Library::display)：原图或原尺寸
    /// `sdr` 派生图），不论是否被封印。桌面钉图不缩小时用它。
    pub fn display(&self, image_id: &str) -> Result<DisplayFile, Error> {
        self.inner.display(image_id)
    }

    /// 按目标宽度显示的文件（同 [`Library::display_scaled`](super::Library::display_scaled)），
    /// 不论是否被封印。桌面钉图缩小时以它为源，不交给 Chromium 缩小。
    pub fn display_scaled(&self, image_id: &str, target_px: u32) -> Result<DisplayFile, Error> {
        self.inner.display_scaled(image_id, target_px)
    }

    /// 原图文件，不论是否被封印。
    pub fn original_path(&self, image_id: &str) -> Result<PathBuf, Error> {
        self.inner.original_path(image_id)
    }
}
