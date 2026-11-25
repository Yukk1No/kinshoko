//! Default workspace over registered, detached read-only content providers.
//! Each source executes the complete Library query; only afterwards are byte identities joined.
mod import_preview;
pub(crate) use import_preview::ImportPreviewAuthorization;
pub use import_preview::{
    ImportPreviewContent, ImportPreviewSession, PreparedImportPreview, ResolvedImportPreview,
};
mod source;
pub use source::{WorkspaceSourceBatch, WorkspaceSourceTarget, group_sources};
mod browse;
use browse::BrowseCache;
pub use browse::PendingPage;
mod gate;
mod image_read;
pub use gate::ImageGate;
mod snapshot;
mod types;
pub use types::*;
mod catalog_views;
mod directories;
mod image_access;
mod search_index;
mod vocabulary;
use vocabulary::*;

use crate::approx::BuiltinApproxTable;
use crate::library::provider::ProviderImage;
use crate::library::{
    BrowseScope, Error, TagAlias, TagLabel, Vocabulary, VocabularyTag, display_label,
};
use crate::search::{Candidate, Condition, ConditionTree, Search, SearchInput, Term};
use crate::tag_catalog::{CatalogError, CatalogInspection, TagCatalog, TagCatalogWorkspace};
use crate::{DeviceLibraries, LibraryRegistration};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use ts_rs::TS;

#[derive(Clone)]
struct Provider {
    registration: LibraryRegistration,
    images: Vec<ProviderImage>,
    /// Unprojected provider definitions; names are resolved by the shared catalog projection.
    vocabulary: Option<Vocabulary>,
    list: i64,
    revision: i64,
}
struct Snapshot {
    personal_approx: Vec<crate::approx::PersonalApprox>,
    providers: Vec<Provider>,
    catalog: CatalogInspection,
    status: WorkspaceStatus,
    /// 快照所用的安全模式范围（#223）：`adult` 按它算出，快照的修订号也随它变。
    scope: crate::library::SafeModeScope,
    /// 有效分级在安全模式范围内的图（原图字节的 SHA-256）：安全模式开启时被封印。
    adult: BTreeSet<String>,
    identities: BTreeMap<(String, String), String>,
    safe_vocabulary: std::sync::OnceLock<Vocabulary>,
    full_vocabulary: std::sync::OnceLock<Vocabulary>,
    safe_management_vocabulary: std::sync::OnceLock<Vocabulary>,
    full_management_vocabulary: std::sync::OnceLock<Vocabulary>,
    safe_search: std::sync::Mutex<Option<search_index::CachedSearch>>,
    full_search: std::sync::Mutex<Option<search_index::CachedSearch>>,
    safe_resolve_search: std::sync::Mutex<Option<search_index::CachedSearch>>,
    full_resolve_search: std::sync::Mutex<Option<search_index::CachedSearch>>,
    /// 按原图字节 SHA-256 索引全部来源：`(providers 下标, provider.images 下标)`，按需构建并缓存。
    by_sha256: std::sync::OnceLock<std::collections::HashMap<String, Vec<(usize, usize)>>>,
}
impl Snapshot {
    fn status(&self, safe: bool) -> WorkspaceStatus {
        WorkspaceStatus {
            revision: digest(format!("{}:{safe}", self.status.revision).as_bytes()),
            libraries: self.status.libraries.clone(),
        }
    }

    pub(super) fn by_sha256(&self) -> &std::collections::HashMap<String, Vec<(usize, usize)>> {
        self.by_sha256.get_or_init(|| {
            let mut map: std::collections::HashMap<String, Vec<(usize, usize)>> =
                std::collections::HashMap::new();
            for (provider_index, provider) in self.providers.iter().enumerate() {
                for (image_index, image) in provider.images.iter().enumerate() {
                    map.entry(image.sha256.clone())
                        .or_default()
                        .push((provider_index, image_index));
                }
            }
            map
        })
    }
}
/// Durable known-source facts retain an Adult veto across a disconnected provider.
/// Refreshing that provider replaces its facts; explicitly removing its registration forgets them.
/// Cached unavailable tag definitions are never used for browsing or search.
pub struct Workspace {
    conn: Connection,
    cache: Option<std::sync::Arc<Snapshot>>,
    browse_cache: BrowseCache,
    gate: std::sync::Arc<ImageGate>,
    search_builds: usize,
}
impl Workspace {
    pub fn open(dir: &Path) -> Result<Self, CatalogError> {
        Self::open_with_gate(dir, Default::default())
    }
    /// 与 [`Self::open`] 相同，快照发布到调用方握着的 `gate`（应用壳的缩略图请求不拿工作区的锁）。
    pub fn open_with_gate(
        dir: &Path,
        gate: std::sync::Arc<ImageGate>,
    ) -> Result<Self, CatalogError> {
        std::fs::create_dir_all(dir)?;
        let conn = Connection::open(dir.join("workspace.sqlite"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS provider_facts(library_id TEXT PRIMARY KEY, images TEXT NOT NULL);")?;
        Ok(Self {
            conn,
            cache: None,
            browse_cache: BrowseCache::default(),
            gate,
            search_builds: 0,
        })
    }
    #[doc(hidden)]
    pub fn search_builds(&self) -> usize {
        self.search_builds
    }
    /// 放掉长期只读打开的提供方（[`ImageGate::clear`]）。Windows 上握着句柄时资料库文件夹改不了名、
    /// 删不掉；应用壳在切换、登记变化时经它握着的放行清掉，这里给只持有工作区的调用方用。
    pub fn release_readers(&self) {
        self.gate.clear();
    }
}
fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
