//! Complete, unfiltered application definitions for settings replacement.
use super::*;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogExternalOwner {
    namespace: TagNamespace,
    vocabulary: String,
    name: String,
    catalog_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSettingsSnapshot {
    pub(super) tags: Vec<CatalogTag>,
    externals: Vec<CatalogExternalOwner>,
    mappings: Vec<LibraryTagMapping>,
    adopted: Vec<String>,
    removed_aliases: Vec<(String, TagAlias)>,
    enrollment: Vec<String>,
    legacy_tags: Vec<(String, String)>,
    name_confirmations: Vec<(String, String, String)>,
    groups: Vec<CatalogGroupDefinition>,
    group_migrations: Vec<CatalogGroupMigration>,
    approx: Vec<CatalogApproxDecision>,
    approx_migrations: Vec<CatalogApproxMigration>,
}
impl CatalogSettingsSnapshot {
    pub(crate) fn portable(&self) -> Self {
        let mut snapshot = self.clone();
        for migration in &mut snapshot.approx_migrations {
            migration.source.library_root.clear();
        }
        snapshot
    }
    pub(crate) fn validate(&self) -> Result<(), CatalogError> {
        let invalid = || CatalogError::InvalidDefinition("设置包中的标签引用不完整或重复".into());
        let mut tags = std::collections::BTreeMap::new();
        for tag in &self.tags {
            crate::portable_tags::PortableTagDefinition {
                id: tag.id.clone(),
                namespace: tag.namespace,
                default_names: tag.default_names.clone(),
                aliases: tag.aliases.clone(),
                external: tag.external.clone(),
            }
            .validate()
            .map_err(CatalogError::InvalidDefinition)?;
            if tags.insert(tag.id.as_str(), tag.namespace).is_some() {
                return Err(invalid());
            }
            let mut languages = BTreeSet::new();
            for name in &tag.name_preferences {
                if name.lang.trim().is_empty()
                    || name.name.trim().is_empty()
                    || !languages.insert(&name.lang)
                {
                    return Err(invalid());
                }
            }
        }
        let mut externals = BTreeSet::new();
        for owner in &self.externals {
            if tags.get(owner.catalog_id.as_str()) != Some(&owner.namespace)
                || !externals.insert((owner.namespace, &owner.vocabulary, &owner.name))
            {
                return Err(invalid());
            }
        }
        let mut mappings = BTreeSet::new();
        for mapping in &self.mappings {
            if tags.get(mapping.catalog_id.as_str()) != Some(&mapping.legacy.namespace)
                || !mappings.insert((&mapping.library_id, &mapping.local_tag_id))
            {
                return Err(invalid());
            }
        }
        for id in &self.adopted {
            if !tags.contains_key(id.as_str()) {
                return Err(invalid());
            }
        }
        for (id, _) in &self.removed_aliases {
            if !tags.contains_key(id.as_str()) {
                return Err(invalid());
            }
        }
        for (_, _, id) in &self.name_confirmations {
            if !tags.contains_key(id.as_str()) {
                return Err(invalid());
            }
        }
        let mut groups = BTreeSet::new();
        for group in &self.groups {
            let mut members = BTreeSet::new();
            if group.name.trim().is_empty() || !groups.insert(&group.id) {
                return Err(invalid());
            }
            for member in &group.members {
                if !tags.contains_key(member.as_str()) || !members.insert(member) {
                    return Err(invalid());
                }
            }
        }
        let mut migrated_groups = BTreeSet::new();
        for migration in &self.group_migrations {
            if migration
                .target
                .as_ref()
                .is_some_and(|id| !groups.contains(id))
                || !migrated_groups
                    .insert((&migration.source.library_id, &migration.source.group.id))
            {
                return Err(invalid());
            }
        }
        let valid_pair = |a: &String, b: &String| {
            a != b && tags.contains_key(a.as_str()) && tags.contains_key(b.as_str())
        };
        let mut pairs = BTreeSet::new();
        for rule in &self.approx {
            if !valid_pair(&rule.a, &rule.b) || !pairs.insert((&rule.a, &rule.b)) {
                return Err(invalid());
            }
        }
        let mut migrated_pairs = BTreeSet::new();
        for migration in &self.approx_migrations {
            if !valid_pair(&migration.a, &migration.b)
                || !migrated_pairs.insert((
                    &migration.source.library_id,
                    &migration.source.rule.a,
                    &migration.source.rule.b,
                ))
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
}
impl TagCatalog {
    pub(crate) fn directory(&self) -> &Path {
        &self.dir
    }

    /// Raw durable settings. This is deliberately independent of the safe-mode UI projection.
    pub fn settings_snapshot(&self) -> Result<CatalogSettingsSnapshot, CatalogError> {
        let _snapshot = self.conn.unchecked_transaction()?;
        let inspection = self.inspect()?;
        let raw_externals = self.conn.prepare("SELECT namespace,vocabulary,name,catalog_id FROM catalog_external ORDER BY namespace,vocabulary,name")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?.collect::<Result<Vec<_>,_>>()?;
        let externals = raw_externals
            .into_iter()
            .map(|(namespace, vocabulary, name, catalog_id)| {
                Ok(CatalogExternalOwner {
                    namespace: serde_json::from_str(&namespace)?,
                    vocabulary,
                    name,
                    catalog_id,
                })
            })
            .collect::<Result<Vec<_>, CatalogError>>()?;
        let strings = |sql: &str| -> Result<Vec<String>, CatalogError> {
            Ok(self
                .conn
                .prepare(sql)?
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?)
        };
        let mut removed = self.conn.prepare(
            "SELECT catalog_id,name,lang FROM catalog_removed_alias ORDER BY catalog_id,name,lang",
        )?;
        let removed_aliases = removed
            .query_map([], |r| {
                let lang: String = r.get(2)?;
                Ok((
                    r.get(0)?,
                    TagAlias {
                        name: r.get(1)?,
                        lang: if lang.is_empty() { None } else { Some(lang) },
                    },
                ))
            })?
            .collect::<Result<_, _>>()?;
        let legacy_tags = self.conn.prepare("SELECT library_id,local_tag_id FROM catalog_legacy_tag ORDER BY library_id,local_tag_id")?.query_map([], |r| Ok((r.get(0)?,r.get(1)?)))?.collect::<Result<_,_>>()?;
        let name_confirmations = self.conn.prepare("SELECT library_id,local_tag_id,catalog_id FROM catalog_legacy_name_confirmation ORDER BY library_id,local_tag_id,catalog_id")?.query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<Result<_,_>>()?;
        Ok(CatalogSettingsSnapshot {
            tags: inspection.tags,
            externals,
            mappings: inspection.mappings,
            adopted: strings("SELECT catalog_id FROM catalog_name_adoption ORDER BY catalog_id")?,
            removed_aliases,
            enrollment: strings(
                "SELECT library_id FROM catalog_library_enrollment ORDER BY library_id",
            )?,
            legacy_tags,
            name_confirmations,
            groups: self.group_definitions()?,
            group_migrations: self.group_migrations()?,
            approx: self.approx_decisions()?,
            approx_migrations: self.approx_migrations()?,
        })
    }
    /// Preserve provider identity facts while replacing all portable global choices.
    pub(crate) fn prepare_settings_replacement(
        &self,
        incoming: &CatalogSettingsSnapshot,
    ) -> Result<CatalogSettingsSnapshot, CatalogError> {
        let current = self.settings_snapshot()?;
        let mut next = incoming.clone();
        let mut needed = BTreeSet::new();
        for mapping in current.mappings {
            needed.insert(mapping.catalog_id.clone());
            next.mappings.retain(|m| {
                m.library_id != mapping.library_id || m.local_tag_id != mapping.local_tag_id
            });
            next.mappings.push(mapping);
        }
        for migration in current.group_migrations {
            if !next.group_migrations.iter().any(|m| {
                m.source.library_id == migration.source.library_id
                    && m.source.group.id == migration.source.group.id
            }) {
                next.group_migrations.push(CatalogGroupMigration {
                    source: migration.source,
                    target: None,
                });
            }
        }
        for mut migration in current.approx_migrations {
            needed.insert(migration.a.clone());
            needed.insert(migration.b.clone());
            if !next.approx_migrations.iter().any(|m| {
                m.source.library_id == migration.source.library_id
                    && m.source.rule.a == migration.source.rule.a
                    && m.source.rule.b == migration.source.rule.b
            }) {
                if !next
                    .approx
                    .iter()
                    .any(|r| r.a == migration.a && r.b == migration.b)
                {
                    next.approx.push(CatalogApproxDecision {
                        a: migration.a.clone(),
                        b: migration.b.clone(),
                        relation: None,
                        explicit: true,
                    });
                }
                migration.confirmed = true;
                next.approx_migrations.push(migration);
            }
        }
        for mut tag in current.tags {
            if let Some(restored) = next.tags.iter().find(|t| t.id == tag.id) {
                if restored.namespace != tag.namespace {
                    return Err(CatalogError::NamespaceMismatch);
                }
            } else if needed.contains(&tag.id) {
                // This is a required content dependency, not a preference merged back in.
                tag.name_preferences.clear();
                tag.names = tag.default_names.clone();
                next.tags.push(tag);
            }
        }
        for owner in current.externals {
            if needed.contains(&owner.catalog_id)
                && !next.externals.iter().any(|restored| {
                    restored.namespace == owner.namespace
                        && restored.vocabulary == owner.vocabulary
                        && restored.name == owner.name
                })
            {
                next.externals.push(owner);
            }
        }
        for id in current.enrollment {
            if !next.enrollment.contains(&id) {
                next.enrollment.push(id);
            }
        }
        for pair in current.legacy_tags {
            if !next.legacy_tags.contains(&pair) {
                next.legacy_tags.push(pair);
            }
        }
        for mapping in &mut next.mappings {
            // Explicitly retain the current identity even if restored external defaults differ.
            mapping.basis = CatalogMatchBasis::Corrected;
            if next.adopted.contains(&mapping.catalog_id) {
                mapping.name_provenance = TagNameProvenance::Catalog;
            }
        }
        Ok(next)
    }
    pub(crate) fn replace_settings_snapshot(
        &mut self,
        snapshot: &CatalogSettingsSnapshot,
    ) -> Result<(), CatalogError> {
        snapshot.validate()?;
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute_batch("DELETE FROM catalog_name_preference; DELETE FROM catalog_name_adoption;
            DELETE FROM catalog_removed_alias; DELETE FROM catalog_legacy_name_confirmation;
            DELETE FROM catalog_library_enrollment; DELETE FROM catalog_legacy_tag;
            DELETE FROM catalog_group_migration; DELETE FROM catalog_group_member; DELETE FROM catalog_group;
            DELETE FROM catalog_approx_migration; DELETE FROM catalog_approx;
            DELETE FROM library_tag_mapping; DELETE FROM catalog_external; DELETE FROM catalog_tag;")?;
        for tag in &snapshot.tags {
            let mut raw = tag.clone();
            raw.names = tag.default_names.clone();
            raw.default_names.clear();
            raw.name_preferences.clear();
            tx.execute(
                "INSERT INTO catalog_tag(id,definition) VALUES (?1,?2)",
                params![tag.id, serde_json::to_string(&raw)?],
            )?;
            for name in &tag.name_preferences {
                tx.execute(
                    "INSERT INTO catalog_name_preference(catalog_id,lang,name) VALUES (?1,?2,?3)",
                    params![tag.id, name.lang, name.name],
                )?;
            }
        }
        for owner in &snapshot.externals {
            tx.execute("INSERT INTO catalog_external(namespace,vocabulary,name,catalog_id) VALUES (?1,?2,?3,?4)",params![serde_json::to_string(&owner.namespace)?,owner.vocabulary,owner.name,owner.catalog_id])?;
        }
        for id in &snapshot.adopted {
            tx.execute(
                "INSERT INTO catalog_name_adoption(catalog_id) VALUES (?1)",
                [id],
            )?;
        }
        for (id, alias) in &snapshot.removed_aliases {
            tx.execute(
                "INSERT INTO catalog_removed_alias(catalog_id,name,lang) VALUES (?1,?2,?3)",
                params![id, alias.name, alias.lang.as_deref().unwrap_or("")],
            )?;
        }
        for mapping in &snapshot.mappings {
            tx.execute("INSERT INTO library_tag_mapping(library_id,local_tag_id,catalog_id,legacy,basis,name_provenance) VALUES (?1,?2,?3,?4,?5,?6)",params![mapping.library_id,mapping.local_tag_id,mapping.catalog_id,serde_json::to_string(&mapping.legacy)?,serde_json::to_string(&mapping.basis)?,if mapping.name_provenance == TagNameProvenance::Catalog { "catalog" } else { "pending" }])?;
        }
        for id in &snapshot.enrollment {
            tx.execute(
                "INSERT INTO catalog_library_enrollment(library_id) VALUES (?1)",
                [id],
            )?;
        }
        for (library, tag) in &snapshot.legacy_tags {
            tx.execute(
                "INSERT INTO catalog_legacy_tag(library_id,local_tag_id) VALUES (?1,?2)",
                params![library, tag],
            )?;
        }
        for (library, tag, catalog) in &snapshot.name_confirmations {
            tx.execute("INSERT INTO catalog_legacy_name_confirmation(library_id,local_tag_id,catalog_id) VALUES (?1,?2,?3)",params![library,tag,catalog])?;
        }
        for (ord, group) in snapshot.groups.iter().enumerate() {
            tx.execute(
                "INSERT INTO catalog_group(id,name,namespace,ord) VALUES (?1,?2,?3,?4)",
                params![
                    group.id,
                    group.name,
                    group
                        .namespace
                        .map(|ns| serde_json::to_string(&ns))
                        .transpose()?,
                    ord as i64
                ],
            )?;
            for (member_ord, member) in group.members.iter().enumerate() {
                tx.execute(
                    "INSERT INTO catalog_group_member(group_id,catalog_id,ord) VALUES (?1,?2,?3)",
                    params![group.id, member, member_ord as i64],
                )?;
            }
        }
        for migration in &snapshot.group_migrations {
            tx.execute("INSERT INTO catalog_group_migration(library_id,group_id,source,target) VALUES (?1,?2,?3,?4)",params![migration.source.library_id,migration.source.group.id,serde_json::to_string(&migration.source)?,migration.target])?;
        }
        for (ord, rule) in snapshot.approx.iter().rev().enumerate() {
            tx.execute(
                "INSERT INTO catalog_approx(a,b,relation,explicit,ord) VALUES (?1,?2,?3,?4,?5)",
                params![
                    rule.a,
                    rule.b,
                    rule.relation
                        .map(|r| serde_json::to_string(&r))
                        .transpose()?,
                    rule.explicit,
                    ord as i64
                ],
            )?;
        }
        for migration in &snapshot.approx_migrations {
            let (local_a, local_b) = crate::approx::ordered(
                migration.source.rule.a.clone(),
                migration.source.rule.b.clone(),
            );
            tx.execute("INSERT INTO catalog_approx_migration(library_id,local_a,local_b,source,a,b,confirmed) VALUES (?1,?2,?3,?4,?5,?6,?7)",params![migration.source.library_id,local_a,local_b,serde_json::to_string(&migration.source)?,migration.a,migration.b,migration.confirmed])?;
        }
        tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        tx.commit()?;
        Ok(())
    }
}
