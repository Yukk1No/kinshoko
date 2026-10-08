//! Durable application-level tag identities, independent of Tauri.
//!
//! Local IDs and image decisions remain in each Library. Only an explicit external identity
//! in the same namespace joins identities automatically; names and aliases never do.
use std::collections::BTreeSet;
use std::fmt;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::library::{
    ImageTags, LocalizedName, TagAlias, TagLabel, TagNamespace, Vocabulary, VocabularyTag,
};
use crate::{DeviceLibraries, Library, LibraryRegistration};

#[derive(Debug)]
pub enum CatalogError {
    Io(std::io::Error),
    Storage(rusqlite::Error),
    Data(serde_json::Error),
    Library(crate::library::Error),
    UnknownTag,
    UnknownMapping,
    NamespaceMismatch,
    UnsupportedFormat,
}
impl fmt::Display for CatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "无法保存统一标签目录：{e}"),
            Self::Storage(e) => write!(f, "无法读取统一标签目录：{e}"),
            Self::Data(e) => write!(f, "统一标签目录中的定义无效：{e}"),
            Self::Library(e) => e.fmt(f),
            Self::UnknownTag => write!(f, "统一标签目录中没有这个标签"),
            Self::UnknownMapping => write!(f, "资料库中没有这个标签对应"),
            Self::NamespaceMismatch => write!(f, "命名空间不同的标签不能对应同一身份"),
            Self::UnsupportedFormat => write!(f, "统一标签目录由更新版本创建，请更新 Kinshoko"),
        }
    }
}
impl std::error::Error for CatalogError {}
impl From<std::io::Error> for CatalogError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<rusqlite::Error> for CatalogError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Storage(e)
    }
}
impl From<serde_json::Error> for CatalogError {
    fn from(e: serde_json::Error) -> Self {
        Self::Data(e)
    }
}
impl From<crate::library::Error> for CatalogError {
    fn from(e: crate::library::Error) -> Self {
        Self::Library(e)
    }
}

/// External vocabulary + value. Neither is a display name or the stable identity.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExternalTagIdentity {
    pub vocabulary: String,
    pub name: String,
}

/// Initial definitions only. Name defaults, preferences and provenance migration are later actions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogTag {
    pub id: String,
    pub namespace: TagNamespace,
    pub names: Vec<LocalizedName>,
    pub aliases: Vec<TagAlias>,
    pub external: Vec<ExternalTagIdentity>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CatalogMatchBasis {
    Independent,
    External,
    ConflictingExternal,
    Corrected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TagNameProvenance {
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LibraryTagMapping {
    pub library_id: String,
    pub local_tag_id: String,
    pub catalog_id: String,
    /// First attached definition. It must not become a global name preference implicitly.
    pub legacy: VocabularyTag,
    pub name_provenance: TagNameProvenance,
    pub basis: CatalogMatchBasis,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogInspection {
    #[ts(type = "number")]
    pub revision: i64,
    pub tags: Vec<CatalogTag>,
    pub mappings: Vec<LibraryTagMapping>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum CatalogCorrection {
    Use { catalog_id: String },
    Separate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ResolvedTagIdentity {
    pub local_tag_id: String,
    pub catalog_id: String,
    /// The shared definition label, for inspection. The image keeps its legacy display label.
    pub tag: TagLabel,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogImageTags {
    pub image: ImageTags,
    pub identities: Vec<ResolvedTagIdentity>,
}

impl CatalogInspection {
    /// A compatibility view: local IDs/primary labels remain usable for Library actions;
    /// the corrected shared definition supplies additional search words and external mappings.
    pub fn search_vocabulary(&self, library_id: &str, vocabulary: &Vocabulary) -> Vocabulary {
        let mut view = vocabulary.clone();
        for local in &mut view.tags {
            let Some(mapping) = self
                .mappings
                .iter()
                .find(|m| m.library_id == library_id && m.local_tag_id == local.id)
            else {
                continue;
            };
            let Some(shared) = self.tags.iter().find(|tag| tag.id == mapping.catalog_id) else {
                continue;
            };
            for alias in shared
                .aliases
                .iter()
                .cloned()
                .chain(shared.names.iter().map(|n| TagAlias {
                    name: n.name.clone(),
                    lang: Some(n.lang.clone()),
                }))
            {
                if !local.aliases.contains(&alias) {
                    local.aliases.push(alias);
                }
            }
            local.external = shared
                .external
                .iter()
                .filter(|e| e.vocabulary == "danbooru")
                .map(|e| e.name.clone())
                .collect();
        }
        view
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TagCatalogWorkspace {
    pub catalog: CatalogInspection,
    pub libraries: Vec<LibraryRegistration>,
}

/// Application data, not a cache. Opening or synchronizing never writes a Library.
pub struct TagCatalog {
    conn: Connection,
}

impl TagCatalog {
    pub fn open(dir: &Path) -> Result<Self, CatalogError> {
        std::fs::create_dir_all(dir)?;
        let conn = Connection::open(dir.join("tag-catalog.sqlite"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 1 {
            return Err(CatalogError::UnsupportedFormat);
        }
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS catalog_revision (value INTEGER NOT NULL);
            INSERT INTO catalog_revision SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM catalog_revision);
            CREATE TABLE IF NOT EXISTS catalog_tag (id TEXT PRIMARY KEY, definition TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS catalog_external (
                namespace TEXT NOT NULL, vocabulary TEXT NOT NULL, name TEXT NOT NULL,
                catalog_id TEXT NOT NULL REFERENCES catalog_tag(id),
                PRIMARY KEY(namespace, vocabulary, name));
            CREATE TABLE IF NOT EXISTS library_tag_mapping (
                library_id TEXT NOT NULL, local_tag_id TEXT NOT NULL,
                catalog_id TEXT NOT NULL REFERENCES catalog_tag(id), legacy TEXT NOT NULL,
                basis TEXT NOT NULL, PRIMARY KEY(library_id, local_tag_id));
            PRAGMA user_version=1;
            COMMIT;",
        )?;
        Ok(Self { conn })
    }

    /// Attach visible local definitions. Repeated attachment retains explicit corrections and
    /// the original names awaiting migration. A matching name or alias is never evidence of identity.
    pub fn synchronize(&mut self, library: &Library) -> Result<CatalogInspection, CatalogError> {
        let vocabulary = library.vocabulary()?;
        let library_id = &library.info().id;
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut changed = false;
        for local in vocabulary.tags {
            let existing = tx.query_row("SELECT catalog_id,basis FROM library_tag_mapping WHERE library_id=?1 AND local_tag_id=?2", params![library_id, local.id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).optional()?;
            if let Some((_, basis)) = &existing
                && serde_json::from_str::<CatalogMatchBasis>(basis)? == CatalogMatchBasis::Corrected
            {
                continue;
            }
            let ns = serde_json::to_string(&local.namespace)?;
            let mut candidates = BTreeSet::new();
            for external in &local.external {
                if let Some(id) = tx.query_row("SELECT catalog_id FROM catalog_external WHERE namespace=?1 AND vocabulary='danbooru' AND name=?2", params![ns, external], |row| row.get::<_, String>(0)).optional()? {
                    candidates.insert(id);
                }
            }
            if let Some((id, prior_basis)) = existing {
                let prior_basis: CatalogMatchBasis = serde_json::from_str(&prior_basis)?;
                let target = if candidates.len() == 1 {
                    candidates.iter().next().expect("one candidate").clone()
                } else {
                    id.clone()
                };
                let basis = if candidates.len() > 1 {
                    CatalogMatchBasis::ConflictingExternal
                } else if target != id {
                    CatalogMatchBasis::External
                } else {
                    prior_basis
                };
                if target != id || basis != prior_basis {
                    tx.execute("UPDATE library_tag_mapping SET catalog_id=?3,basis=?4 WHERE library_id=?1 AND local_tag_id=?2", params![library_id, local.id, target, serde_json::to_string(&basis)?])?;
                    changed = true;
                }
                if candidates.len() <= 1 {
                    changed |= extend_externals(&tx, &target, &local.external)?;
                }
                continue;
            }
            let (id, basis) = if candidates.len() == 1 {
                let id = candidates.into_iter().next().expect("one candidate");
                extend_externals(&tx, &id, &local.external)?;
                (id, CatalogMatchBasis::External)
            } else if candidates.len() > 1 {
                let mut independent = local.clone();
                independent.external.clear();
                (
                    insert_tag(&tx, &independent)?,
                    CatalogMatchBasis::ConflictingExternal,
                )
            } else {
                (insert_tag(&tx, &local)?, CatalogMatchBasis::Independent)
            };
            tx.execute("INSERT INTO library_tag_mapping (library_id,local_tag_id,catalog_id,legacy,basis) VALUES (?1,?2,?3,?4,?5)", params![library_id, local.id, id, serde_json::to_string(&local)?, serde_json::to_string(&basis)?])?;
            changed = true;
        }
        if changed {
            tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        }
        tx.commit()?;
        self.inspect()
    }

    /// Inspect available registered providers without activating them. Unavailable libraries
    /// remain listed; safe-mode-hidden tags and cached unavailable definitions are not exposed.
    pub fn inspect_libraries(
        &mut self,
        libraries: &DeviceLibraries,
        safe_mode: bool,
    ) -> Result<TagCatalogWorkspace, CatalogError> {
        let mut registrations = Vec::new();
        let mut visible = BTreeSet::new();
        for registration in libraries.libraries() {
            let unavailable = match libraries.read(&registration.id) {
                Ok(library) => {
                    library.set_safe_mode(safe_mode);
                    match library.vocabulary() {
                        Ok(vocabulary) => {
                            visible.extend(
                                vocabulary
                                    .tags
                                    .into_iter()
                                    .map(|tag| (registration.id.clone(), tag.id)),
                            );
                            self.synchronize(&library)?;
                            None
                        }
                        Err(error) => Some(error.to_string()),
                    }
                }
                Err(error) => Some(error.to_string()),
            };
            registrations.push(LibraryRegistration {
                library: registration.clone(),
                unavailable,
            });
        }
        let mut catalog = self.inspect()?;
        catalog
            .mappings
            .retain(|m| visible.contains(&(m.library_id.clone(), m.local_tag_id.clone())));
        let identities = catalog
            .mappings
            .iter()
            .map(|m| m.catalog_id.clone())
            .collect::<BTreeSet<_>>();
        catalog.tags.retain(|tag| identities.contains(&tag.id));
        Ok(TagCatalogWorkspace {
            catalog,
            libraries: registrations,
        })
    }

    /// Correct one local mapping. The local tag must still exist. Explicit choices survive
    /// subsequent synchronization, including a source's old external correspondence.
    pub fn correct(
        &mut self,
        library: &Library,
        local_tag_id: &str,
        correction: CatalogCorrection,
    ) -> Result<CatalogInspection, CatalogError> {
        let local = library
            .vocabulary()?
            .tags
            .into_iter()
            .find(|t| t.id == local_tag_id)
            .ok_or(CatalogError::UnknownMapping)?;
        self.synchronize(library)?;
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let catalog_id = match correction {
            CatalogCorrection::Use { catalog_id } => {
                let definition: String = tx
                    .query_row(
                        "SELECT definition FROM catalog_tag WHERE id=?1",
                        [&catalog_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .ok_or(CatalogError::UnknownTag)?;
                let target: CatalogTag = serde_json::from_str(&definition)?;
                if target.namespace != local.namespace {
                    return Err(CatalogError::NamespaceMismatch);
                }
                catalog_id
            }
            CatalogCorrection::Separate => {
                let mut independent = local.clone();
                // The old external value belongs to the previous identity. An explicit split
                // must not silently reclaim it or undo itself on the next attachment.
                independent.external.clear();
                insert_tag(&tx, &independent)?
            }
        };
        tx.execute("UPDATE library_tag_mapping SET catalog_id=?3,basis=?4 WHERE library_id=?1 AND local_tag_id=?2", params![library.info().id, local_tag_id, catalog_id, serde_json::to_string(&CatalogMatchBasis::Corrected)?])?;
        tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        tx.commit()?;
        self.inspect()
    }

    pub fn search_vocabulary(&mut self, library: &Library) -> Result<Vocabulary, CatalogError> {
        let snapshot = self.synchronize(library)?;
        Ok(snapshot.search_vocabulary(&library.info().id, &library.vocabulary()?))
    }

    /// Identity inspection for effective and rejected image tags; manual actions continue to use
    /// each local ID and its original display label.
    pub fn image_tags(
        &mut self,
        library: &Library,
        image_id: &str,
        lang: &str,
    ) -> Result<CatalogImageTags, CatalogError> {
        let image = library.image_tags(image_id, lang)?;
        let snapshot = self.synchronize(library)?;
        let mut identities = Vec::new();
        for label in image
            .tags
            .iter()
            .map(|t| &t.tag)
            .chain(image.rejected.iter())
        {
            let Some(mapping) = snapshot
                .mappings
                .iter()
                .find(|m| m.library_id == library.info().id && m.local_tag_id == label.id)
            else {
                continue;
            };
            let Some(shared) = snapshot
                .tags
                .iter()
                .find(|tag| tag.id == mapping.catalog_id)
            else {
                continue;
            };
            let external = shared
                .external
                .iter()
                .map(|e| e.name.clone())
                .collect::<Vec<_>>();
            identities.push(ResolvedTagIdentity {
                local_tag_id: label.id.clone(),
                catalog_id: shared.id.clone(),
                tag: crate::library::display_label(
                    &shared.id,
                    shared.namespace,
                    &shared.names,
                    &external,
                    lang,
                ),
            });
        }
        Ok(CatalogImageTags { image, identities })
    }

    pub fn inspect(&self) -> Result<CatalogInspection, CatalogError> {
        let revision = self
            .conn
            .query_row("SELECT value FROM catalog_revision", [], |row| row.get(0))?;
        let mut stmt = self
            .conn
            .prepare("SELECT definition FROM catalog_tag ORDER BY id")?;
        let tags = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect::<Result<Vec<_>, CatalogError>>()?;
        let mut stmt = self.conn.prepare("SELECT library_id,local_tag_id,catalog_id,legacy,basis FROM library_tag_mapping ORDER BY library_id,local_tag_id")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        let mappings = rows
            .map(|row| {
                let (library_id, local_tag_id, catalog_id, legacy, basis) = row?;
                Ok(LibraryTagMapping {
                    library_id,
                    local_tag_id,
                    catalog_id,
                    legacy: serde_json::from_str(&legacy)?,
                    basis: serde_json::from_str(&basis)?,
                    name_provenance: TagNameProvenance::Pending,
                })
            })
            .collect::<Result<Vec<_>, CatalogError>>()?;
        Ok(CatalogInspection {
            revision,
            tags,
            mappings,
        })
    }

    /// Resolve the application identity without assuming equality with any library's local ID.
    pub fn local_tag_ids(
        &self,
        library_id: &str,
        catalog_id: &str,
    ) -> Result<Vec<String>, CatalogError> {
        let mut stmt = self.conn.prepare("SELECT local_tag_id FROM library_tag_mapping WHERE library_id=?1 AND catalog_id=?2 ORDER BY local_tag_id")?;
        Ok(stmt
            .query_map(params![library_id, catalog_id], |row| row.get(0))?
            .collect::<Result<_, _>>()?)
    }
}

fn insert_tag(tx: &Transaction<'_>, local: &VocabularyTag) -> Result<String, CatalogError> {
    let id = uuid::Uuid::now_v7().simple().to_string();
    let ns = serde_json::to_string(&local.namespace)?;
    let mut tag = CatalogTag {
        id: id.clone(),
        namespace: local.namespace,
        names: local.names.clone(),
        aliases: local.aliases.clone(),
        external: Vec::new(),
    };
    tx.execute(
        "INSERT INTO catalog_tag (id,definition) VALUES (?1,'{}')",
        [&id],
    )?;
    for name in &local.external {
        let inserted = tx.execute("INSERT OR IGNORE INTO catalog_external (namespace,vocabulary,name,catalog_id) VALUES (?1,'danbooru',?2,?3)", params![ns, name, id])?;
        if inserted == 1 {
            tag.external.push(ExternalTagIdentity {
                vocabulary: "danbooru".into(),
                name: name.clone(),
            });
        }
    }
    tx.execute(
        "UPDATE catalog_tag SET definition=?2 WHERE id=?1",
        params![id, serde_json::to_string(&tag)?],
    )?;
    Ok(id)
}

fn extend_externals(
    tx: &Transaction<'_>,
    id: &str,
    values: &[String],
) -> Result<bool, CatalogError> {
    let definition: String = tx.query_row(
        "SELECT definition FROM catalog_tag WHERE id=?1",
        [id],
        |row| row.get(0),
    )?;
    let mut tag: CatalogTag = serde_json::from_str(&definition)?;
    let ns = serde_json::to_string(&tag.namespace)?;
    let mut changed = false;
    for name in values {
        let inserted = tx.execute("INSERT OR IGNORE INTO catalog_external (namespace,vocabulary,name,catalog_id) VALUES (?1,'danbooru',?2,?3)", params![ns, name, id])?;
        if inserted == 1 {
            changed = true;
            tag.external.push(ExternalTagIdentity {
                vocabulary: "danbooru".into(),
                name: name.clone(),
            });
        }
    }
    if !changed {
        return Ok(false);
    }
    tag.external.sort();
    tx.execute(
        "UPDATE catalog_tag SET definition=?2 WHERE id=?1",
        params![id, serde_json::to_string(&tag)?],
    )?;
    Ok(true)
}
