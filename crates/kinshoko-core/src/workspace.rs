//! Default workspace over registered, detached read-only content providers.
//! Each source executes the complete Library query; only afterwards are byte identities joined.
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
    providers: Vec<Provider>,
    catalog: CatalogInspection,
    status: WorkspaceStatus,
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
}
impl Workspace {
    pub fn open(dir: &Path) -> Result<Self, CatalogError> {
        std::fs::create_dir_all(dir)?;
        let conn = Connection::open(dir.join("workspace.sqlite"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS provider_facts(library_id TEXT PRIMARY KEY, images TEXT NOT NULL);")?;
        Ok(Self { conn, cache: None })
    }
    /// Only provider/catalog revisions and availability are read on a cache hit.
    /// Inventory, tag counts and source safety indexes rebuild only after those facts change.
    fn snapshot(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
    ) -> Result<std::sync::Arc<Snapshot>, CatalogError> {
        let mut readers = BTreeMap::new();
        let mut observed = Vec::new();
        for registration in device.libraries() {
            let result = device
                .read(&registration.id)
                .map_err(|e| e.to_string())
                .and_then(|library| {
                    let revisions = library.provider_revision().map_err(|e| e.to_string())?;
                    Ok((library, revisions))
                });
            match result {
                Ok((library, (list, revision))) => {
                    readers.insert(registration.id.clone(), library);
                    observed.push((registration.clone(), None, list, revision));
                }
                Err(error) => observed.push((registration.clone(), Some(error), -1, -1)),
            }
        }
        observed.sort_by(|a, b| a.0.id.cmp(&b.0.id));
        let fingerprint = |revision| -> Result<String, CatalogError> {
            Ok(digest(&serde_json::to_vec(&(revision, &observed))?))
        };
        let key = fingerprint(catalog.revision()?)?;
        if let Some(cache) = &self.cache
            && cache.status.revision == key
        {
            return Ok(cache.clone());
        }

        let ids = device
            .libraries()
            .iter()
            .map(|r| r.id.as_str())
            .collect::<BTreeSet<_>>();
        let cached_ids = {
            let mut stmt = self.conn.prepare("SELECT library_id FROM provider_facts")?;
            stmt.query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for id in cached_ids {
            if !ids.contains(id.as_str()) {
                self.conn
                    .execute("DELETE FROM provider_facts WHERE library_id=?1", [id])?;
            }
        }
        let mut providers = Vec::new();
        for (registration, unavailable, list, revision) in &observed {
            let prior = self.cache.as_ref().and_then(|cache| {
                cache.providers.iter().find(|p| {
                    p.registration.library == *registration
                        && p.registration.unavailable == *unavailable
                        && p.list == *list
                        && p.revision == *revision
                })
            });
            if let Some(prior) = prior {
                providers.push(prior.clone());
                continue;
            }
            let (images, vocabulary) = if let Some(library) = readers.get(&registration.id) {
                // Detached reader only. Current Library's safe mode is never modified.
                library.set_safe_mode(false);
                catalog.synchronize(library)?;
                let snapshot = library.provider_snapshot()?;
                let vocabulary = library.vocabulary()?;
                if (snapshot.list_revision, snapshot.vocabulary_revision) != (*list, *revision)
                    || vocabulary.revision != *revision
                {
                    return Err(Error::CursorExpired.into());
                }
                self.conn.execute("INSERT INTO provider_facts(library_id,images) VALUES (?1,?2) ON CONFLICT(library_id) DO UPDATE SET images=excluded.images",
                    params![registration.id, serde_json::to_string(&snapshot.images)?])?;
                (snapshot.images, Some(vocabulary))
            } else {
                use rusqlite::OptionalExtension;
                let text: Option<String> = self
                    .conn
                    .query_row(
                        "SELECT images FROM provider_facts WHERE library_id=?1",
                        [&registration.id],
                        |r| r.get(0),
                    )
                    .optional()?;
                (
                    text.map(|s| serde_json::from_str(&s))
                        .transpose()?
                        .unwrap_or_default(),
                    None,
                )
            };
            providers.push(Provider {
                registration: LibraryRegistration {
                    library: registration.clone(),
                    unavailable: unavailable.clone(),
                },
                images,
                vocabulary,
                list: *list,
                revision: *revision,
            });
        }
        // Reject an inventory assembled across a provider change.
        for (id, reader) in &readers {
            let (_, _, list, revision) = observed
                .iter()
                .find(|(r, _, _, _)| &r.id == id)
                .expect("registered reader");
            if reader.provider_revision()? != (*list, *revision) {
                return Err(Error::CursorExpired.into());
            }
        }
        let inspection = catalog.inspect()?;
        let key = fingerprint(inspection.revision)?;
        let adult = providers
            .iter()
            .flat_map(|p| &p.images)
            .filter(|i| i.adult)
            .map(|i| i.sha256.clone())
            .collect();
        let identities = providers
            .iter()
            .filter(|p| p.registration.unavailable.is_none())
            .flat_map(|p| {
                p.images.iter().map(|i| {
                    (
                        (p.registration.library.id.clone(), i.id.clone()),
                        i.sha256.clone(),
                    )
                })
            })
            .collect();
        let status = WorkspaceStatus {
            revision: key,
            libraries: providers.iter().map(|p| p.registration.clone()).collect(),
        };
        let snapshot = std::sync::Arc::new(Snapshot {
            providers,
            catalog: inspection,
            status,
            adult,
            identities,
            safe_vocabulary: std::sync::OnceLock::new(),
            full_vocabulary: std::sync::OnceLock::new(),
            safe_management_vocabulary: std::sync::OnceLock::new(),
            full_management_vocabulary: std::sync::OnceLock::new(),
        });
        self.cache = Some(snapshot.clone());
        Ok(snapshot)
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
    pub fn browse(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        query: &WorkspaceQuery,
        safe: bool,
    ) -> Result<WorkspacePage, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        let status = snapshot.status(safe);
        if let WorkspaceScope::Library { library_id, .. } = &query.scope {
            let provider = snapshot
                .providers
                .iter()
                .find(|p| p.registration.library.id == *library_id)
                .ok_or_else(|| {
                    CatalogError::Io(std::io::Error::other(
                        "本设备没有登记这个资料库；当前查找范围保持原值",
                    ))
                })?;
            if let Some(reason) = &provider.registration.unavailable {
                return Err(CatalogError::Io(std::io::Error::other(reason.clone())));
            }
        }
        let key = digest(&serde_json::to_vec(&(
            &status.revision,
            &query.scope,
            &query.conditions,
        ))?);
        let offset = match &query.cursor {
            None => 0,
            Some(cursor) => {
                let (revision, offset) = cursor.split_once(':').ok_or(Error::InvalidCursor)?;
                if revision != key {
                    return Err(Error::CursorExpired.into());
                }
                offset.parse::<usize>().map_err(|_| Error::InvalidCursor)?
            }
        };
        let mut matches = BTreeMap::<String, BTreeSet<String>>::new();
        for provider in &snapshot.providers {
            if provider.registration.unavailable.is_some() {
                continue;
            }
            let id = &provider.registration.library.id;
            let scope = match &query.scope {
                WorkspaceScope::Library { library_id, scope } if library_id == id => scope.clone(),
                WorkspaceScope::Library { .. } => continue,
                WorkspaceScope::All => BrowseScope::All,
            };
            let tree = local_tree(&query.conditions, &snapshot.catalog, id);
            let library = device
                .read(id)
                .map_err(|e| CatalogError::Io(std::io::Error::other(e.to_string())))?;
            let found = library.provider_matches(&scope, &tree)?;
            if library.provider_revision()? != (provider.list, provider.revision) {
                return Err(Error::CursorExpired.into());
            }
            matches.insert(id.clone(), found);
        }
        let matched = |provider: &Provider, image: &ProviderImage| {
            matches
                .get(&provider.registration.library.id)
                .is_some_and(|ids| ids.contains(&image.id))
        };
        let mut groups = BTreeMap::<String, Vec<(&Provider, &ProviderImage)>>::new();
        for provider in &snapshot.providers {
            for image in &provider.images {
                groups
                    .entry(image.sha256.clone())
                    .or_default()
                    .push((provider, image));
            }
        }
        let mut rows = Vec::new();
        for (id, sources) in groups {
            let adult = snapshot.adult.contains(&id);
            if safe && adult {
                continue;
            }
            let Some((provider, image)) = sources.iter().find(|(p, i)| matched(p, i)) else {
                continue;
            };
            let source_library = &provider.registration.library.id;
            let newest = sources
                .iter()
                .filter(|(p, i)| matched(p, i))
                .map(|(_, i)| i.seq)
                .max()
                .unwrap_or(0);
            rows.push((
                newest,
                WorkspaceCard {
                    id,
                    width: image.width,
                    height: image.height,
                    adult,
                    thumbnail: format!("{source_library}/{}/{}", image.id, query.thumbnail_px),
                    library_id: source_library.clone(),
                    image_id: image.id.clone(),
                    sources: sources
                        .iter()
                        .map(|(p, i)| WorkspaceSource {
                            library_id: p.registration.library.id.clone(),
                            library_name: p.registration.library.name.clone(),
                            image_id: i.id.clone(),
                            deleted: i.deleted,
                            unavailable: p.registration.unavailable.clone(),
                            matches: matched(p, i),
                        })
                        .collect(),
                },
            ));
        }
        rows.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.id.cmp(&b.1.id)));
        let total = rows.len() as u32;
        let limit = query.limit.clamp(1, 1000) as usize;
        let next = offset.saturating_add(limit);
        let next_cursor = (next < rows.len()).then(|| format!("{key}:{next}"));
        // Includes registration, catalog and changes in providers that did not match this query.
        if self.snapshot(device, catalog)?.status.revision != snapshot.status.revision {
            return Err(Error::CursorExpired.into());
        }
        Ok(WorkspacePage {
            cards: rows
                .into_iter()
                .skip(offset)
                .take(limit)
                .map(|(_, c)| c)
                .collect(),
            total,
            next_cursor,
            status,
        })
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
fn local_labels(tag: &TagLabel, catalog: &CatalogInspection, library: &str) -> Vec<TagLabel> {
    catalog
        .mappings
        .iter()
        .filter(|m| m.library_id == library && m.catalog_id == tag.id)
        .map(|m| TagLabel {
            id: m.local_tag_id.clone(),
            ..tag.clone()
        })
        .collect()
}
fn local_tree(tree: &ConditionTree, catalog: &CatalogInspection, library: &str) -> ConditionTree {
    ConditionTree {
        conditions: tree
            .conditions
            .iter()
            .map(|condition| Condition {
                negate: condition.negate,
                any: condition
                    .any
                    .iter()
                    .flat_map(|term| match term {
                        Term::Tag { tag, similar } => std::iter::once(tag)
                            .chain(similar.iter().map(|s| &s.tag))
                            .flat_map(|label| local_labels(label, catalog, library))
                            .map(|tag| Term::Tag {
                                tag,
                                similar: vec![],
                            })
                            .collect(),
                        Term::Text {
                            text,
                            tags,
                            similar,
                        } => vec![Term::Text {
                            text: text.clone(),
                            tags: tags
                                .iter()
                                .chain(similar.iter().map(|s| &s.tag))
                                .flat_map(|label| local_labels(label, catalog, library))
                                .collect(),
                            similar: vec![],
                        }],
                    })
                    .collect(),
            })
            .collect(),
    }
}
/// Preserve definitions with no effective usage. Hide only definitions whose usage is all vetoed.
/// Deleted images still establish usage, matching Library's sealed-only rule; counts exclude trash.
fn visible_catalog(snapshot: &Snapshot, safe: bool) -> CatalogInspection {
    let mut visible = BTreeSet::new();
    for provider in &snapshot.providers {
        let Some(vocabulary) = &provider.vocabulary else {
            continue;
        };
        let mut sealed = BTreeSet::new();
        let mut unsealed = BTreeSet::new();
        if safe {
            for image in &provider.images {
                let target = if snapshot.adult.contains(&image.sha256) {
                    &mut sealed
                } else {
                    &mut unsealed
                };
                target.extend(image.tags.iter().map(String::as_str));
            }
        }
        visible.extend(
            vocabulary
                .tags
                .iter()
                .filter(|tag| {
                    !sealed.contains(tag.id.as_str()) || unsealed.contains(tag.id.as_str())
                })
                .map(|tag| (provider.registration.library.id.as_str(), tag.id.as_str())),
        );
    }
    let mut catalog = snapshot.catalog.clone();
    catalog.mappings.retain(|mapping| {
        visible.contains(&(mapping.library_id.as_str(), mapping.local_tag_id.as_str()))
    });
    let ids = catalog
        .mappings
        .iter()
        .map(|mapping| mapping.catalog_id.as_str())
        .collect::<BTreeSet<_>>();
    catalog.tags.retain(|tag| ids.contains(tag.id.as_str()));
    catalog
}
/// Search candidates remain tied to live effective usage. Management also retains legitimate zero-use definitions.
fn management_vocabulary(snapshot: &Snapshot, safe: bool) -> &Vocabulary {
    let cache = if safe {
        &snapshot.safe_management_vocabulary
    } else {
        &snapshot.full_management_vocabulary
    };
    cache.get_or_init(|| {
        let mut vocabulary = global_vocabulary(snapshot, safe).clone();
        let present = vocabulary
            .tags
            .iter()
            .map(|tag| tag.id.clone())
            .collect::<BTreeSet<_>>();
        for tag in visible_catalog(snapshot, safe).tags {
            if !present.contains(&tag.id) {
                vocabulary.tags.push(VocabularyTag {
                    id: tag.id,
                    namespace: tag.namespace,
                    names: tag.names,
                    aliases: tag.aliases,
                    external: tag
                        .external
                        .into_iter()
                        .filter(|entry| entry.vocabulary == "danbooru")
                        .map(|entry| entry.name)
                        .collect(),
                    count: 0,
                });
            }
        }
        vocabulary.tags.sort_by(|a, b| a.id.cmp(&b.id));
        vocabulary
    })
}
fn global_vocabulary(snapshot: &Snapshot, safe: bool) -> &Vocabulary {
    let cache = if safe {
        &snapshot.safe_vocabulary
    } else {
        &snapshot.full_vocabulary
    };
    cache.get_or_init(|| build_vocabulary(snapshot, safe))
}
fn build_vocabulary(snapshot: &Snapshot, safe: bool) -> Vocabulary {
    let hidden = &snapshot.adult;
    let mut counts = BTreeMap::<String, BTreeSet<String>>::new();
    let mut tags = BTreeMap::<String, VocabularyTag>::new();
    for provider in &snapshot.providers {
        let Some(local_vocabulary) = &provider.vocabulary else {
            continue;
        };
        let vocabulary = snapshot
            .catalog
            .search_vocabulary(&provider.registration.library.id, local_vocabulary);
        let mappings = snapshot
            .catalog
            .mappings
            .iter()
            .filter(|m| m.library_id == provider.registration.library.id)
            .map(|m| (m.local_tag_id.as_str(), m.catalog_id.as_str()))
            .collect::<BTreeMap<_, _>>();
        // One pass over effective memberships; no vocabulary × image scan.
        let mut visible = BTreeMap::<&str, BTreeSet<String>>::new();
        for image in &provider.images {
            if image.deleted || (safe && hidden.contains(&image.sha256)) {
                continue;
            }
            for local_id in &image.tags {
                visible
                    .entry(local_id.as_str())
                    .or_default()
                    .insert(image.sha256.clone());
            }
        }
        for local in &vocabulary.tags {
            let Some(catalog_id) = mappings.get(local.id.as_str()) else {
                continue;
            };
            let Some(hashes) = visible.remove(local.id.as_str()) else {
                continue;
            };
            if hashes.is_empty() {
                continue;
            }
            counts
                .entry((*catalog_id).to_owned())
                .or_default()
                .extend(hashes);
            let entry = tags
                .entry((*catalog_id).to_owned())
                .or_insert_with(|| VocabularyTag {
                    id: (*catalog_id).to_owned(),
                    count: 0,
                    ..local.clone()
                });
            for alias in local
                .aliases
                .iter()
                .cloned()
                .chain(local.names.iter().map(|n| TagAlias {
                    name: n.name.clone(),
                    lang: Some(n.lang.clone()),
                }))
            {
                if !entry.aliases.contains(&alias) {
                    entry.aliases.push(alias);
                }
            }
            for external in &local.external {
                if !entry.external.contains(external) {
                    entry.external.push(external.clone());
                }
            }
        }
    }
    for (id, tag) in &mut tags {
        tag.count = counts.get(id).map_or(0, |c| c.len() as u32);
    }
    Vocabulary {
        revision: snapshot.catalog.revision,
        tags: tags.into_values().collect(),
        personal_approx: vec![],
    }
}

impl Workspace {
    pub fn edit_group(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        edit: &crate::tag_catalog::CatalogGroupEdit,
        safe: bool,
    ) -> Result<(), CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        catalog.edit_group(edit, management_vocabulary(&snapshot, safe))
    }
}
