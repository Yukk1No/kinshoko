//! Default workspace over registered, detached read-only content providers.
//! Each source executes the complete Library query; only afterwards are byte identities joined.
mod import_preview;
pub(crate) use import_preview::ImportPreviewAuthorization;
pub use import_preview::{
    ImportPreviewContent, ImportPreviewSession, PreparedImportPreview, ResolvedImportPreview,
};
mod source;
pub use source::{
    WorkspaceSourceBatch, WorkspaceSourceInspection, WorkspaceSourceTarget, group_sources,
};
mod browse;
use browse::BrowseCache;
mod snapshot;
pub use snapshot::ProviderReaders;
mod vocabulary;
use vocabulary::*;

use crate::approx::BuiltinApproxTable;
use crate::library::provider::ProviderImage;
use crate::library::{BrowseScope, Error, TagAlias, TagLabel, Vocabulary, VocabularyTag};
use crate::search::{Candidate, Condition, ConditionTree, Search, SearchInput, Term};
use crate::tag_catalog::{CatalogError, CatalogInspection, TagCatalog, TagCatalogWorkspace};
use crate::{DeviceLibraries, LibraryRegistration};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum WorkspaceScope {
    #[default]
    All,
    Library {
        library_id: String,
        #[serde(default)]
        scope: BrowseScope,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceQuery {
    #[serde(default)]
    pub scope: WorkspaceScope,
    #[serde(default)]
    pub conditions: ConditionTree,
    #[serde(default)]
    pub cursor: Option<String>,
    pub limit: u32,
    pub thumbnail_px: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceSource {
    pub library_id: String,
    pub library_name: String,
    pub image_id: String,
    pub unavailable: Option<String>,
    pub matches: bool,
    pub deleted: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceCard {
    /// Stable byte identity, also used for scroll anchors.
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub thumbnail: String,
    /// 占位图（#110）的 `data:` 地址，取自显示用的来源；还没生成时为空。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub placeholder: Option<String>,
    pub adult: bool,
    /// Explicit available matching source used for display; browsing never activates it.
    pub library_id: String,
    pub image_id: String,
    pub sources: Vec<WorkspaceSource>,
}
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceStatus {
    pub revision: String,
    pub libraries: Vec<LibraryRegistration>,
}
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspacePage {
    pub cards: Vec<WorkspaceCard>,
    pub next_cursor: Option<String>,
    pub total: u32,
    pub status: WorkspaceStatus,
}
/// One provider root. Missing providers keep their identity and reason, without stale folders/counts.
/// `descendants` counts live visible images per subtree, deduplicated across folder memberships.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceDirectory {
    pub registration: LibraryRegistration,
    pub sidebar: Option<crate::library::Sidebar>,
    pub unassigned: u32,
    pub descendants: BTreeMap<String, u32>,
}
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceDirectories {
    pub status: WorkspaceStatus,
    pub providers: Vec<WorkspaceDirectory>,
}
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
}
impl Snapshot {
    fn status(&self, safe: bool) -> WorkspaceStatus {
        WorkspaceStatus {
            revision: digest(format!("{}:{safe}", self.status.revision).as_bytes()),
            libraries: self.status.libraries.clone(),
        }
    }
}
/// Durable known-source facts retain an Adult veto across a disconnected provider.
/// Refreshing that provider replaces its facts; explicitly removing its registration forgets them.
/// Cached unavailable tag definitions are never used for browsing or search.
pub struct Workspace {
    conn: Connection,
    cache: Option<std::sync::Arc<Snapshot>>,
    browse_cache: BrowseCache,
}
impl Workspace {
    pub fn open(dir: &Path) -> Result<Self, CatalogError> {
        std::fs::create_dir_all(dir)?;
        let conn = Connection::open(dir.join("workspace.sqlite"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS provider_facts(library_id TEXT PRIMARY KEY, images TEXT NOT NULL);")?;
        Ok(Self {
            conn,
            cache: None,
            browse_cache: BrowseCache::default(),
        })
    }
    /// Names and group management share browse safety, while unused definitions remain manageable.
    pub(crate) fn inspect_catalog(
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
        Ok(Search::new(global_vocabulary(&snapshot, safe), builtin).resolve(input, lang))
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
    pub fn local_tags(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        library_id: &str,
        ids: &[String],
        safe: bool,
    ) -> Result<Vec<String>, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        let vocabulary = global_vocabulary(&snapshot, safe);
        Ok(snapshot
            .catalog
            .mappings
            .iter()
            .filter(|m| {
                m.library_id == library_id
                    && ids.contains(&m.local_tag_id)
                    && vocabulary.tags.iter().any(|t| t.id == m.catalog_id)
            })
            .map(|m| m.catalog_id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect())
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
                let library = device
                    .read(&provider.registration.library.id)
                    .map_err(|e| CatalogError::Io(std::io::Error::other(e.to_string())))?;
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
        let library = device
            .read(library_id)
            .map_err(|e| CatalogError::Io(std::io::Error::other(e.to_string())))?;
        let provider = snapshot
            .providers
            .iter()
            .find(|p| p.registration.library.id == library_id)
            .ok_or(CatalogError::UnknownMapping)?;
        Ok(directory_sidebar(&snapshot, provider, &library, safe)?.0)
    }
    /// Authorize one image read for a thumbnail or display request (#123) and return its provider
    /// reader. Same checks as `contains` bracketed by an unchanged revision, but the snapshot is built
    /// once and each provider is opened at most once per `opened`; call again with the same `opened`
    /// after reading the file to re-check without reopening anything.
    pub fn image_reader(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        opened: &mut ProviderReaders,
        library_id: &str,
        image_id: &str,
        safe: bool,
    ) -> Result<std::sync::Arc<crate::library::Library>, CatalogError> {
        let snapshot = self.snapshot_reusing(device, catalog, opened)?;
        let allowed = snapshot
            .identities
            .get(&(library_id.into(), image_id.into()))
            .is_some_and(|hash| !safe || !snapshot.adult.contains(hash));
        if !allowed {
            return Err(Error::UnknownImage.into());
        }
        let library = opened
            .read(device, library_id)
            .map_err(|e| CatalogError::Io(std::io::Error::other(e)))?;
        if self
            .snapshot_reusing(device, catalog, opened)?
            .status
            .revision
            != snapshot.status.revision
        {
            return Err(Error::CursorExpired.into());
        }
        library.set_safe_mode(safe);
        Ok(library)
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
