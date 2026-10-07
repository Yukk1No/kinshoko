//! 资料库（Library）：资料库身份、参考图与元数据，独占 SQLite 写入。
//!
//! 对外接口按界面动作划分、强类型（#42“模块与接口”）：
//! - [`Library::browse`]：浏览，keyset 分页，返回已解析缩略图地址的卡片；
//! - [`Library::import`]：立即返回导入任务，带进度、取消与逐项结果；
//! - [`Library::events`]：提交后才推送的变更事件；
//! - [`Library::thumbnail`]：缩略图（可重建缓存）的本地文件；
//! - [`Library::edit`]：一次批量整理若干张图，返回重新计算后的详情；[`Library::image`]：单张详情；
//! - [`Library::sidebar`]：文件夹树与按可见图计算的计数；
//! - 文件夹编辑：[`Library::create_folder`]、[`Library::rename_folder`]、[`Library::move_folder`]。
//! - [`Library::edit_tags`] / [`Library::image_tags`]：人工标签决定与一张图的标签；
//! - [`Library::vocabulary`]：标签词表快照；[`Library::tag_groups`]：侧栏的标签分组；
//! - [`Library::replace_source_tags`]：按来源分层写入（打标、Eagle 导入等来源用）；
//! - 打标子接口：[`Library::images_to_tag`] 取待打标的图，[`Library::replace_source_rating`]
//!   按来源写入分级建议，[`Library::finish_tagging`] 记下打标结果；[`Library::image_rating`] 读分级。
//!
//! - 安全模式（#60）：上面这些读写接口都是浏览视角，开启时不露出被封印的图；
//!   参考视角 [`ReferenceLens`] 只在装配时交出一次（[`Library::take_reference_lens`]）。
//!
//! 资料库目录：`library.sqlite`（身份与全部整理结果）＋ `originals/<sha 前两位>/<sha>.<ext>`
//! （按 SHA-256 命名、写入一次、从不重编码）＋ `.staging/`（同库暂存）＋ `cache/`（可重建）。

mod colour;
mod eagle;
mod eagle_discovery;
mod eagle_tags;
mod edit;
mod error;
mod events;
mod fault;
mod filter;
mod folders;
mod import;
mod lens;
mod rating;
mod recovery;
mod sidebar;
mod store;
mod tags;
mod thumbnail;
mod types;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, RwLock};

use rusqlite::{OptionalExtension, params};

pub use crate::fidelity::{
    Cicp, ColourDeclaration, ColourDescription, ColourModel, HdrKind, IccKind, IccSummary,
};
pub use eagle::{EagleBinding, EagleRegionNote, EagleSourceSnapshot};
pub use eagle_discovery::{
    EagleDiscoveryMethod, EagleDiscoveryOptions, EagleLibraryCandidate, discover_eagle_libraries,
};
pub use eagle_tags::{
    EagleTagMapping, EagleTagMatch, ExternalVocabulary, MappedExternal, MatchBasis,
    UnmatchedEagleTag,
};
pub use edit::{FolderRef, ImageDetail, ImageEdit, ImageNote, SourceNote};
pub use error::Error;
pub use events::LibraryEvent;
pub use folders::FolderNode;
pub use import::ImportTask;
pub use lens::{ReferenceImage, ReferenceLens};
pub use rating::{ContentRating, ImageRating, RatingFact, TaggingOutcome};
pub use sidebar::Sidebar;
pub use tags::{
    FactSource, ImageTag, ImageTags, LocalizedName, PersonalApproxEntry, SourceTag, TagAlias,
    TagCount, TagEdit, TagGroupView, TagLabel, TagNamespace, TagOrigin, TagRef, TagTranslation,
    TagTranslations, Vocabulary, VocabularyTag,
};
pub use types::{
    BrowsePage, BrowseQuery, BrowseScope, DisplayFile, DisplayRoute, ImageCard, ImageSourceRecord,
    ImportItem, ImportOutcome, ImportProgress, ImportReport, ImportSource, LibraryInfo,
    RecoveryReport,
};

use crate::approx::ApproxRelation;
use events::Hub;
use store::{DB_FILE, Readers, Writer};
pub(crate) use tags::display_label;

/// 资料库格式版本，写在 `library.format_version`。
const FORMAT_VERSION: i64 = 1;
const ORIGINALS_DIR: &str = "originals";
const STAGING_DIR: &str = ".staging";
const CACHE_DIR: &str = "cache";
const READERS: usize = 4;

/// 可见的参考图：不在回收站里。浏览、计数与侧栏都只算可见的图（`image` 表的条件）。
/// 安全模式的过滤另由 `Inner::lens_filter` 给出，与它一起用。
pub(crate) const LIVE: &str = "image.deleted_at IS NULL";

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
    /// 安全模式是否开启；打开资料库时默认开启。
    safe_mode: AtomicBool,
    /// 参考视角的句柄是否已经交出。
    reference_taken: AtomicBool,
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
    /// 只读资料库身份与名称，供本设备登记与位置校验使用；不触发迁移或导入对账。
    pub fn inspect(root: &Path) -> Result<LibraryInfo, Error> {
        let db = root.join(DB_FILE);
        if !db.is_file() {
            return Err(Error::NotALibrary(root.to_path_buf()));
        }
        let conn = store::inspect_db(&db)?;
        let (id, name) = conn.query_row("SELECT id, name FROM library", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
        Ok(LibraryInfo {
            id,
            name,
            root: std::path::absolute(root)?,
        })
    }

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
        {
            // 管线版本变化后，旧缩略图目录整体作废。
            let root = root.clone();
            let _ = std::thread::Builder::new()
                .name("kinshoko-stale-thumbnails".into())
                .spawn(move || thumbnail::remove_stale(&root));
        }
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
                safe_mode: AtomicBool::new(true),
                reference_taken: AtomicBool::new(false),
            }),
        })
    }

    pub fn info(&self) -> &LibraryInfo {
        &self.inner.info
    }

    /// Eagle 来源及其原样元数据快照；区域评论的坐标基准未经核验。
    pub fn eagle_sources(&self) -> Result<Vec<EagleSourceSnapshot>, Error> {
        eagle::snapshots(&self.inner)
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
        self.inner
            .require_visible(&self.inner.readers.get(), image_id)?;
        thumbnail::get(&self.inner, image_id, target_px)
    }

    /// 1:1 与放大时显示的文件（ADR-0005）：静态 SDR 原图交给 WebView2 直接显示；导入时标为
    /// 动图、HDR、Chromium 不能精确表示的 ICC 或 CMYK 的，给原尺寸的 `sdr` 派生图。
    /// 应用壳经 `thumb` 协议的 `<资料库 id>/<参考图 id>/full` 提供，看图界面只用这条路。
    pub fn display(&self, image_id: &str) -> Result<DisplayFile, Error> {
        self.inner
            .require_visible(&self.inner.readers.get(), image_id)?;
        let (description, ..) = colour::get(&self.inner, image_id)?;
        if description.needs_sdr_derivative() {
            Ok(DisplayFile {
                route: DisplayRoute::SdrDerivative,
                path: thumbnail::full_size(&self.inner, image_id)?,
            })
        } else {
            Ok(DisplayFile {
                route: DisplayRoute::Original,
                path: self.inner.original_path(image_id)?,
            })
        }
    }

    /// 参考图的色彩描述（导入时记录）。
    pub fn colour(&self, image_id: &str) -> Result<ColourDescription, Error> {
        colour::get(&self.inner, image_id).map(|(d, ..)| d)
    }

    /// 安全模式是否开启。
    pub fn safe_mode(&self) -> bool {
        self.inner.safe_mode()
    }

    /// 开关安全模式。状态变化时推送 [`LibraryEvent::SafeModeChanged`]：已取得的浏览结果、
    /// 计数、词表与详情都要重新读取。
    pub fn set_safe_mode(&self, on: bool) {
        if self.inner.safe_mode.swap(on, Ordering::SeqCst) != on {
            self.inner.hub.publish(LibraryEvent::SafeModeChanged {
                library_id: self.inner.info.id.clone(),
                on,
            });
        }
    }

    /// 交出参考视角的句柄。每个打开的资料库只交出一次：应用壳在装配时取得，交给参考组与
    /// 桌面钉图（可以克隆）；之后再要只得到 `None`。
    pub fn take_reference_lens(&self) -> Option<ReferenceLens> {
        (!self.inner.reference_taken.swap(true, Ordering::SeqCst)).then(|| ReferenceLens {
            inner: self.inner.clone(),
        })
    }

    /// 对 `ids` 中的每张图按顺序应用 `edits`，一个事务内全部成功才提交，
    /// 返回这些图重新计算后的详情（按 `ids` 顺序、去重）。
    pub fn edit(&self, ids: &[String], edits: &[ImageEdit]) -> Result<Vec<ImageDetail>, Error> {
        edit::edit(&self.inner, ids, edits)
    }

    /// 单张参考图的详情。
    pub fn image(&self, image_id: &str) -> Result<ImageDetail, Error> {
        let conn = self.inner.readers.get();
        self.inner.require_visible(&conn, image_id)?;
        edit::detail(&conn, image_id)
    }

    /// 侧栏：全部、回收站与文件夹树，计数只算可见的图。
    pub fn sidebar(&self) -> Result<Sidebar, Error> {
        sidebar::get(&self.inner)
    }

    /// 新建文件夹，放在 `parent` 下（`None` 为顶层）的最后，返回文件夹 id。
    pub fn create_folder(&self, name: &str, parent: Option<&str>) -> Result<String, Error> {
        folders::create(&self.inner, name, parent)
    }

    pub fn rename_folder(&self, folder_id: &str, name: &str) -> Result<(), Error> {
        folders::rename(&self.inner, folder_id, name)
    }

    /// 把文件夹（连同子文件夹）移到 `parent` 下（`None` 为顶层）的第 `position` 位；
    /// 超出时放在最后。不能移进它自己或它的子文件夹。
    pub fn move_folder(
        &self,
        folder_id: &str,
        parent: Option<&str>,
        position: u32,
    ) -> Result<(), Error> {
        folders::move_to(&self.inner, folder_id, parent, position)
    }

    /// 参考图的全部来源，按记录先后。之后并入查看器详情 `image(id)`。
    pub fn image_sources(&self, image_id: &str) -> Result<Vec<ImageSourceRecord>, Error> {
        let conn = self.inner.readers.get();
        self.inner.require_visible(&conn, image_id)?;
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

    /// 模型来源 `source` 还没打过标的参考图（不含回收站中的），新导入的在前，最多 `limit` 张。
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

    /// 迁入向导：把还没有外部对应的 Eagle 标签按名称与翻译表精确匹配到 `vocabulary`
    /// 并写入外部对应（规范化后只对上一个、且没被别的标签占用的才写），返回已对上与没对上的
    /// Eagle 标签。安全模式开启时不列出只出现在被封印图上的标签。
    pub fn map_eagle_tags(
        &self,
        vocabulary: &ExternalVocabulary,
        lang: &str,
    ) -> Result<EagleTagMapping, Error> {
        eagle_tags::map_eagle_tags(&self.inner, vocabulary, lang)
    }

    /// 迁入向导：画师给一个标签补上外部对应。输入规范化后在词表中只对上一个名称时写词表的写法，
    /// 否则原样写入。
    pub fn map_tag_external(
        &self,
        tag_id: &str,
        input: &str,
        vocabulary: &ExternalVocabulary,
    ) -> Result<MappedExternal, Error> {
        eagle_tags::map_tag_external(&self.inner, tag_id, input, vocabulary)
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

    /// 在个人近似对应表中记下 `a` 与 `b` 相近或不相近（无方向）。同一对已有记录时改为这次的判断。
    /// “以后都不展开”记不相近，“＋”记相近。
    pub fn set_tag_approx(&self, a: &str, b: &str, relation: ApproxRelation) -> Result<(), Error> {
        tags::set_tag_approx(&self.inner, a, b, relation)
    }

    /// 删除个人近似对应表中 `a` 与 `b` 这一对（无方向）；之后按内置近似对应表。
    pub fn remove_tag_approx(&self, a: &str, b: &str) -> Result<(), Error> {
        tags::remove_tag_approx(&self.inner, a, b)
    }

    /// 个人近似对应表的全部条目，最近记下的在前，名称按界面语言 `lang`。
    pub fn personal_approx(&self, lang: &str) -> Result<Vec<PersonalApproxEntry>, Error> {
        tags::personal_approx(&self.inner, lang)
    }

    /// 侧栏的标签分组及计数，名称按界面语言 `lang`。
    pub fn tag_groups(&self, lang: &str) -> Result<Vec<TagGroupView>, Error> {
        tags::tag_groups(&self.inner, lang)
    }

    /// 参考图原文件的位置。
    pub fn original_path(&self, image_id: &str) -> Result<PathBuf, Error> {
        self.inner
            .require_visible(&self.inner.readers.get(), image_id)?;
        self.inner.original_path(image_id)
    }

    /// 打标子接口：待打标的图的原文件位置，不受安全模式影响（被封印的图也要重新打标）。
    pub fn original_to_tag(&self, image_id: &str) -> Result<PathBuf, Error> {
        self.inner.original_path(image_id)
    }
}

impl Inner {
    /// 原文件位置，不经过浏览视角。
    fn original_path(&self, image_id: &str) -> Result<PathBuf, Error> {
        let conn = self.readers.get();
        let rel: String = conn
            .query_row(
                "SELECT rel_path FROM image WHERE id = ?1",
                [image_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(Error::UnknownImage)?;
        Ok(self.root.join(rel))
    }
}

impl Inner {
    /// 在写线程上跑一个短事务；提交后才推送“列表过期”。
    pub(crate) fn write<T: Send + 'static>(
        &self,
        f: impl FnOnce(&rusqlite::Transaction) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        let result = self.writer.run(move |conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let value = f(&tx)?;
            tx.commit()?;
            Ok(value)
        });
        if result.is_ok() {
            self.hub.publish(LibraryEvent::ListStale {
                library_id: self.info.id.clone(),
            });
        }
        result
    }
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
