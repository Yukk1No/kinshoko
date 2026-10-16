//! Application-level groups; Library group rows are an immutable migration source.
use super::*;
use crate::library::{TagCount, TagGroupDefinition, TagGroupView};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogGroupSource {
    pub library_id: String,
    pub library_name: String,
    pub group: TagGroupDefinition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogGroupDefinition {
    pub id: String,
    pub name: String,
    pub namespace: Option<TagNamespace>,
    pub members: Vec<String>,
    pub sources: Vec<CatalogGroupSource>,
}

/// A null target records a migrated group which the user subsequently deleted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogGroupMigration {
    pub source: CatalogGroupSource,
    pub target: Option<String>,
}

/// Safe configuration provenance; no original member IDs or labels leave the read adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogGroupOrigin {
    pub library_id: String,
    pub library_name: String,
    pub group_id: String,
    pub group_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogGroupView {
    pub id: String,
    pub name: String,
    pub namespace: Option<TagNamespace>,
    pub tags: Vec<TagCount>,
    pub sources: Vec<CatalogGroupOrigin>,
}

pub(super) fn initialize(conn: &Connection) -> Result<(), CatalogError> {
    conn.execute_batch(
        "BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS catalog_group (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, namespace TEXT, ord INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS catalog_group_member (
          group_id TEXT NOT NULL REFERENCES catalog_group(id) ON DELETE CASCADE,
          catalog_id TEXT NOT NULL REFERENCES catalog_tag(id), ord INTEGER NOT NULL,
          PRIMARY KEY(group_id,catalog_id));
        CREATE TABLE IF NOT EXISTS catalog_group_migration (
          library_id TEXT NOT NULL, group_id TEXT NOT NULL, source TEXT NOT NULL,
          target TEXT REFERENCES catalog_group(id) ON DELETE SET NULL,
          PRIMARY KEY(library_id,group_id));
        PRAGMA user_version=4;
        COMMIT;",
    )?;
    Ok(())
}

pub(super) fn migrate(tx: &Transaction<'_>, library: &Library) -> Result<bool, CatalogError> {
    let library_id = &library.info().id;
    let local_groups = library.tag_group_definitions()?;
    if local_groups.is_empty() {
        return Ok(false);
    }
    let mut mapping_stmt =
        tx.prepare("SELECT local_tag_id,catalog_id FROM library_tag_mapping WHERE library_id=?1")?;
    let mappings = mapping_stmt
        .query_map([library_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    let mut changed = false;
    for group in local_groups {
        if tx
            .query_row(
                "SELECT 1 FROM catalog_group_migration WHERE library_id=?1 AND group_id=?2",
                params![library_id, group.id],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            continue;
        }
        // A safe-mode enrollment may not have attached every member yet. Never consume a
        // partial group or clear the caller's safe mode to obtain hidden tag definitions.
        let Some(members) = group
            .members
            .iter()
            .map(|id| mappings.get(id).cloned())
            .collect::<Option<Vec<_>>>()
        else {
            continue;
        };
        let id = uuid::Uuid::now_v7().simple().to_string();
        tx.execute("INSERT INTO catalog_group(id,name,namespace,ord) VALUES (?1,?2,?3,(SELECT coalesce(max(ord),-1)+1 FROM catalog_group))",params![id, group.name, group.namespace.map(|ns| serde_json::to_string(&ns)).transpose()?])?;
        for (ord, member) in members.iter().enumerate() {
            tx.execute("INSERT OR IGNORE INTO catalog_group_member(group_id,catalog_id,ord) VALUES (?1,?2,?3)",params![id, member, ord as i64])?;
        }
        let source = CatalogGroupSource {
            library_id: library_id.clone(),
            library_name: library.info().name.clone(),
            group,
        };
        tx.execute("INSERT INTO catalog_group_migration(library_id,group_id,source,target) VALUES (?1,?2,?3,?4)",params![library_id, source.group.id, serde_json::to_string(&source)?, id])?;
        changed = true;
    }
    Ok(changed)
}

impl TagCatalog {
    /// Durable definitions, including provenance. Image tags are never written by group actions.
    pub fn group_definitions(&self) -> Result<Vec<CatalogGroupDefinition>, CatalogError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id,name,namespace FROM catalog_group ORDER BY ord,id")?;
        let mut members = self.conn.prepare(
            "SELECT catalog_id FROM catalog_group_member WHERE group_id=?1 ORDER BY ord,catalog_id",
        )?;
        let mut sources_by_target = BTreeMap::<String, Vec<CatalogGroupSource>>::new();
        for migration in self.group_migrations()? {
            if let Some(target) = migration.target {
                sources_by_target
                    .entry(target)
                    .or_default()
                    .push(migration.source);
            }
        }
        let mut out = Vec::new();
        for row in stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })? {
            let (id, name, namespace) = row?;
            let namespace = namespace.map(|ns| serde_json::from_str(&ns)).transpose()?;
            let tags = members
                .query_map([&id], |r| r.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            let sources = sources_by_target.remove(&id).unwrap_or_default();
            out.push(CatalogGroupDefinition {
                id,
                name,
                namespace,
                members: tags,
                sources,
            });
        }
        Ok(out)
    }
    /// Includes deleted targets so a settings backup can protect the user's migration choice.
    pub fn group_migrations(&self) -> Result<Vec<CatalogGroupMigration>, CatalogError> {
        let mut stmt = self.conn.prepare(
            "SELECT source,target FROM catalog_group_migration ORDER BY library_id,group_id",
        )?;
        stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })?
        .map(|row| {
            let (source, target) = row?;
            Ok(CatalogGroupMigration {
                source: serde_json::from_str(&source)?,
                target,
            })
        })
        .collect()
    }
    pub fn group_views(
        &self,
        vocabulary: &Vocabulary,
        lang: &str,
    ) -> Result<Vec<CatalogGroupView>, CatalogError> {
        let mut origins = BTreeMap::<String, Vec<CatalogGroupOrigin>>::new();
        for migration in self.group_migrations()? {
            if let Some(target) = migration.target {
                let source = migration.source;
                origins.entry(target).or_default().push(CatalogGroupOrigin {
                    library_id: source.library_id,
                    library_name: source.library_name,
                    group_id: source.group.id,
                    group_name: source.group.name,
                });
            }
        }
        Ok(self
            .groups(vocabulary, lang)?
            .into_iter()
            .map(|group| CatalogGroupView {
                sources: origins.remove(&group.id).unwrap_or_default(),
                id: group.id,
                name: group.name,
                namespace: group.namespace,
                tags: group.tags,
            })
            .collect())
    }

    /// Project saved identities onto a caller-authorized vocabulary. Hidden and unavailable
    /// members stay saved, but no labels/counts from those members are returned.
    pub fn groups(
        &self,
        vocabulary: &Vocabulary,
        lang: &str,
    ) -> Result<Vec<TagGroupView>, CatalogError> {
        let visible = vocabulary
            .tags
            .iter()
            .map(|tag| (tag.id.as_str(), tag))
            .collect::<BTreeMap<_, _>>();
        Ok(self
            .group_definitions()?
            .into_iter()
            .map(|group| {
                let mut tags = match group.namespace {
                    Some(ns) => vocabulary
                        .tags
                        .iter()
                        .filter(|t| t.namespace == ns)
                        .collect::<Vec<_>>(),
                    None => group
                        .members
                        .iter()
                        .filter_map(|id| visible.get(id.as_str()).copied())
                        .collect(),
                }
                .into_iter()
                .map(|tag| TagCount {
                    tag: crate::library::display_label(
                        &tag.id,
                        tag.namespace,
                        &tag.names,
                        &tag.external,
                        lang,
                    ),
                    count: tag.count,
                })
                .collect::<Vec<_>>();
                if group.namespace.is_some() {
                    tags.sort_by(|a, b| (&a.tag.name, &a.tag.id).cmp(&(&b.tag.name, &b.tag.id)));
                }
                TagGroupView {
                    id: group.id,
                    name: group.name,
                    namespace: group.namespace,
                    tags,
                }
            })
            .collect())
    }
}

impl TagCatalog {
    /// Create a group even when the application has no active provider.
    pub fn create_group(
        &mut self,
        name: &str,
        namespace: Option<TagNamespace>,
    ) -> Result<String, CatalogError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(CatalogError::InvalidName);
        }
        let id = uuid::Uuid::now_v7().simple().to_string();
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute("INSERT INTO catalog_group(id,name,namespace,ord) VALUES (?1,?2,?3,(SELECT coalesce(max(ord),-1)+1 FROM catalog_group))",params![id, name, namespace.map(|ns|serde_json::to_string(&ns)).transpose()?])?;
        tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        tx.commit()?;
        Ok(id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum CatalogGroupEdit {
    Rename {
        group_id: String,
        name: String,
    },
    Delete {
        group_id: String,
    },
    AddMembers {
        group_id: String,
        tag_ids: Vec<String>,
    },
    RemoveMembers {
        group_id: String,
        tag_ids: Vec<String>,
    },
    OrderMembers {
        group_id: String,
        tag_ids: Vec<String>,
    },
    OrderGroups {
        group_ids: Vec<String>,
    },
}
impl TagCatalog {
    /// Apply one atomic action against the caller's authorized vocabulary. Hidden members
    /// remain saved while the artist organizes the currently visible portion of a group.
    pub fn edit_group(
        &mut self,
        edit: &CatalogGroupEdit,
        vocabulary: &Vocabulary,
    ) -> Result<(), CatalogError> {
        let visible = vocabulary
            .tags
            .iter()
            .map(|tag| tag.id.as_str())
            .collect::<BTreeSet<_>>();
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let group_id = match edit {
            CatalogGroupEdit::Rename { group_id, .. }
            | CatalogGroupEdit::Delete { group_id }
            | CatalogGroupEdit::AddMembers { group_id, .. }
            | CatalogGroupEdit::RemoveMembers { group_id, .. }
            | CatalogGroupEdit::OrderMembers { group_id, .. } => Some(group_id),
            CatalogGroupEdit::OrderGroups { .. } => None,
        };
        let namespace = if let Some(id) = group_id {
            tx.query_row(
                "SELECT namespace FROM catalog_group WHERE id=?1",
                [id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .ok_or(CatalogError::UnknownGroup)?
        } else {
            None
        };
        match edit {
            CatalogGroupEdit::Rename { group_id, name } => {
                if name.trim().is_empty() {
                    return Err(CatalogError::InvalidName);
                }
                tx.execute(
                    "UPDATE catalog_group SET name=?2 WHERE id=?1",
                    params![group_id, name.trim()],
                )?;
            }
            CatalogGroupEdit::Delete { group_id } => {
                tx.execute("DELETE FROM catalog_group WHERE id=?1", [group_id])?;
            }
            CatalogGroupEdit::AddMembers { group_id, tag_ids } => {
                if namespace.is_some() {
                    return Err(CatalogError::InvalidGroupMembers);
                }
                for id in tag_ids {
                    if !visible.contains(id.as_str()) {
                        return Err(CatalogError::UnknownTag);
                    }
                    tx.execute("INSERT OR IGNORE INTO catalog_group_member(group_id,catalog_id,ord) VALUES (?1,?2,(SELECT coalesce(max(ord),-1)+1 FROM catalog_group_member WHERE group_id=?1))",params![group_id,id])?;
                }
            }
            CatalogGroupEdit::RemoveMembers { group_id, tag_ids } => {
                if namespace.is_some() {
                    return Err(CatalogError::InvalidGroupMembers);
                }
                for id in tag_ids {
                    if !visible.contains(id.as_str()) {
                        return Err(CatalogError::UnknownTag);
                    }
                    tx.execute(
                        "DELETE FROM catalog_group_member WHERE group_id=?1 AND catalog_id=?2",
                        params![group_id, id],
                    )?;
                }
            }
            CatalogGroupEdit::OrderMembers { group_id, tag_ids } => {
                if namespace.is_some() {
                    return Err(CatalogError::InvalidGroupMembers);
                }
                let mut stmt = tx.prepare("SELECT catalog_id FROM catalog_group_member WHERE group_id=?1 ORDER BY ord,catalog_id")?;
                let members = stmt
                    .query_map([group_id], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                let mut seen = BTreeSet::new();
                for id in tag_ids {
                    if !visible.contains(id.as_str()) || !members.contains(id) || !seen.insert(id) {
                        return Err(CatalogError::InvalidGroupMembers);
                    }
                }
                for (ord, id) in tag_ids
                    .iter()
                    .chain(members.iter().filter(|id| !seen.contains(id)))
                    .enumerate()
                {
                    tx.execute("UPDATE catalog_group_member SET ord=?3 WHERE group_id=?1 AND catalog_id=?2",params![group_id,id,ord as i64])?;
                }
            }
            CatalogGroupEdit::OrderGroups { group_ids } => {
                let mut stmt = tx.prepare("SELECT id FROM catalog_group ORDER BY ord,id")?;
                let groups = stmt
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                let mut seen = BTreeSet::new();
                for id in group_ids {
                    if !groups.contains(id) || !seen.insert(id) {
                        return Err(CatalogError::UnknownGroup);
                    }
                }
                for (ord, id) in group_ids
                    .iter()
                    .chain(groups.iter().filter(|id| !seen.contains(id)))
                    .enumerate()
                {
                    tx.execute(
                        "UPDATE catalog_group SET ord=?2 WHERE id=?1",
                        params![id, ord as i64],
                    )?;
                }
            }
        }
        tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        tx.commit()?;
        Ok(())
    }
}
