//! 资料库（Library）：资料库身份、参考图与元数据，独占 SQLite 写入。
//!
//! 对外接口按界面动作划分、强类型（#42“模块与接口”）：
//! - [`Library::browse`]：浏览，keyset 分页，返回已解析缩略图地址的卡片；
//! - [`Library::import`]：立即返回导入任务，带进度、取消与逐项结果；
//! - [`Library::events`]：提交后才推送的变更事件；
//! - [`Library::thumbnail`]：缩略图（可重建缓存）的本地文件；
//! - [`Library::edit`]：一次批量整理若干张图，返回重新计算后的详情；[`Library::image`]：单张详情；
//! - [`Library::sidebar`]：文件夹树与按可见图计算的计数；
//! - 永久删除两步：[`Library::preview_permanent_delete`] 给出受影响的参考组与令牌，
//!   [`Library::permanent_delete`] 核对令牌后执行；
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

mod backup;
mod clipboard;
mod colour;
mod display;
mod eagle;
mod eagle_discovery;
mod eagle_tags;
mod edit;
mod error;
mod events;
pub(crate) mod fault;
mod filter;
mod folders;
mod image_api;
mod import;
mod lens;
mod package;
mod permanent_delete;
pub(crate) mod provider;
mod rating;
mod recovery;
mod safe_mode_api;
mod save;
mod sidebar;
mod source_names;
mod store;
mod tag_api;
pub(crate) mod tag_definitions;
mod tags;
mod thumbnail;
mod types;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex, RwLock};

use rusqlite::{OptionalExtension, params};

pub use crate::fidelity::{
    Cicp, ColourDeclaration, ColourDescription, ColourModel, HdrKind, IccKind, IccSummary,
};
pub use backup::{
    Dependency, LibraryCheck, LibraryDependencies, LibrarySnapshot, OriginalFile, OriginalsLease,
    RestoreProvenance, TableDigest,
};
pub(crate) use backup::{copy_hashed, hash_file};
pub use clipboard::{forget_staged_clipboard_images, stage_clipboard_image};
pub use eagle::{EagleBinding, EagleRegionNote, EagleSourceSnapshot};
pub use eagle_discovery::{
    EagleDiscoveryMethod, EagleDiscoveryOptions, EagleLibraryCandidate, discover_eagle_libraries,
};
pub use eagle_tags::{
    EagleTagMapping, EagleTagMatch, ExternalVocabulary, MappedExternal, MatchBasis,
    UnmatchedEagleTag,
};
pub use edit::{FolderRef, ImageDetail, ImageEdit, ImageNote, ImageVersions, SourceNote};
pub use error::Error;
pub use events::{LibraryEvent, forward_coalesced};
pub use folders::FolderNode;
pub use import::{ImportStages, ImportTask};
pub use lens::{ReferenceImage, ReferenceLens};
pub use package::{ImageSnapshot, PackageOrigin, SnapshotTag};
pub use permanent_delete::PermanentDeletePreview;
pub use rating::{ContentRating, ImageRating, RatingFact, SafeMode, SafeModeScope, TaggingOutcome};
pub use save::SaveDestination;
pub use sidebar::Sidebar;
pub use source_names::{UND, compose as compose_names, detect_lang};
pub use tags::{
    FactSource, ImageTag, ImageTags, LocalizedName, PersonalApproxEntry, SourceTag, TagAlias,
    TagCount, TagEdit, TagGroupDefinition, TagGroupView, TagLabel, TagNamespace, TagOrigin, TagRef,
    TagTranslation, TagTranslations, Vocabulary, VocabularyTag,
};
pub use types::{
    BrowsePage, BrowseQuery, BrowseScope, DisplayFile, DisplayRoute, EagleDeletedContentChoice,
    EagleLocationChoice, EagleRelocation, ImageCard, ImageSourceRecord, ImportItem, ImportOptions,
    ImportOutcome, ImportProgress, ImportReport, ImportSource, LibraryInfo, RecoveryReport,
};

use crate::approx::ApproxRelation;
pub(crate) use eagle_tags::same_spelling;
use events::Hub;
use store::{DB_FILE, Readers, Writer};
pub(crate) use tags::display_label;
pub(crate) use thumbnail::placeholder;

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
    save_destination: Option<SaveDestination>,
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
    package_publication_gate: RwLock<Option<Arc<Mutex<()>>>>,
    /// 安全模式的开关与范围（[`SafeMode::encode`]）；打开资料库时默认开启、默认范围。
    safe_mode: AtomicU8,
    /// 参考视角的句柄是否已经交出。
    reference_taken: AtomicBool,
    /// 只读打开、不是活动资料库（参考组读取未激活的库，#66）：不写数据库。
    detached: bool,
    write_revoked: Arc<AtomicBool>,
    /// 正在进行的导入的保存文件夹（每个任务一项，可重复）；删除文件夹时据此拒绝。
    import_folders: Arc<Mutex<Vec<String>>>,
}

impl Inner {
    /// 正在进行的导入的保存文件夹（见 [`Inner::import_folders`]）。
    fn receiving_folders(&self) -> std::sync::MutexGuard<'_, Vec<String>> {
        self.import_folders
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

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

    /// Read an inactive provider without reconciliation, migrations, or content writes.
    /// Existing local-ID read actions remain available; write actions return a read-only error.
    pub fn open_read_only(root: &Path, expected_id: &str) -> Result<Library, Error> {
        let lens = ReferenceLens::open_detached(root, expected_id)?;
        Ok(Library {
            inner: lens.inner,
            save_destination: None,
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
        let library = Self::start(root, conn, recovery)?;
        // 早于 #110 导入、或缓存被清掉的图：在后台补生成占位图，补齐前界面退回中性底色。
        let inner = Arc::downgrade(&library.inner);
        let _ = std::thread::Builder::new()
            .name("kinshoko-placeholders".into())
            .spawn(move || thumbnail::fill_placeholders(inner));
        Ok(library)
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
            save_destination: None,
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
                package_publication_gate: RwLock::default(),
                safe_mode: AtomicU8::new(SafeMode::new(true, SafeModeScope::default()).encode()),
                reference_taken: AtomicBool::new(false),
                detached: false,
                write_revoked: Arc::new(AtomicBool::new(false)),
                import_folders: Arc::default(),
            }),
        })
    }

    /// Serialize package/copy metadata publication with the application's final visible commit.
    /// Only the short import transaction takes this gate; reading, hashing and decoding do not.
    /// Ordinary and Eagle imports cannot change an existing image's effective content rating.
    /// Configure writable handles before exposing them to application actions. Do not hold this
    /// gate while calling package import/copy; those actions acquire it at publication.
    pub fn use_package_publication_gate(&self, gate: Arc<Mutex<()>>) {
        *self
            .inner
            .package_publication_gate
            .write()
            .unwrap_or_else(|e| e.into_inner()) = Some(gate);
    }

    pub fn info(&self) -> &LibraryInfo {
        &self.inner.info
    }

    /// Eagle 来源及其原样元数据快照；区域评论的坐标基准未经核验。
    pub fn eagle_sources(&self) -> Result<Vec<EagleSourceSnapshot>, Error> {
        eagle::snapshots(&self.inner)
    }

    /// 画师确认导入报告里疑似搬家的 Eagle 位置（[`EagleRelocation`]）：
    /// 同一来源搬了家就沿用登记、改记新位置；另一个来源就单独登记。确认后再导入这个位置。
    pub fn confirm_eagle_location(
        &self,
        path: &Path,
        choice: EagleLocationChoice,
    ) -> Result<(), Error> {
        eagle::confirm_location(&self.inner, path, choice)
    }

    /// 按查询浏览参考图，按导入先后从新到旧，keyset 分页。
    pub fn browse(&self, query: &BrowseQuery) -> Result<BrowsePage, Error> {
        types::browse(&self.inner, query)
    }

    /// 开始导入，立即返回任务。文件 I/O 与哈希在任务自己的线程里做。
    pub fn import(&self, source: ImportSource) -> ImportTask {
        self.import_with_options(source, ImportOptions::default())
    }

    /// 按本次选择导入；允许重导不清除内容版本的永久删除记忆。
    pub fn import_with_options(&self, source: ImportSource, options: ImportOptions) -> ImportTask {
        match &self.save_destination {
            Some(destination) => {
                import::start_to(self.inner.clone(), source, options, destination.clone())
            }
            None => import::start(self.inner.clone(), source, options),
        }
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
        self.inner.display(image_id)
    }

    /// 查看器按目标宽度（转正后的设备像素）显示的文件：目标不小于原图宽度时同 [`Self::display`]；
    /// 更小时（适应窗口等）是精确尺寸的 `sdr` 派生图，不交给 Chromium 缩小（#47）。
    /// 应用壳经 `thumb` 协议的 `<资料库 id>/<参考图 id>/fit-<像素>` 提供。
    pub fn display_scaled(&self, image_id: &str, target_px: u32) -> Result<DisplayFile, Error> {
        if target_px == 0 {
            return Err(Error::InvalidDisplaySize);
        }
        self.inner
            .require_visible(&self.inner.readers.get(), image_id)?;
        self.inner.display_scaled(image_id, target_px)
    }

    /// Receipt capability only: a detached provider and an exact live byte identity.
    /// Render from one verified immutable byte buffer; no mode, metadata or cache is changed.
    pub(crate) fn read_import_duplicate(
        &self,
        image_id: &str,
        sha256: &str,
        target_px: u32,
    ) -> Result<(Vec<u8>, String), Error> {
        use rusqlite::OptionalExtension;
        use sha2::{Digest, Sha256};
        if !self.inner.detached {
            return Err(Error::UnknownImage);
        }
        let width: Option<u32> = self
            .inner
            .readers
            .get()
            .query_row(
                "SELECT width FROM image WHERE id=?1 AND sha256=?2 AND deleted_at IS NULL",
                [image_id, sha256],
                |row| row.get(0),
            )
            .optional()?;
        let width = width.ok_or(Error::UnknownImage)?;
        let (description, _, original) = colour::get(&self.inner, image_id)?;
        let bytes = std::fs::read(original)?;
        if format!("{:x}", Sha256::digest(&bytes)) != sha256 {
            return Err(Error::SourceChanged);
        }
        if target_px < width || description.needs_sdr_derivative() {
            let rendered = crate::fidelity::render::render_sdr(
                &bytes,
                target_px,
                crate::fidelity::DEFAULT_DOWNSCALE,
            )
            .map_err(Error::Undecodable)?;
            return Ok((rendered.bytes, rendered.mime.into()));
        }
        let mime = match description.format.as_str() {
            "png" => "image/png",
            "jpeg" | "jpg" => "image/jpeg",
            "gif" => "image/gif",
            _ => "image/webp",
        };
        Ok((bytes, mime.into()))
    }

    /// 参考图的色彩描述（导入时记录）。浏览视角：被封印的图当作不存在。
    pub fn colour(&self, image_id: &str) -> Result<ColourDescription, Error> {
        self.inner
            .require_visible(&self.inner.readers.get(), image_id)?;
        colour::get(&self.inner, image_id).map(|(d, ..)| d)
    }
}

impl Inner {
    /// 在写线程上跑一个短事务；提交后才推送“列表过期”。
    pub(crate) fn write<T: Send + 'static>(
        &self,
        f: impl FnOnce(&rusqlite::Transaction) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        self.write_holding(Arc::new(Mutex::new(())), move |tx, _| f(tx))
    }

    /// 与 [`Inner::write`] 相同，但从核对到提交一直持有 `lock`：拿这把锁核对后再登记的一方
    /// （例如导入登记保存文件夹）要么在这次写入之前，要么只看得到已提交的结果，不会夹在中间。
    pub(crate) fn write_holding<T: Send + 'static, G: Send + 'static>(
        &self,
        lock: Arc<Mutex<G>>,
        f: impl FnOnce(&rusqlite::Transaction, &mut G) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        let result = self.writer.run(move |conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let mut held = lock.lock().unwrap_or_else(|e| e.into_inner());
            let value = f(&tx, &mut held)?;
            tx.commit()?;
            drop(held);
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
