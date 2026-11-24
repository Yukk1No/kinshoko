//! 按统一标签目录显示一份资料库的词表与一张图的标签。

use super::*;

impl CatalogInspection {
    /// A compatibility view: local IDs/primary labels remain usable for Library actions;
    /// the corrected shared definition supplies additional search words and external mappings.
    pub fn search_vocabulary(&self, library_id: &str, vocabulary: &Vocabulary) -> Vocabulary {
        let mappings = self
            .mappings
            .iter()
            .filter(|m| m.library_id == library_id)
            .map(|m| (m.local_tag_id.as_str(), m))
            .collect::<std::collections::BTreeMap<_, _>>();
        let definitions = self
            .tags
            .iter()
            .map(|tag| (tag.id.as_str(), tag))
            .collect::<std::collections::BTreeMap<_, _>>();
        let mut view = vocabulary.clone();
        for local in &mut view.tags {
            let Some(mapping) = mappings.get(local.id.as_str()) else {
                continue;
            };
            let Some(shared) = definitions.get(mapping.catalog_id.as_str()) else {
                continue;
            };
            // 单库内：名称偏好 > 本库来源名称 > 默认名称（ADR-0012）。来源名称也都能查到。
            if mapping.name_provenance == TagNameProvenance::Catalog {
                local.names = crate::library::compose_names(
                    &shared.default_names,
                    &local.source_names,
                    &shared.name_preferences,
                );
                local.aliases = shared.aliases.clone();
            } else {
                local.names = crate::library::compose_names(&local.names, &local.source_names, &[]);
            }
            for source in std::mem::take(&mut local.source_names) {
                let alias = TagAlias {
                    name: source.name,
                    // 未注明语言的来源名称是不分语言的叫法。
                    lang: (source.lang != crate::library::UND).then_some(source.lang),
                };
                if !local.aliases.contains(&alias) {
                    local.aliases.push(alias);
                }
            }
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

impl TagCatalog {
    /// Identity inspection for effective and rejected image tags; manual actions continue to use
    /// each local ID and its original display label.
    pub fn image_tags(
        &mut self,
        library: &Library,
        image_id: &str,
        lang: &str,
    ) -> Result<CatalogImageTags, CatalogError> {
        // 选中一张图就读一次（#158）：词表与目录都没变时只查这张图自己的标签对应。
        if !self.is_synchronized(library)? {
            self.synchronize(library)?;
        }
        let mut image = library.image_tags(image_id, lang)?;
        let library_id = &library.info().id;
        let mut mapping = self.conn.prepare_cached(
            "SELECT m.catalog_id,m.name_provenance,coalesce(s.names,'[]') FROM library_tag_mapping m
             LEFT JOIN library_tag_source_name s ON s.library_id=m.library_id AND s.local_tag_id=m.local_tag_id
             WHERE m.library_id=?1 AND m.local_tag_id=?2",
        )?;
        let mut definition = self
            .conn
            .prepare_cached("SELECT definition FROM catalog_tag WHERE id=?1")?;
        let mut identities = Vec::new();
        for label in image
            .tags
            .iter_mut()
            .map(|t| &mut t.tag)
            .chain(image.rejected.iter_mut())
        {
            let Some((catalog_id, provenance, sources)) = mapping
                .query_row(params![library_id, label.id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .optional()?
            else {
                continue;
            };
            let sources: Vec<LocalizedName> = serde_json::from_str(&sources)?;
            let Some(text) = definition
                .query_row([&catalog_id], |row| row.get::<_, String>(0))
                .optional()?
            else {
                continue;
            };
            let mut shared: CatalogTag = serde_json::from_str(&text)?;
            names::resolve(&self.conn, &mut shared)?;
            let external = shared
                .external
                .iter()
                .map(|e| e.name.clone())
                .collect::<Vec<_>>();
            if provenance == "catalog" {
                *label = crate::library::display_label(
                    &label.id,
                    shared.namespace,
                    &crate::library::compose_names(
                        &shared.default_names,
                        &sources,
                        &shared.name_preferences,
                    ),
                    &external,
                    lang,
                );
            }
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
}
