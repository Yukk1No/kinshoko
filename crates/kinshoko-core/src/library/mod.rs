//! 资料库（Library）：资料库身份、参考图与元数据，独占 SQLite 写入。
//!
//! 对外接口按界面动作划分、强类型（#42“模块与接口”）：
//! - [`Library::browse`]：浏览，keyset 分页，返回已解析缩略图地址的卡片；
//! - [`Library::import`]：立即返回导入任务，带进度、取消与逐项结果；
//! - [`Library::events`]：提交后才推送的变更事件；
//! - [`Library::thumbnail`]：缩略图（可重建缓存）的本地文件；
//! - [`Library::edit_tags`] / [`Library::image_tags`]：人工标签决定与一张图的标签；
//! - [`Library::vocabulary`]：标签词表快照；[`Library::tag_groups`]：侧栏的标签分组；
//! - [`Library::replace_source_tags`]：按来源分层写入（打标、Eagle 导入等来源用）；
//! - 打标子接口：[`Library::images_to_tag`] 取待打标的图，[`Library::replace_source_rating`]
//!   按来源写入分级建议，[`Library::finish_tagging`] 记下打标结果；[`Library::image_rating`] 读分级。
//!
//! 资料库目录：`library.sqlite`（身份与全部整理结果）＋ `originals/<sha 前两位>/<sha>.<ext>`
//! （按 SHA-256 命名、写入一次、从不重编码）＋ `.staging/`（同库暂存）＋ `cache/`（可重建）。

mod error;
mod events;
mod fault;
mod import;
mod rating;
mod recovery;
mod store;
mod tags;
mod thumbnail;
mod types;

use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, RwLock};

use rusqlite::{OptionalExtension, params};

pub use error::Error;
pub use events::LibraryEvent;
pub use import::ImportTask;
pub use rating::{ContentRating, ImageRating, RatingFact, TaggingOutcome};
pub use tags::{
    FactSource, ImageTag, ImageTags, LocalizedName, SourceTag, TagAlias, TagCount, TagEdit,
    TagGroupView, TagLabel, TagNamespace, TagOrigin, TagRef, TagTranslation, TagTranslations,
    Vocabulary, VocabularyTag,
};
pub use types::{
    BrowsePage, BrowseQuery, BrowseScope, ImageCard, ImageSourceRecord, ImportItem, ImportOutcome,
    ImportProgress, ImportReport, ImportSource, LibraryInfo, RecoveryReport,
};

use events::Hub;
use store::{DB_FILE, Readers, Writer};

/// 资料库格式版本，写在 `library.format_version`。
const FORMAT_VERSION: i64 = 1;
const ORIGINALS_DIR: &str = "originals";
const STAGING_DIR: &str = ".staging";
const CACHE_DIR: &str = "cache";
const READERS: usize = 4;

/// 一个打开的资料库。可在线程间共享（`Arc<Library>`）。
pub struct Library {
    inner: Arc<Inner>,
}

pub(crate) struct Inner {
    root: PathBuf,
    info: LibraryInfo,
    writer: Writer,
    readers: Readers,
    hub: Hub,
    recovery: RecoveryReport,
    translations: RwLock<Arc<tags::TranslationIndex>>,
}

impl Inner {
    fn translations(&self) -> Arc<tags::TranslationIndex> {
        self.translations
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

impl Library {
    /// 在 `root` 建立新资料库。`root` 必须不存在或是空文件夹。
    pub fn create(root: &Path, name: &str) -> Result<Library, Error> {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::InvalidName);
        }
        if root.exists() {
            let mut entries = std::fs::read_dir(root)?;
            if entries.next().is_some() {
                return Err(Error::NotEmpty(root.to_path_buf()));
            }
        }
        std::fs::create_dir_all(root.join(ORIGINALS_DIR))?;
        std::fs::create_dir_all(root.join(STAGING_DIR))?;

        let conn = store::open_db(&root.join(DB_FILE))?;
        conn.execute(
            "INSERT INTO library (id, name, format_version, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                uuid::Uuid::new_v4().simple().to_string(),
                name,
                FORMAT_VERSION,
                now_ms()
            ],
        )?;
        Self::start(root, conn, RecoveryReport::default())
    }

    /// 打开已有资料库。
    pub fn open(root: &Path) -> Result<Library, Error> {
        let db = root.join(DB_FILE);
        if !db.is_file() {
            return Err(Error::NotALibrary(root.to_path_buf()));
        }
        let mut conn = store::open_db(&db)?;
        std::fs::create_dir_all(root.join(ORIGINALS_DIR))?;
        std::fs::create_dir_all(root.join(STAGING_DIR))?;
        // 先对账，再启动读写。
        let recovery = recovery::reconcile(&mut conn, root)?;
        Self::start(root, conn, recovery)
    }

    /// 本次打开时的对账结果：撤回了哪些中断的导入项、有哪些未知的孤立原文件。
    pub fn recovery(&self) -> &RecoveryReport {
        &self.inner.recovery
    }

    fn start(
        root: &Path,
        conn: rusqlite::Connection,
        recovery: RecoveryReport,
    ) -> Result<Library, Error> {
        let info = conn
            .query_row("SELECT id, name FROM library", [], |row| {
                Ok(LibraryInfo {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    root: PathBuf::new(),
                })
            })
            .optional()?
            .ok_or_else(|| Error::NotALibrary(root.to_path_buf()))?;
        let root = std::path::absolute(root)?;
        let readers = Readers::open(&root.join(DB_FILE), READERS)?;
        Ok(Library {
            inner: Arc::new(Inner {
                info: LibraryInfo {
                    root: root.clone(),
                    ..info
                },
                root,
                writer: Writer::spawn(conn),
                readers,
                hub: Hub::default(),
                recovery,
                translations: RwLock::default(),
            }),
        })
    }

    pub fn info(&self) -> &LibraryInfo {
        &self.inner.info
    }

    /// 按查询浏览参考图，按导入先后从新到旧，keyset 分页。
    pub fn browse(&self, query: &BrowseQuery) -> Result<BrowsePage, Error> {
        types::browse(&self.inner, query)
    }

    /// 开始导入，立即返回任务。文件 I/O 与哈希在任务自己的线程里做。
    pub fn import(&self, source: ImportSource) -> ImportTask {
        import::start(self.inner.clone(), source)
    }

    /// 订阅变更事件。事件在事务提交后才推送。
    pub fn events(&self) -> Receiver<LibraryEvent> {
        self.inner.hub.subscribe()
    }

    /// 参考图在目标像素宽度下的缩略图文件；缓存缺失时现场生成。
    pub fn thumbnail(&self, image_id: &str, target_px: u32) -> Result<PathBuf, Error> {
        thumbnail::get(&self.inner, image_id, target_px)
    }

    /// 参考图的全部来源，按记录先后。之后并入查看器详情 `image(id)`。
    pub fn image_sources(&self, image_id: &str) -> Result<Vec<ImageSourceRecord>, Error> {
        let conn = self.inner.readers.get();
        let mut stmt = conn.prepare_cached(
            "SELECT source, location FROM image_source WHERE image_id = ?1
             ORDER BY recorded_at, rowid",
        )?;
        let sources = stmt
            .query_map([image_id], |row| {
                Ok(ImageSourceRecord {
                    source: row.get(0)?,
                    location: PathBuf::from(row.get::<_, String>(1)?),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if sources.is_empty() {
            return Err(Error::UnknownImage);
        }
        Ok(sources)
    }

    /// 设置翻译表：之后首次进库的外部名称按它取得各语言的初始名称与别名。
    /// 已有标签不受影响。
    pub fn set_translations(&self, table: TagTranslations) {
        *self
            .inner
            .translations
            .write()
            .unwrap_or_else(|e| e.into_inner()) = tags::index(table);
    }

    /// 对若干参考图批量应用标签编辑（添加、否决、清除人工标签决定）。
    pub fn edit_tags(&self, image_ids: &[String], edits: &[TagEdit]) -> Result<(), Error> {
        tags::edit_tags(&self.inner, image_ids, edits)
    }

    /// 一张参考图的有效标签及出处、被否决的标签，名称按界面语言 `lang`。
    pub fn image_tags(&self, image_id: &str, lang: &str) -> Result<ImageTags, Error> {
        tags::image_tags(&self.inner, image_id, lang)
    }

    /// 用 `source` 这一层的标签事实替换参考图在该层的旧事实。
    /// 不碰其他来源，也不碰人工标签决定（#42“按来源分层”）。
    pub fn replace_source_tags(
        &self,
        source: &FactSource,
        image_id: &str,
        tags: &[SourceTag],
    ) -> Result<(), Error> {
        tags::replace_source_tags(&self.inner, source, image_id, tags)
    }

    /// 用 `source` 这一层的分级建议替换参考图在该层的旧建议；`None` 表示这一层没有建议。
    pub fn replace_source_rating(
        &self,
        source: &FactSource,
        image_id: &str,
        fact: Option<RatingFact>,
    ) -> Result<(), Error> {
        rating::replace_source_rating(&self.inner, source, image_id, fact)
    }

    /// 一张参考图的内容分级（自动与有效）。
    pub fn image_rating(&self, image_id: &str) -> Result<ImageRating, Error> {
        rating::image_rating(&self.inner, image_id)
    }

    /// 模型来源 `source` 还没打过标的参考图，新导入的在前，最多 `limit` 张。
    pub fn images_to_tag(&self, source: &FactSource, limit: u32) -> Result<Vec<String>, Error> {
        rating::images_to_tag(&self.inner, source, limit)
    }

    /// 记下模型来源 `source` 对一张参考图的打标结果；之后它不再是待打标的图。
    pub fn finish_tagging(
        &self,
        source: &FactSource,
        image_id: &str,
        outcome: TaggingOutcome,
    ) -> Result<(), Error> {
        rating::finish_tagging(&self.inner, source, image_id, outcome)
    }

    /// 标签词表快照：标签、各语言名称、别名、命名空间、外部对应与计数。
    pub fn vocabulary(&self) -> Result<Vocabulary, Error> {
        tags::vocabulary(&self.inner)
    }

    /// 给标签设置某种语言的名称（改名）。
    pub fn rename_tag(&self, tag_id: &str, lang: &str, name: &str) -> Result<(), Error> {
        tags::rename_tag(&self.inner, tag_id, lang, name)
    }

    pub fn add_tag_alias(&self, tag_id: &str, alias: &TagAlias) -> Result<(), Error> {
        tags::add_tag_alias(&self.inner, tag_id, alias)
    }

    pub fn remove_tag_alias(&self, tag_id: &str, alias: &str) -> Result<(), Error> {
        tags::remove_tag_alias(&self.inner, tag_id, alias)
    }

    /// 给标签补上外部对应。一个外部名称只能对应一个标签。
    pub fn add_tag_external(&self, tag_id: &str, external: &str) -> Result<(), Error> {
        tags::add_tag_external(&self.inner, tag_id, external)
    }

    pub fn remove_tag_external(&self, tag_id: &str, external: &str) -> Result<(), Error> {
        tags::remove_tag_external(&self.inner, tag_id, external)
    }

    /// 建立标签分组，排在最后。给出 `namespace` 时分组列出该命名空间的全部标签。
    pub fn create_tag_group(
        &self,
        name: &str,
        namespace: Option<TagNamespace>,
    ) -> Result<String, Error> {
        tags::create_tag_group(&self.inner, name, namespace)
    }

    pub fn rename_tag_group(&self, group_id: &str, name: &str) -> Result<(), Error> {
        tags::rename_tag_group(&self.inner, group_id, name)
    }

    /// 设置画师整理的分组的成员及顺序。
    pub fn set_tag_group_tags(&self, group_id: &str, tag_ids: &[String]) -> Result<(), Error> {
        tags::set_tag_group_tags(&self.inner, group_id, tag_ids)
    }

    /// 按给出的顺序排列标签分组。
    pub fn order_tag_groups(&self, group_ids: &[String]) -> Result<(), Error> {
        tags::order_tag_groups(&self.inner, group_ids)
    }

    pub fn delete_tag_group(&self, group_id: &str) -> Result<(), Error> {
        tags::delete_tag_group(&self.inner, group_id)
    }

    /// 侧栏的标签分组及计数，名称按界面语言 `lang`。
    pub fn tag_groups(&self, lang: &str) -> Result<Vec<TagGroupView>, Error> {
        tags::tag_groups(&self.inner, lang)
    }

    /// 参考图原文件的位置。
    pub fn original_path(&self, image_id: &str) -> Result<PathBuf, Error> {
        let conn = self.inner.readers.get();
        let rel: String = conn
            .query_row(
                "SELECT rel_path FROM image WHERE id = ?1",
                [image_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(Error::UnknownImage)?;
        Ok(self.inner.root.join(rel))
    }
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
