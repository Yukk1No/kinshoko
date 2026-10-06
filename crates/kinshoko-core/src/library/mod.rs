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
//!
//! 资料库目录：`library.sqlite`（身份与全部整理结果）＋ `originals/<sha 前两位>/<sha>.<ext>`
//! （按 SHA-256 命名、写入一次、从不重编码）＋ `.staging/`（同库暂存）＋ `cache/`（可重建）。

mod edit;
mod error;
mod events;
mod folders;
mod import;
mod sidebar;
mod store;
mod thumbnail;
mod types;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::Receiver;

use rusqlite::{OptionalExtension, params};

pub use edit::{FolderRef, ImageDetail, ImageEdit};
pub use error::Error;
pub use events::LibraryEvent;
pub use folders::FolderNode;
pub use import::ImportTask;
pub use sidebar::Sidebar;
pub use types::{
    BrowsePage, BrowseQuery, BrowseScope, ImageCard, ImportItem, ImportOutcome, ImportProgress,
    ImportReport, ImportSource, LibraryInfo,
};

use events::Hub;
use store::{DB_FILE, Readers, Writer};

/// 资料库格式版本，写在 `library.format_version`。
const FORMAT_VERSION: i64 = 1;
const ORIGINALS_DIR: &str = "originals";
const STAGING_DIR: &str = ".staging";
const CACHE_DIR: &str = "cache";
const READERS: usize = 4;

/// 可见的参考图：不在回收站里。浏览、计数与侧栏都只算可见的图（`image` 表的条件）。
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
        Self::start(root, conn)
    }

    /// 打开已有资料库。
    pub fn open(root: &Path) -> Result<Library, Error> {
        let db = root.join(DB_FILE);
        if !db.is_file() {
            return Err(Error::NotALibrary(root.to_path_buf()));
        }
        let conn = store::open_db(&db)?;
        std::fs::create_dir_all(root.join(ORIGINALS_DIR))?;
        std::fs::create_dir_all(root.join(STAGING_DIR))?;
        Self::start(root, conn)
    }

    fn start(root: &Path, conn: rusqlite::Connection) -> Result<Library, Error> {
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

    /// 对 `ids` 中的每张图按顺序应用 `edits`，一个事务内全部成功才提交，
    /// 返回这些图重新计算后的详情（按 `ids` 顺序、去重）。
    pub fn edit(&self, ids: &[String], edits: &[ImageEdit]) -> Result<Vec<ImageDetail>, Error> {
        edit::edit(&self.inner, ids, edits)
    }

    /// 单张参考图的详情。
    pub fn image(&self, image_id: &str) -> Result<ImageDetail, Error> {
        edit::detail(&self.inner.readers.get(), image_id)
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
