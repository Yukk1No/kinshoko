//! 把资料库的可见本地定义接入统一目录（从 tag_catalog.rs 原样搬出）。

use super::*;

#[derive(PartialEq)]
pub(super) struct Synchronized {
    root: std::path::PathBuf,
    safe_mode: bool,
    scope: crate::library::SafeModeScope,
    vocabulary: i64,
    catalog: i64,
}

impl TagCatalog {
    /// Attach visible local definitions. Repeated attachment retains explicit corrections and
    /// the original names awaiting migration. A matching name or alias is never evidence of identity.
    pub fn synchronize(&mut self, library: &Library) -> Result<CatalogInspection, CatalogError> {
        let safe_mode = library.safe_mode();
        let scope = library.safe_mode_scope();
        let vocabulary = library.vocabulary()?;
        let vocabulary_revision = vocabulary.revision;
        let dependencies = library.tag_definition_dependencies()?;
        let dependency_bindings = dependencies
            .iter()
            .map(|b| (b.local_tag_id.as_str(), b))
            .collect::<std::collections::BTreeMap<_, _>>();
        let library_id = &library.info().id;
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let enrolled = tx
            .query_row(
                "SELECT 1 FROM catalog_library_enrollment WHERE library_id=?1",
                [library_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !enrolled {
            for id in library.catalog_existing_tag_ids()? {
                tx.execute("INSERT OR IGNORE INTO catalog_legacy_tag (library_id,local_tag_id) VALUES (?1,?2)", params![library_id, id])?;
            }
            tx.execute(
                "INSERT INTO catalog_library_enrollment (library_id) VALUES (?1)",
                [library_id],
            )?;
        }
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
                changed |= names::adopt_existing_choice(&tx, library_id, &local.id, &target)?;
                continue;
            }
            let dependency = dependency_bindings
                .get(local.id.as_str())
                .copied()
                .filter(|b| b.authoritative);
            let (id, basis) = if let Some(binding) = dependency {
                portable::import_definition(&tx, &binding.definition)?;
                (binding.definition.id.clone(), CatalogMatchBasis::Corrected)
            } else if candidates.len() == 1 {
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
                (
                    insert_tag_with_id(
                        &tx,
                        &local,
                        dependency_bindings
                            .get(local.id.as_str())
                            .map(|b| b.definition.id.as_str()),
                    )?,
                    CatalogMatchBasis::Independent,
                )
            };
            tx.execute("INSERT INTO library_tag_mapping (library_id,local_tag_id,catalog_id,legacy,basis) VALUES (?1,?2,?3,?4,?5)", params![library_id, local.id, id, serde_json::to_string(&local)?, serde_json::to_string(&basis)?])?;
            let adopted = tx
                .query_row(
                    "SELECT 1 FROM catalog_name_adoption WHERE catalog_id=?1",
                    [&id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if dependency.is_some()
                || adopted
                || tx
                    .query_row(
                        "SELECT 1 FROM catalog_legacy_tag WHERE library_id=?1 AND local_tag_id=?2",
                        params![library_id, local.id],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_none()
            {
                tx.execute("UPDATE library_tag_mapping SET name_provenance='catalog' WHERE library_id=?1 AND local_tag_id=?2", params![library_id, local.id])?;
            }
            changed = true;
        }
        changed |= groups::migrate(&tx, library)?;
        changed |= approx::migrate(&tx, library, &vocabulary.personal_approx)?;
        if changed {
            tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        }
        tx.commit()?;
        let inspection = if changed && let Some(table) = self.name_defaults.clone() {
            self.update_name_defaults(&table)?
        } else {
            self.inspect()?
        };
        // 修订号取自同步开始时的词表快照：同步期间词表又变了，下次读仍会重新同步。
        self.synchronized.insert(
            library.info().id.clone(),
            Synchronized {
                root: library.info().root.clone(),
                safe_mode,
                scope,
                vocabulary: vocabulary_revision,
                catalog: inspection.revision,
            },
        );
        Ok(inspection)
    }

    /// 自上次同步这个资料库以来，它的词表、安全模式（开关与范围）与统一标签目录都没有变化。
    pub(super) fn is_synchronized(&self, library: &Library) -> Result<bool, CatalogError> {
        let Some(last) = self.synchronized.get(&library.info().id) else {
            return Ok(false);
        };
        Ok(*last
            == Synchronized {
                root: library.info().root.clone(),
                safe_mode: library.safe_mode(),
                scope: library.safe_mode_scope(),
                vocabulary: library.vocabulary_revision()?,
                catalog: self.revision()?,
            })
    }
}

pub(super) fn insert_tag(
    tx: &Transaction<'_>,
    local: &VocabularyTag,
) -> Result<String, CatalogError> {
    insert_tag_with_id(tx, local, None)
}

pub(super) fn insert_tag_with_id(
    tx: &Transaction<'_>,
    local: &VocabularyTag,
    initial_id: Option<&str>,
) -> Result<String, CatalogError> {
    if let Some(id) = initial_id {
        let existing = tx
            .query_row(
                "SELECT definition FROM catalog_tag WHERE id=?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(raw) = existing {
            let tag: CatalogTag = serde_json::from_str(&raw)?;
            if tag.namespace != local.namespace {
                return Err(CatalogError::NamespaceMismatch);
            }
            // The content identity is already known. Keep this application's names and rules.
            return Ok(id.to_owned());
        }
    }
    let id = initial_id
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::now_v7().simple().to_string());
    let ns = serde_json::to_string(&local.namespace)?;
    let mut tag = CatalogTag {
        id: id.clone(),
        namespace: local.namespace,
        names: local.names.clone(),
        default_names: Vec::new(),
        name_preferences: Vec::new(),
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

pub(super) fn extend_externals(
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
