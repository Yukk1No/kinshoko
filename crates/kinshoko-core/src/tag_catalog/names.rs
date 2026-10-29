//! Application name defaults and explicit preferences; no Library content is rewritten.
use super::*;

pub(super) fn initialize(conn: &Connection, old_version: i64) -> Result<(), CatalogError> {
    let tx = conn.unchecked_transaction()?;
    if old_version < 2 {
        tx.execute_batch("ALTER TABLE library_tag_mapping ADD COLUMN name_provenance TEXT NOT NULL DEFAULT 'pending';")?;
    }
    tx.execute_batch("CREATE TABLE IF NOT EXISTS catalog_name_preference (
        catalog_id TEXT NOT NULL REFERENCES catalog_tag(id), lang TEXT NOT NULL, name TEXT NOT NULL,
        PRIMARY KEY(catalog_id,lang));
        CREATE TABLE IF NOT EXISTS catalog_library_enrollment (library_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS catalog_legacy_tag (library_id TEXT NOT NULL, local_tag_id TEXT NOT NULL,
        PRIMARY KEY(library_id,local_tag_id));
        CREATE TABLE IF NOT EXISTS catalog_name_adoption (catalog_id TEXT PRIMARY KEY REFERENCES catalog_tag(id));
        CREATE TABLE IF NOT EXISTS catalog_removed_alias (catalog_id TEXT NOT NULL REFERENCES catalog_tag(id), name TEXT NOT NULL, lang TEXT NOT NULL, PRIMARY KEY(catalog_id,name,lang));
        ")?;
    if old_version < 3 {
        tx.pragma_update(None, "user_version", 3)?;
    }
    tx.commit()?;
    Ok(())
}

pub(super) fn resolve(conn: &Connection, tag: &mut CatalogTag) -> Result<(), CatalogError> {
    tag.default_names = tag.names.clone();
    let mut stmt = conn.prepare(
        "SELECT lang,name FROM catalog_name_preference WHERE catalog_id=?1 ORDER BY lang",
    )?;
    tag.name_preferences = stmt
        .query_map([&tag.id], |row| {
            Ok(LocalizedName {
                lang: row.get(0)?,
                name: row.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    // 跨库显示：没有名称偏好与默认名称的语言，用按资料库顺序第一个来源名称兜底（ADR-0012）。
    let mut stmt = conn.prepare_cached(
        "SELECT s.names FROM library_tag_mapping m JOIN library_tag_source_name s
         ON s.library_id=m.library_id AND s.local_tag_id=m.local_tag_id
         WHERE m.catalog_id=?1 ORDER BY m.library_id,m.local_tag_id",
    )?;
    let mut sources = Vec::new();
    for names in stmt.query_map([&tag.id], |row| row.get::<_, String>(0))? {
        sources.extend(serde_json::from_str::<Vec<LocalizedName>>(&names?)?);
    }
    fill_names(tag, &sources);
    Ok(())
}

/// 与逐个 [`resolve`] 相同，但全部标签只查两次库（#313）：逐个查时每个标签要解析两条语句、各查一次，
/// 几千个标签时一次 [`TagCatalog::inspect`] 要几百毫秒，打开资料库与首屏会反复调用它。
pub(super) fn resolve_all(conn: &Connection, tags: &mut [CatalogTag]) -> Result<(), CatalogError> {
    let mut preferences = std::collections::HashMap::<String, Vec<LocalizedName>>::new();
    let mut stmt = conn.prepare(
        "SELECT catalog_id,lang,name FROM catalog_name_preference ORDER BY catalog_id,lang",
    )?;
    for row in stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            LocalizedName {
                lang: row.get(1)?,
                name: row.get(2)?,
            },
        ))
    })? {
        let (id, name) = row?;
        preferences.entry(id).or_default().push(name);
    }
    let mut sources = std::collections::HashMap::<String, Vec<LocalizedName>>::new();
    let mut stmt = conn.prepare(
        "SELECT m.catalog_id,s.names FROM library_tag_mapping m JOIN library_tag_source_name s
         ON s.library_id=m.library_id AND s.local_tag_id=m.local_tag_id
         ORDER BY m.catalog_id,m.library_id,m.local_tag_id",
    )?;
    for row in stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (id, names) = row?;
        sources
            .entry(id)
            .or_default()
            .extend(serde_json::from_str::<Vec<LocalizedName>>(&names)?);
    }
    for tag in tags {
        tag.default_names = tag.names.clone();
        tag.name_preferences = preferences.remove(&tag.id).unwrap_or_default();
        fill_names(tag, sources.get(&tag.id).into_iter().flatten());
    }
    Ok(())
}

/// 显示名称：名称偏好 > 默认名称 > 按资料库顺序第一个来源名称；不分语言的来源名称排在最后（ADR-0012）。
/// `sources` 按资料库顺序给出参与显示的映射的来源名称。
pub(crate) fn fill_names<'a>(
    tag: &mut CatalogTag,
    sources: impl IntoIterator<Item = &'a LocalizedName>,
) {
    tag.names = tag.default_names.clone();
    for preference in &tag.name_preferences {
        tag.names.retain(|name| name.lang != preference.lang);
        tag.names.push(preference.clone());
    }
    tag.source_names.clear();
    for name in sources {
        if !tag.source_names.contains(name) {
            tag.source_names.push(name.clone());
        }
    }
    let mut filled = tag.names.clone();
    for source in &tag.source_names {
        if source.lang != crate::library::UND && !filled.iter().any(|n| n.lang == source.lang) {
            filled.push(source.clone());
        }
    }
    filled.sort_by(|a, b| a.lang.cmp(&b.lang));
    filled.extend(
        tag.source_names
            .iter()
            .filter(|s| s.lang == crate::library::UND)
            .take(1)
            .cloned(),
    );
    tag.names = filled;
}

impl TagCatalog {
    /// Saving the current default still records an explicit preference.
    pub fn set_name_preference(
        &mut self,
        catalog_id: &str,
        name: &LocalizedName,
    ) -> Result<CatalogInspection, CatalogError> {
        if name.lang.trim().is_empty() || name.name.trim().is_empty() {
            return Err(CatalogError::InvalidName);
        }
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut tag = raw_tag(&tx, catalog_id)?;
        retain_replaced_name(&tx, &mut tag, name.lang.trim(), Some(name.name.trim()))?;
        tx.execute("INSERT INTO catalog_name_preference (catalog_id,lang,name) VALUES (?1,?2,?3) ON CONFLICT(catalog_id,lang) DO UPDATE SET name=excluded.name", params![catalog_id, name.lang.trim(), name.name.trim()])?;
        tx.execute(
            "INSERT OR IGNORE INTO catalog_name_adoption (catalog_id) VALUES (?1)",
            [catalog_id],
        )?;
        tx.execute(
            "UPDATE library_tag_mapping SET name_provenance='catalog' WHERE catalog_id=?1",
            [catalog_id],
        )?;
        tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        tx.commit()?;
        self.inspect()
    }
}

pub(super) fn raw_tag(conn: &Connection, id: &str) -> Result<CatalogTag, CatalogError> {
    let text = conn
        .query_row(
            "SELECT definition FROM catalog_tag WHERE id=?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or(CatalogError::UnknownTag)?;
    Ok(serde_json::from_str(&text)?)
}
pub(super) fn save_tag(tx: &Transaction<'_>, tag: &CatalogTag) -> Result<(), CatalogError> {
    tx.execute(
        "UPDATE catalog_tag SET definition=?2 WHERE id=?1",
        params![tag.id, serde_json::to_string(tag)?],
    )?;
    Ok(())
}
pub(super) fn removed(conn: &Connection, id: &str, alias: &TagAlias) -> Result<bool, CatalogError> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM catalog_removed_alias WHERE catalog_id=?1 AND name=?2 AND lang=?3",
            params![id, alias.name, alias.lang.as_deref().unwrap_or("")],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Keep the old visible name without copying resolved preferences into raw defaults.
fn retain_replaced_name(
    tx: &Transaction<'_>,
    tag: &mut CatalogTag,
    lang: &str,
    replacement: Option<&str>,
) -> Result<(), CatalogError> {
    let mut visible = tag.clone();
    resolve(tx, &mut visible)?;
    if let Some(old) = visible.names.iter().find(|name| name.lang == lang)
        && Some(old.name.as_str()) != replacement
    {
        let alias = TagAlias {
            name: old.name.clone(),
            lang: Some(lang.to_owned()),
        };
        if !tag.aliases.contains(&alias) && !removed(tx, &tag.id, &alias)? {
            tag.aliases.push(alias);
            save_tag(tx, tag)?;
        }
    }
    Ok(())
}

impl TagCatalog {
    /// Remove only this language's explicit preference. The next default update can take effect.
    pub fn reset_name_preference(
        &mut self,
        catalog_id: &str,
        lang: &str,
    ) -> Result<CatalogInspection, CatalogError> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut tag = raw_tag(&tx, catalog_id)?;
        let default = tag
            .names
            .iter()
            .find(|name| name.lang == lang)
            .map(|name| name.name.clone());
        retain_replaced_name(&tx, &mut tag, lang, default.as_deref())?;
        if tx.execute(
            "DELETE FROM catalog_name_preference WHERE catalog_id=?1 AND lang=?2",
            params![catalog_id, lang],
        )? > 0
        {
            tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        }
        tx.commit()?;
        self.inspect()
    }

    /// Install defaults independently of preferences. A replaced name becomes a removable alias.
    pub fn update_name_defaults(
        &mut self,
        table: &crate::library::TagTranslations,
    ) -> Result<CatalogInspection, CatalogError> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut stmt = tx.prepare("SELECT definition FROM catalog_tag ORDER BY id")?;
        let tags = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        let mut changed = false;
        for text in tags {
            let mut tag: CatalogTag = serde_json::from_str(&text)?;
            if tag.namespace != TagNamespace::General {
                continue;
            }
            let before = tag.clone();
            for entry in table
                .entries
                .iter()
                .filter(|entry| {
                    tag.external.iter().any(|external| {
                        external.vocabulary == "danbooru" && external.name == entry.external
                    })
                })
                .collect::<Vec<_>>()
            {
                for (lang, name) in &entry.names {
                    if lang.trim().is_empty() || name.trim().is_empty() {
                        return Err(CatalogError::InvalidName);
                    }
                    if let Some(old) = tag.names.iter().find(|n| n.lang == *lang) {
                        if old.name == *name {
                            continue;
                        }
                        let alias = TagAlias {
                            name: old.name.clone(),
                            lang: Some(lang.clone()),
                        };
                        if !tag.aliases.contains(&alias) && !removed(&tx, &tag.id, &alias)? {
                            tag.aliases.push(alias);
                        }
                    }
                    tag.names.retain(|n| n.lang != *lang);
                    tag.names.push(LocalizedName {
                        lang: lang.clone(),
                        name: name.clone(),
                    });
                }
                for alias in &entry.aliases {
                    if !tag.aliases.contains(alias) && !removed(&tx, &tag.id, alias)? {
                        tag.aliases.push(alias.clone());
                    }
                }
            }
            if tag != before {
                save_tag(&tx, &tag)?;
                changed = true;
            }
        }
        if changed {
            tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        }
        tx.commit()?;
        self.inspect()
    }

    /// Alias removal is remembered across bundled-table reinstalls and application restarts.
    pub fn remove_alias(
        &mut self,
        catalog_id: &str,
        alias: &TagAlias,
    ) -> Result<CatalogInspection, CatalogError> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut tag = raw_tag(&tx, catalog_id)?;
        tag.aliases.retain(|existing| existing != alias);
        tx.execute(
            "INSERT OR IGNORE INTO catalog_removed_alias (catalog_id,name,lang) VALUES (?1,?2,?3)",
            params![catalog_id, alias.name, alias.lang.as_deref().unwrap_or("")],
        )?;
        save_tag(&tx, &tag)?;
        tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        tx.commit()?;
        self.inspect()
    }
}

impl TagCatalog {
    /// Explicitly adopt application name rules for one visible local tag. This does not infer
    /// whether any old text was a preference; a migration workflow can call this after choice.
    pub fn follow_catalog_names(
        &mut self,
        library: &Library,
        local_tag_id: &str,
    ) -> Result<CatalogInspection, CatalogError> {
        if !library
            .vocabulary()?
            .tags
            .iter()
            .any(|tag| tag.id == local_tag_id)
        {
            return Err(CatalogError::UnknownMapping);
        }
        self.synchronize(library)?;
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if tx.execute("UPDATE library_tag_mapping SET name_provenance='catalog' WHERE library_id=?1 AND local_tag_id=?2 AND name_provenance<>'catalog'", params![library.info().id, local_tag_id])? > 0 {
            tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        }
        tx.commit()?;
        self.inspect()
    }
}

impl TagCatalog {
    /// Adding an alias never selects it as a display name; explicit re-add removes its tombstone.
    pub fn add_alias(
        &mut self,
        catalog_id: &str,
        alias: &TagAlias,
    ) -> Result<CatalogInspection, CatalogError> {
        if alias.name.trim().is_empty()
            || alias
                .lang
                .as_ref()
                .is_some_and(|lang| lang.trim().is_empty())
        {
            return Err(CatalogError::InvalidName);
        }
        let alias = TagAlias {
            name: alias.name.trim().into(),
            lang: alias.lang.as_ref().map(|lang| lang.trim().into()),
        };
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut tag = raw_tag(&tx, catalog_id)?;
        tx.execute(
            "DELETE FROM catalog_removed_alias WHERE catalog_id=?1 AND name=?2 AND lang=?3",
            params![catalog_id, alias.name, alias.lang.as_deref().unwrap_or("")],
        )?;
        if !tag.aliases.contains(&alias) {
            tag.aliases.push(alias);
        }
        save_tag(&tx, &tag)?;
        tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        tx.commit()?;
        self.inspect()
    }
}

impl TagCatalog {
    /// Install the running application's table for current definitions and tags attached later.
    pub fn install_name_defaults(
        &mut self,
        table: crate::library::TagTranslations,
    ) -> Result<CatalogInspection, CatalogError> {
        let snapshot = self.update_name_defaults(&table)?;
        self.name_defaults = Some(table);
        Ok(snapshot)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum CatalogNameEdit {
    Prefer { name: LocalizedName },
    Reset { lang: String },
    AddAlias { alias: TagAlias },
    RemoveAlias { alias: TagAlias },
}

impl CatalogInspection {
    /// Resolve a visible provider label without changing its local ID or namespace.
    pub fn display_label(&self, library_id: &str, label: &TagLabel, lang: &str) -> TagLabel {
        let Some(mapping) = self.mappings.iter().find(|mapping| {
            mapping.library_id == library_id
                && mapping.local_tag_id == label.id
                && mapping.name_provenance == TagNameProvenance::Catalog
        }) else {
            return label.clone();
        };
        let Some(tag) = self.tags.iter().find(|tag| tag.id == mapping.catalog_id) else {
            return label.clone();
        };
        let external = tag
            .external
            .iter()
            .map(|external| external.name.clone())
            .collect::<Vec<_>>();
        // 单库内：名称偏好 > 本库来源名称 > 默认名称（ADR-0012）。
        let names = crate::library::compose_names(
            &tag.default_names,
            &mapping.source_names,
            &tag.name_preferences,
        );
        crate::library::display_label(&label.id, tag.namespace, &names, &external, lang)
    }
}
impl TagCatalog {
    /// Local group membership/counts, with the application's current name rules.
    pub fn tag_groups(
        &mut self,
        library: &Library,
        lang: &str,
    ) -> Result<Vec<crate::library::TagGroupView>, CatalogError> {
        let snapshot = self.synchronize(library)?;
        let mut groups = library.tag_groups(lang)?;
        for group in &mut groups {
            for counted in &mut group.tags {
                counted.tag = snapshot.display_label(&library.info().id, &counted.tag, lang);
            }
        }
        Ok(groups)
    }
}

pub(super) fn adopt_existing_choice(
    tx: &Transaction<'_>,
    library_id: &str,
    local_id: &str,
    catalog_id: &str,
) -> Result<bool, CatalogError> {
    Ok(tx.execute("UPDATE library_tag_mapping SET name_provenance='catalog' WHERE library_id=?1 AND local_tag_id=?2 AND name_provenance<>'catalog' AND EXISTS (SELECT 1 FROM catalog_name_adoption WHERE catalog_id=?3)", params![library_id, local_id, catalog_id])? > 0)
}

#[cfg(test)]
#[path = "names/tests.rs"]
mod tests;
