//! Explicit ownership of unknown legacy names, committed as a single catalog transaction.
use super::*;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LegacyNameSource {
    pub library_id: String,
    pub local_tag_id: String,
    pub legacy_name: String,
    pub current_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LegacyNameGroup {
    pub catalog_id: String,
    pub namespace: TagNamespace,
    pub lang: String,
    pub default_name: Option<String>,
    pub existing_preference: Option<String>,
    pub sources: Vec<LegacyNameSource>,
    /// Every attached provider affected by the shared choice, including unavailable providers.
    pub affected_libraries: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LegacyNameMigration {
    #[ts(type = "number")]
    pub revision: i64,
    pub groups: Vec<LegacyNameGroup>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LegacyNameMigrationWorkspace {
    pub plan: LegacyNameMigration,
    pub libraries: Vec<LibraryRegistration>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum LegacyNameResolution {
    FollowDefault,
    KeepLegacy {
        library_id: String,
        local_tag_id: String,
    },
    KeepPreference,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LegacyNameDecision {
    pub catalog_id: String,
    pub lang: String,
    pub resolution: LegacyNameResolution,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LegacyNameOutcome {
    pub catalog_id: String,
    pub lang: String,
    pub display_name: String,
    pub preference_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LegacyNameMigrationPreview {
    #[ts(type = "number")]
    pub revision: i64,
    pub outcomes: Vec<LegacyNameOutcome>,
}

pub(super) fn initialize(conn: &Connection) -> Result<(), CatalogError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS catalog_legacy_name_confirmation (
        library_id TEXT NOT NULL, local_tag_id TEXT NOT NULL, catalog_id TEXT NOT NULL,
        PRIMARY KEY(library_id,local_tag_id,catalog_id));
        CREATE INDEX IF NOT EXISTS library_mapping_catalog ON library_tag_mapping(catalog_id);",
    )?;
    Ok(())
}

impl TagCatalog {
    /// Plan from the caller's visible inspection. Planning/cancelling changes no ownership.
    /// Catalog provenance alone is insufficient: a T03 preference may predate this old source.
    pub fn plan_name_migration(
        &self,
        visible: &CatalogInspection,
    ) -> Result<LegacyNameMigration, CatalogError> {
        let all = self.inspect()?;
        if all.revision != visible.revision {
            return Err(CatalogError::StaleNameMigration);
        }
        let tags = all
            .tags
            .iter()
            .map(|tag| (&tag.id, tag))
            .collect::<BTreeMap<_, _>>();
        let mut affected = BTreeMap::<&String, BTreeSet<String>>::new();
        for mapping in &all.mappings {
            affected
                .entry(&mapping.catalog_id)
                .or_default()
                .insert(mapping.library_id.clone());
        }
        let mut stmt = self.conn.prepare("SELECT l.library_id,l.local_tag_id FROM catalog_legacy_tag l JOIN library_tag_mapping m ON m.library_id=l.library_id AND m.local_tag_id=l.local_tag_id LEFT JOIN catalog_legacy_name_confirmation c ON c.library_id=l.library_id AND c.local_tag_id=l.local_tag_id AND c.catalog_id=m.catalog_id WHERE c.catalog_id IS NULL")?;
        let pending = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<BTreeSet<_>, _>>()?;
        let mut groups = BTreeMap::<(String, String), LegacyNameGroup>::new();
        for mapping in &visible.mappings {
            if !pending.contains(&(mapping.library_id.clone(), mapping.local_tag_id.clone())) {
                continue;
            }
            let tag = tags
                .get(&mapping.catalog_id)
                .ok_or(CatalogError::UnknownTag)?;
            let mut names = mapping.legacy.names.clone();
            if names.is_empty() {
                names.push(LocalizedName {
                    lang: "und".into(),
                    name: mapping
                        .legacy
                        .external
                        .first()
                        .map(|name| name.replace('_', " "))
                        .unwrap_or_else(|| mapping.local_tag_id.clone()),
                });
            }
            for name in names {
                let group = groups
                    .entry((tag.id.clone(), name.lang.clone()))
                    .or_insert_with(|| LegacyNameGroup {
                        catalog_id: tag.id.clone(),
                        namespace: tag.namespace,
                        lang: name.lang.clone(),
                        default_name: tag
                            .default_names
                            .iter()
                            .find(|entry| entry.lang == name.lang)
                            .map(|entry| entry.name.clone()),
                        existing_preference: tag
                            .name_preferences
                            .iter()
                            .find(|entry| entry.lang == name.lang)
                            .map(|entry| entry.name.clone()),
                        sources: Vec::new(),
                        affected_libraries: affected
                            .get(&tag.id)
                            .into_iter()
                            .flat_map(|libraries| libraries.iter().cloned())
                            .collect(),
                    });
                let current_name = if mapping.name_provenance == TagNameProvenance::Catalog {
                    let external = tag
                        .external
                        .iter()
                        .map(|entry| entry.name.clone())
                        .collect::<Vec<_>>();
                    crate::library::display_label(
                        &tag.id,
                        tag.namespace,
                        &tag.names,
                        &external,
                        &name.lang,
                    )
                    .name
                } else {
                    name.name.clone()
                };
                group.sources.push(LegacyNameSource {
                    library_id: mapping.library_id.clone(),
                    local_tag_id: mapping.local_tag_id.clone(),
                    legacy_name: name.name,
                    current_name,
                });
            }
        }
        Ok(LegacyNameMigration {
            revision: visible.revision,
            groups: groups.into_values().collect(),
        })
    }

    /// Resolve the full batch before writing, including interactions between language fallbacks.
    pub fn preview_name_migration(
        &self,
        plan: &LegacyNameMigration,
        decisions: &[LegacyNameDecision],
    ) -> Result<LegacyNameMigrationPreview, CatalogError> {
        let mut visible = self.inspect()?;
        let sources = plan
            .groups
            .iter()
            .flat_map(|group| &group.sources)
            .map(|source| (source.library_id.clone(), source.local_tag_id.clone()))
            .collect::<BTreeSet<_>>();
        visible.mappings.retain(|mapping| {
            sources.contains(&(mapping.library_id.clone(), mapping.local_tag_id.clone()))
        });
        if visible.revision != plan.revision || self.plan_name_migration(&visible)? != *plan {
            return Err(CatalogError::StaleNameMigration);
        }
        if decisions.len() != plan.groups.len() {
            return Err(CatalogError::IncompleteNameMigration);
        }
        let mut selections = BTreeMap::new();
        for decision in decisions {
            if selections
                .insert((&decision.catalog_id, &decision.lang), &decision.resolution)
                .is_some()
            {
                return Err(CatalogError::IncompleteNameMigration);
            }
        }
        let mut tags = visible
            .tags
            .into_iter()
            .map(|tag| (tag.id.clone(), tag))
            .collect::<BTreeMap<_, _>>();
        for group in &plan.groups {
            let resolution = selections
                .get(&(&group.catalog_id, &group.lang))
                .ok_or(CatalogError::IncompleteNameMigration)?;
            let preferred = match resolution {
                LegacyNameResolution::FollowDefault => None,
                LegacyNameResolution::KeepPreference => Some(
                    group
                        .existing_preference
                        .clone()
                        .ok_or(CatalogError::IncompleteNameMigration)?,
                ),
                LegacyNameResolution::KeepLegacy {
                    library_id,
                    local_tag_id,
                } => Some(
                    group
                        .sources
                        .iter()
                        .find(|source| {
                            &source.library_id == library_id && &source.local_tag_id == local_tag_id
                        })
                        .ok_or(CatalogError::UnknownMapping)?
                        .legacy_name
                        .clone(),
                ),
            };
            let tag = tags
                .get_mut(&group.catalog_id)
                .ok_or(CatalogError::UnknownTag)?;
            tag.name_preferences.retain(|name| name.lang != group.lang);
            if let Some(name) = preferred {
                tag.name_preferences.push(LocalizedName {
                    lang: group.lang.clone(),
                    name,
                });
            }
        }
        let mut outcomes = Vec::new();
        for group in &plan.groups {
            let tag = tags
                .get(&group.catalog_id)
                .ok_or(CatalogError::UnknownTag)?;
            let mut names = tag.default_names.clone();
            // Match the catalog's persisted per-language ordering when a label needs fallback.
            let mut preferences = tag.name_preferences.clone();
            preferences.sort_by(|a, b| a.lang.cmp(&b.lang));
            for preference in &preferences {
                names.retain(|name| name.lang != preference.lang);
                names.push(preference.clone());
            }
            let external = tag
                .external
                .iter()
                .map(|entry| entry.name.clone())
                .collect::<Vec<_>>();
            outcomes.push(LegacyNameOutcome {
                catalog_id: group.catalog_id.clone(),
                lang: group.lang.clone(),
                display_name: crate::library::display_label(
                    &tag.id,
                    tag.namespace,
                    &names,
                    &external,
                    &group.lang,
                )
                .name,
                preference_name: preferences
                    .iter()
                    .find(|entry| entry.lang == group.lang)
                    .map(|entry| entry.name.clone()),
            });
        }
        Ok(LegacyNameMigrationPreview {
            revision: plan.revision,
            outcomes,
        })
    }

    /// Confirm the complete visible batch, with a revision guard and one durable transaction.
    /// Source IDs are acknowledged separately from identity-wide display adoption.
    pub fn confirm_name_migration(
        &mut self,
        plan: &LegacyNameMigration,
        decisions: &[LegacyNameDecision],
    ) -> Result<CatalogInspection, CatalogError> {
        self.preview_name_migration(plan, decisions)?;
        let selections = decisions
            .iter()
            .map(|decision| ((&decision.catalog_id, &decision.lang), &decision.resolution))
            .collect::<BTreeMap<_, _>>();
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let revision: i64 =
            tx.query_row("SELECT value FROM catalog_revision", [], |row| row.get(0))?;
        if revision != plan.revision {
            return Err(CatalogError::StaleNameMigration);
        }
        for group in &plan.groups {
            let resolution = selections
                .get(&(&group.catalog_id, &group.lang))
                .ok_or(CatalogError::IncompleteNameMigration)?;
            match resolution {
                LegacyNameResolution::FollowDefault => {
                    tx.execute(
                        "DELETE FROM catalog_name_preference WHERE catalog_id=?1 AND lang=?2",
                        params![group.catalog_id, group.lang],
                    )?;
                }
                LegacyNameResolution::KeepLegacy {
                    library_id,
                    local_tag_id,
                } => {
                    let source = group
                        .sources
                        .iter()
                        .find(|source| {
                            &source.library_id == library_id && &source.local_tag_id == local_tag_id
                        })
                        .ok_or(CatalogError::UnknownMapping)?;
                    tx.execute("INSERT INTO catalog_name_preference (catalog_id,lang,name) VALUES (?1,?2,?3) ON CONFLICT(catalog_id,lang) DO UPDATE SET name=excluded.name", params![group.catalog_id, group.lang, source.legacy_name])?;
                }
                LegacyNameResolution::KeepPreference => {
                    if group.existing_preference.is_none() {
                        return Err(CatalogError::IncompleteNameMigration);
                    }
                }
            }
            // The old words remain independent, removable search aliases, never implicit preferences.
            let mut tag = names::raw_tag(&tx, &group.catalog_id)?;
            if let Some(name) = &group.existing_preference {
                let alias = TagAlias {
                    name: name.clone(),
                    lang: Some(group.lang.clone()),
                };
                if !tag.aliases.contains(&alias) && !names::removed(&tx, &group.catalog_id, &alias)?
                {
                    tag.aliases.push(alias);
                }
            }
            for source in &group.sources {
                let alias = TagAlias {
                    name: source.legacy_name.clone(),
                    lang: Some(group.lang.clone()),
                };
                if !tag.aliases.contains(&alias) && !names::removed(&tx, &group.catalog_id, &alias)?
                {
                    tag.aliases.push(alias);
                }
                tx.execute("INSERT OR IGNORE INTO catalog_legacy_name_confirmation (library_id,local_tag_id,catalog_id) VALUES (?1,?2,?3)", params![source.library_id, source.local_tag_id, group.catalog_id])?;
            }
            names::save_tag(&tx, &tag)?;
            tx.execute(
                "INSERT OR IGNORE INTO catalog_name_adoption (catalog_id) VALUES (?1)",
                [&group.catalog_id],
            )?;
            tx.execute(
                "UPDATE library_tag_mapping SET name_provenance='catalog' WHERE catalog_id=?1",
                [&group.catalog_id],
            )?;
            crate::library::fault::storage("legacy_name_after_choice")?;
        }
        if !plan.groups.is_empty() {
            tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        }
        tx.commit()?;
        self.inspect()
    }
}
