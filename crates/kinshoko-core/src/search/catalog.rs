//! 统一标签目录上的查找组装（#272）：本设备的统一标签目录、目录修订号、[`SearchCache`] 与
//! 内置近似对应表放在一起，应用壳的查找命令只调 [`CatalogSearch::search`]。
//!
//! - 统一标签目录第一次用到时才打开，打开时装入随软件分发的默认名称；其他调用方（标签组、
//!   名称、工作区……）经 [`CatalogSearch::with_catalog`] 取它，与查找共用一把锁。
//! - 查找时先同步目录；目录修订号变了就清掉缓存。构建期间一直持目录锁：更正不会在失效后把
//!   旧快照写回缓存。
//! - 视角不一致仍得到 [`crate::library::Error::LensChanged`]（见 [`SearchCache`]）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use super::{Search, SearchCache};
use crate::Library;
use crate::approx::BuiltinApproxTable;
use crate::library::TagTranslations;
use crate::tag_catalog::{CatalogError, TagCatalog};

/// 统一标签目录上的查找组装，见模块说明。
pub struct CatalogSearch {
    device_dir: PathBuf,
    name_defaults: TagTranslations,
    catalog: Mutex<Option<TagCatalog>>,
    /// 上次查找时目录的修订号；-1 表示还没查过或已失效。
    revision: AtomicI64,
    cache: SearchCache,
    builtin: BuiltinApproxTable,
}

impl CatalogSearch {
    /// `device_dir` 是统一标签目录所在的本设备数据目录；`name_defaults` 是随软件分发的翻译表，
    /// 打开目录时装入作默认名称。
    pub fn new(
        device_dir: PathBuf,
        name_defaults: TagTranslations,
        builtin: BuiltinApproxTable,
    ) -> Self {
        Self {
            device_dir,
            name_defaults,
            catalog: Mutex::default(),
            revision: AtomicI64::new(-1),
            cache: SearchCache::default(),
            builtin,
        }
    }

    /// `library` 当前词表经统一标签目录投影后的 Search；`view_on` 是界面当前的视角。
    pub fn search(
        &self,
        library: &Arc<Library>,
        view_on: bool,
    ) -> Result<Arc<Search>, CatalogError> {
        self.with_catalog(|catalog| {
            let snapshot = catalog.synchronize(library)?;
            if self.revision.swap(snapshot.revision, Ordering::SeqCst) != snapshot.revision {
                self.cache.invalidate();
            }
            self.cache
                .search_with(library, view_on, |vocabulary| {
                    Search::new(
                        &snapshot.search_vocabulary(&library.info().id, vocabulary),
                        &self.builtin,
                    )
                })
                .map_err(CatalogError::Library)
        })
    }

    /// 持目录锁调用 `action`；目录第一次用到时在这里打开。
    pub fn with_catalog<T>(
        &self,
        action: impl FnOnce(&mut TagCatalog) -> Result<T, CatalogError>,
    ) -> Result<T, CatalogError> {
        let mut slot = self.catalog.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_none() {
            let started = std::time::Instant::now();
            let mut catalog = TagCatalog::open(&self.device_dir)?;
            catalog.install_name_defaults(self.name_defaults.clone())?;
            crate::diagnostics::took("统一标签目录：打开并装内置名称", started, None);
            *slot = Some(catalog);
        }
        action(slot.as_mut().expect("统一目录已打开"))
    }

    /// 清掉查找缓存，下次查找按目录重新核对修订号；正在进行的构建不再写回。
    pub fn invalidate(&self) {
        self.cache.invalidate();
        self.revision.store(-1, Ordering::SeqCst);
    }

    /// 随软件分发的内置近似对应表（迁入向导的外部词表也用它）。
    pub fn builtin_approx(&self) -> &BuiltinApproxTable {
        &self.builtin
    }
}
