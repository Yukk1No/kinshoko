//! Durable application-level tag identities, independent of Tauri.
//!
//! Local IDs and image decisions remain in each Library. Only an explicit external identity
//! in the same namespace joins identities automatically; names and aliases never do.
mod approx;
mod settings;
pub use settings::CatalogSettingsSnapshot;
mod groups;
mod merges;
mod migration;
mod names;
pub use approx::{
    CatalogApproxConflict, CatalogApproxDecision, CatalogApproxEdit, CatalogApproxEntry,
    CatalogApproxMigration, CatalogApproxOrigin, CatalogApproxSource, CatalogApproxView,
};
mod portable;
mod sync;
mod views;
pub use groups::{
    CatalogGroupDefinition, CatalogGroupEdit, CatalogGroupMigration, CatalogGroupOrigin,
    CatalogGroupSource, CatalogGroupView,
};
pub use migration::{
    LegacyNameDecision, LegacyNameGroup, LegacyNameMigration, LegacyNameMigrationPreview,
    LegacyNameMigrationWorkspace, LegacyNameOutcome, LegacyNameResolution, LegacyNameSource,
};
pub use names::CatalogNameEdit;
pub(crate) use names::fill_names;
use sync::insert_tag;

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
    InvalidDefinition(String),
    UnknownGroup,
    InvalidGroupMembers,
    UnknownMapping,
    NamespaceMismatch,
    UnsupportedFormat,
    InvalidName,
    StaleNameMigration,
    StaleApproxConflict,
    IncompleteNameMigration,
}
impl fmt::Display for CatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "无法保存统一标签目录：{e}"),
            Self::Storage(e) => write!(f, "无法读取统一标签目录：{e}"),
            Self::Data(e) => write!(f, "统一标签目录中的定义无效：{e}"),
            Self::Library(e) => e.fmt(f),
            Self::InvalidDefinition(why) => write!(f, "标签定义无效：{why}"),
            Self::InvalidGroupMembers => write!(f, "分组成员无效，命名空间分组会自动列出该类标签"),
            Self::UnknownGroup => write!(f, "没有这个全局标签分组"),
            Self::UnknownTag => write!(f, "统一标签目录中没有这个标签"),
            Self::UnknownMapping => write!(f, "资料库中没有这个标签对应"),
            Self::NamespaceMismatch => write!(f, "命名空间不同的标签不能对应同一身份"),
            Self::InvalidName => write!(f, "名称与语言不能为空"),
            Self::StaleApproxConflict => {
                write!(f, "个人近似规则或来源已变化，请重新查看冲突后选择")
            }
            Self::StaleNameMigration => write!(f, "名称或标签对应已变化，请重新打开迁移向导"),
            Self::IncompleteNameMigration => write!(f, "请为本批次的每个名称选择归属后再确认"),
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

/// Resolved shared names, with defaults and explicit preferences kept independently.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogTag {
    pub id: String,
    pub namespace: TagNamespace,
    pub names: Vec<LocalizedName>,
    #[serde(default)]
    pub default_names: Vec<LocalizedName>,
    #[serde(default)]
    pub name_preferences: Vec<LocalizedName>,
    pub aliases: Vec<TagAlias>,
    pub external: Vec<ExternalTagIdentity>,
    /// 各资料库的来源名称（ADR-0012），按资料库顺序；`names` 中只作没有名称偏好与默认名称时的兜底。
    #[serde(default)]
    #[ts(as = "Option<Vec<LocalizedName>>", optional)]
    pub source_names: Vec<LocalizedName>,
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
    Catalog,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
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
    /// 这个库内标签现在的来源名称（ADR-0012），单库内优先于默认名称显示。
    #[serde(default)]
    #[ts(as = "Option<Vec<LocalizedName>>", optional)]
    pub source_names: Vec<LocalizedName>,
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

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TagCatalogWorkspace {
    pub catalog: CatalogInspection,
    pub libraries: Vec<LibraryRegistration>,
}

/// Application data, not a cache. Opening or synchronizing never writes a Library.
pub struct TagCatalog {
    dir: std::path::PathBuf,
    conn: Connection,
    name_defaults: Option<crate::library::TagTranslations>,
    /// 每个资料库上次同步时的词表与目录修订号（#158）：都没变时读一张图的标签不必重新同步整份词表。
    synchronized: std::collections::HashMap<String, Synchronized>,
    /// 真正逐个标签核对过的次数，测试用来确认没有变化时不重做（#335）。
    full_synchronizations: u64,
}

struct Synchronized {
    root: std::path::PathBuf,
    vocabulary: i64,
    catalog: i64,
}

impl TagCatalog {
    pub fn open(dir: &Path) -> Result<Self, CatalogError> {
        std::fs::create_dir_all(dir)?;
        let conn = Connection::open(dir.join("tag-catalog.sqlite"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 5 {
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
            -- 库内标签现在的来源名称（#217，ADR-0012），每次同步刷新。
            CREATE TABLE IF NOT EXISTS library_tag_source_name (
                library_id TEXT NOT NULL, local_tag_id TEXT NOT NULL, names TEXT NOT NULL,
                PRIMARY KEY(library_id, local_tag_id));
            COMMIT;",
        )?;
        names::initialize(&conn, version)?;
        migration::initialize(&conn)?;
        groups::initialize(&conn)?;
        approx::initialize(&conn)?;
        Ok(Self {
            dir: dir.to_owned(),
            conn,
            name_defaults: None,
            synchronized: Default::default(),
            full_synchronizations: 0,
        })
    }

    /// Inspect available registered providers without activating them. Unavailable libraries
    /// remain listed; safe-mode-hidden tags and cached unavailable definitions are not exposed.
    pub fn inspect_libraries(
        &mut self,
        libraries: &DeviceLibraries,
        safe_mode: bool,
    ) -> Result<TagCatalogWorkspace, CatalogError> {
        // The same durable all-source facts as workspace browsing, including known offline vetoes.
        // Detached readers leave the active Library lens unchanged; the catalog retains raw definitions.
        let mut workspace = crate::workspace::Workspace::open(&self.dir)?;
        workspace.inspect_catalog(libraries, self, safe_mode)
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
        names::adopt_existing_choice(&tx, &library.info().id, local_tag_id, &catalog_id)?;
        tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        tx.commit()?;
        self.inspect()
    }

    pub fn search_vocabulary(&mut self, library: &Library) -> Result<Vocabulary, CatalogError> {
        let snapshot = self.synchronize(library)?;
        Ok(snapshot.search_vocabulary(&library.info().id, &library.vocabulary()?))
    }

    /// Cheap projection freshness check; does not load any tag definitions.
    pub fn revision(&self) -> Result<i64, CatalogError> {
        Ok(self
            .conn
            .query_row("SELECT value FROM catalog_revision", [], |row| row.get(0))?)
    }

    pub fn inspect(&self) -> Result<CatalogInspection, CatalogError> {
        let revision = self
            .conn
            .query_row("SELECT value FROM catalog_revision", [], |row| row.get(0))?;
        let mut stmt = self
            .conn
            .prepare("SELECT definition FROM catalog_tag ORDER BY id")?;
        let mut tags: Vec<CatalogTag> = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect::<Result<Vec<_>, CatalogError>>()?;
        names::resolve_all(&self.conn, &mut tags)?;
        let mut stmt = self.conn.prepare("SELECT m.library_id,m.local_tag_id,m.catalog_id,m.legacy,m.basis,m.name_provenance,coalesce(s.names,'[]') FROM library_tag_mapping m LEFT JOIN library_tag_source_name s ON s.library_id=m.library_id AND s.local_tag_id=m.local_tag_id ORDER BY m.library_id,m.local_tag_id")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?;
        let mappings = rows
            .map(|row| {
                let (library_id, local_tag_id, catalog_id, legacy, basis, provenance, sources) =
                    row?;
                Ok(LibraryTagMapping {
                    library_id,
                    local_tag_id,
                    catalog_id,
                    legacy: serde_json::from_str(&legacy)?,
                    basis: serde_json::from_str(&basis)?,
                    name_provenance: if provenance == "catalog" {
                        TagNameProvenance::Catalog
                    } else {
                        TagNameProvenance::Pending
                    },
                    source_names: serde_json::from_str(&sources)?,
                })
            })
            .collect::<Result<Vec<_>, CatalogError>>()?;
        Ok(CatalogInspection {
            revision,
            tags,
            mappings,
        })
    }

    /// Publish current content dependencies without exporting application preferences.
    pub fn publish_library_definitions(&mut self, library: &Library) -> Result<(), CatalogError> {
        let snapshot = self.synchronize(library)?;
        let bindings = snapshot
            .content_bindings(&library.info().id, library.tag_definition_dependencies()?)?;
        library.publish_tag_definitions(&bindings)?;
        Ok(())
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
