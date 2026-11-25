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
pub use types::{
    STACK_PLACEHOLDER_PAGES, WorkspaceCard, WorkspaceDirectories, WorkspaceDirectory,
    WorkspaceImageSet, WorkspacePage, WorkspaceQuery, WorkspaceScope, WorkspaceSource,
    WorkspaceStatus,
};
mod vocabulary;
use vocabulary::*;

use crate::approx::BuiltinApproxTable;
use crate::library::provider::ProviderImage;
use crate::library::{Error, TagAlias, TagLabel, Vocabulary, VocabularyTag, display_label};
use crate::search::{Candidate, Condition, ConditionTree, Search, SearchInput, Term};
use crate::tag_catalog::{CatalogError, CatalogInspection, TagCatalog, TagCatalogWorkspace};
use crate::{DeviceLibraries, LibraryRegistration};
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

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
        })
    }
    /// 放掉长期只读打开的提供方（[`ImageGate::clear`]）。Windows 上握着句柄时资料库文件夹改不了名、
    /// 删不掉；应用壳在切换、登记变化时经它握着的放行清掉，这里给只持有工作区的调用方用。
    pub fn release_readers(&self) {
        self.gate.clear();
    }
    /// Names and group management share browse safety, while unused definitions remain manageable.
    /// 复用这个工作区的快照（#337）：应用壳经共享的工作区读，不必每次从头装配各提供方。
    pub fn inspect_catalog(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        safe: bool,
    ) -> Result<TagCatalogWorkspace, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        let visible = visible_catalog(&snapshot, safe);
        if self.snapshot(device, catalog)?.status.revision != snapshot.status.revision {
            return Err(Error::CursorExpired.into());
        }
        Ok(TagCatalogWorkspace {
            catalog: visible,
            libraries: snapshot.status.libraries.clone(),
        })
    }
    pub fn status(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        safe: bool,
    ) -> Result<WorkspaceStatus, CatalogError> {
        Ok(self.snapshot(device, catalog)?.status(safe))
    }
    pub fn resolve(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        input: &SearchInput,
        lang: &str,
        safe: bool,
        builtin: &BuiltinApproxTable,
    ) -> Result<ConditionTree, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        // 点分组里还没人用过的预置标签也要解析成它自己（#484），近似对应才能展开。
        let mut vocabulary = global_vocabulary(&snapshot, safe).clone();
        let present = vocabulary
            .tags
            .iter()
            .map(|tag| tag.id.clone())
            .collect::<BTreeSet<_>>();
        vocabulary.tags.extend(
            unattached_preset_tags(&snapshot)
                .into_iter()
                .filter(|tag| !present.contains(&tag.id)),
        );
        let search = Search::new(&vocabulary, builtin);
        Ok(search.resolve_with_tag_fallback(input, lang, |id| {
            // 已点选的标签不因没有活动图片而消失，但仍须遵守安全模式。
            management_vocabulary(&snapshot, safe)
                .tags
                .iter()
                .find(|tag| tag.id == id)
                .map(|tag| display_label(id, tag.namespace, &tag.names, &tag.external, lang))
        }))
    }
    #[allow(clippy::too_many_arguments)]
    pub fn candidates(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        text: &str,
        lang: &str,
        limit: usize,
        safe: bool,
        builtin: &BuiltinApproxTable,
    ) -> Result<Vec<Candidate>, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        Ok(Search::new(global_vocabulary(&snapshot, safe), builtin).candidates(text, lang, limit))
    }
    /// Shared groups use unified identities and the workspace's all-source safety view.
    pub fn tag_groups(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        _library_id: &str,
        lang: &str,
        safe: bool,
    ) -> Result<Vec<crate::library::TagGroupView>, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        catalog.groups(management_vocabulary(&snapshot, safe), lang)
    }
    pub fn shared_tag_groups(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        lang: &str,
        safe: bool,
    ) -> Result<Vec<crate::tag_catalog::CatalogGroupView>, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        catalog.group_views(management_vocabulary(&snapshot, safe), lang)
    }
    /// Every registered root and its complete directory tree share one safety/revision snapshot.
    pub fn directories(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        safe: bool,
    ) -> Result<WorkspaceDirectories, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        let mut providers = Vec::new();
        for provider in &snapshot.providers {
            let (sidebar, unassigned, descendants) = if provider.registration.unavailable.is_none()
            {
                let library = self.provider(device, &provider.registration.library)?;
                let (sidebar, descendants) =
                    directory_sidebar(&snapshot, provider, &library, safe)?;
                if library.provider_revision()? != (provider.list, provider.revision) {
                    return Err(Error::CursorExpired.into());
                }
                let unassigned = provider
                    .images
                    .iter()
                    .filter(|i| {
                        !i.deleted
                            && i.folders.is_empty()
                            && (!safe || !snapshot.adult.contains(&i.sha256))
                    })
                    .count() as u32;
                (Some(sidebar), unassigned, descendants)
            } else {
                (None, 0, BTreeMap::new())
            };
            providers.push(WorkspaceDirectory {
                registration: provider.registration.clone(),
                sidebar,
                unassigned,
                descendants,
            });
        }
        if self.snapshot(device, catalog)?.status.revision != snapshot.status.revision {
            return Err(Error::CursorExpired.into());
        }
        Ok(WorkspaceDirectories {
            status: snapshot.status(safe),
            providers,
            registration_order: device.libraries().iter().map(|r| r.id.clone()).collect(),
        })
    }
    /// Compatibility projection of one provider; forest reads use `directories`.
    pub fn sidebar(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        library_id: &str,
        safe: bool,
    ) -> Result<crate::library::Sidebar, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        let provider = snapshot
            .providers
            .iter()
            .find(|p| p.registration.library.id == library_id)
            .ok_or(CatalogError::UnknownMapping)?;
        // 与 `directories` 一样经长期打开的只读句柄读（#337）：不再每次重新打开资料库。
        let library = self.provider(device, &provider.registration.library)?;
        Ok(directory_sidebar(&snapshot, provider, &library, safe)?.0)
    }
    /// Authorize one image read for a thumbnail or display request (#123) and return its provider
    /// reader: the slow path behind [`ImageGate::authorize`]. Same checks as `contains` bracketed by
    /// an unchanged revision; the snapshot it takes is published to the gate, so the next requests
    /// take the fast path again. The reader is the shared unfiltered one (see `ImageGate`).
    pub fn image_reader(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        library_id: &str,
        image_id: &str,
        safe: bool,
    ) -> Result<std::sync::Arc<crate::library::Library>, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        let allowed = snapshot
            .identities
            .get(&(library_id.into(), image_id.into()))
            .is_some_and(|hash| !safe || !snapshot.adult.contains(hash));
        if !allowed {
            return Err(Error::UnknownImage.into());
        }
        let registration = device
            .libraries()
            .iter()
            .find(|r| r.id == library_id)
            .ok_or(Error::UnknownImage)?
            .clone();
        let library = self.provider(device, &registration)?;
        if self.snapshot(device, catalog)?.status.revision != snapshot.status.revision {
            return Err(Error::CursorExpired.into());
        }
        Ok(library)
    }
    /// 登记的提供方的长期只读句柄（[`ImageGate`]）：不按安全模式过滤，调用方按快照判断封印。
    fn provider(
        &self,
        device: &DeviceLibraries,
        registration: &crate::RegisteredLibrary,
    ) -> Result<std::sync::Arc<crate::library::Library>, CatalogError> {
        self.gate
            .reader(registration, device.safe_mode_scope())
            .map_err(|e| CatalogError::Command(Box::new(e)))
    }
    /// O(log n) authorization after bounded provider/catalog revision checks, including trash views.
    pub fn contains(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        library_id: &str,
        image_id: &str,
        safe: bool,
    ) -> Result<bool, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        let Some(hash) = snapshot
            .identities
            .get(&(library_id.into(), image_id.into()))
        else {
            return Ok(false);
        };
        Ok(!safe || !snapshot.adult.contains(hash))
    }
}
fn directory_sidebar(
    snapshot: &Snapshot,
    provider: &Provider,
    library: &crate::Library,
    safe: bool,
) -> Result<(crate::library::Sidebar, BTreeMap<String, u32>), CatalogError> {
    // Folder structure is independent of local safety; every count is replaced from the global snapshot.
    let mut sidebar = library.sidebar()?;
    let visible = provider
        .images
        .iter()
        .filter(|i| !safe || !snapshot.adult.contains(&i.sha256))
        .collect::<Vec<_>>();
    sidebar.all = visible.iter().filter(|i| !i.deleted).count() as u32;
    sidebar.trash = visible.iter().filter(|i| i.deleted).count() as u32;
    let mut direct: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for image in visible.iter().filter(|i| !i.deleted) {
        for folder in &image.folders {
            direct.entry(folder).or_default().insert(&image.id);
        }
    }
    fn folders<'a>(
        nodes: &mut [crate::library::FolderNode],
        direct: &BTreeMap<&str, BTreeSet<&'a str>>,
        counts: &mut BTreeMap<String, u32>,
    ) -> BTreeSet<&'a str> {
        let mut all = BTreeSet::new();
        for node in nodes {
            let mut images = direct.get(node.id.as_str()).cloned().unwrap_or_default();
            node.count = images.len() as u32;
            images.extend(folders(&mut node.children, direct, counts));
            counts.insert(node.id.clone(), images.len() as u32);
            all.extend(images);
        }
        all
    }
    let mut descendants = BTreeMap::new();
    folders(&mut sidebar.folders, &direct, &mut descendants);
    Ok((sidebar, descendants))
}
fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
