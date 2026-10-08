//! Reusable portable-definition adapter. Content import never edits existing app settings.
use super::*;
use crate::portable_tags::PortableTagDefinition;

pub(super) fn content_definition(tag: &CatalogTag) -> PortableTagDefinition {
    PortableTagDefinition {
        id: tag.id.clone(),
        namespace: tag.namespace,
        default_names: tag.default_names.clone(),
        aliases: tag.aliases.clone(),
        external: tag.external.clone(),
    }
}

pub(super) fn import_definition(
    tx: &Transaction<'_>,
    definition: &PortableTagDefinition,
) -> Result<(), CatalogError> {
    definition
        .validate()
        .map_err(CatalogError::InvalidDefinition)?;
    if let Some(raw) = tx
        .query_row(
            "SELECT definition FROM catalog_tag WHERE id=?1",
            [&definition.id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        let existing: CatalogTag = serde_json::from_str(&raw)?;
        if existing.namespace != definition.namespace {
            return Err(CatalogError::NamespaceMismatch);
        }
        // Existing defaults, alias deletions, preferences and personal rules have priority.
        return Ok(());
    }
    let tag = CatalogTag {
        id: definition.id.clone(),
        namespace: definition.namespace,
        names: definition.default_names.clone(),
        default_names: Vec::new(),
        name_preferences: Vec::new(),
        aliases: definition.aliases.clone(),
        external: definition.external.clone(),
    };
    tx.execute(
        "INSERT INTO catalog_tag(id,definition) VALUES (?1,?2)",
        params![tag.id, serde_json::to_string(&tag)?],
    )?;
    let namespace = serde_json::to_string(&tag.namespace)?;
    for external in &tag.external {
        // An external collision does not merge two already explicit stable identities.
        tx.execute("INSERT OR IGNORE INTO catalog_external(namespace,vocabulary,name,catalog_id) VALUES (?1,?2,?3,?4)",params![namespace,external.vocabulary,external.name,tag.id])?;
    }
    Ok(())
}

impl TagCatalog {
    /// Check stable content identities against the destination app before writing any content.
    /// Same names/aliases/external values are allowed; a stable ID with another namespace is not.
    pub fn validate_content_dependencies(
        &self,
        definitions: &[PortableTagDefinition],
    ) -> Result<(), CatalogError> {
        let mut identities = std::collections::BTreeMap::new();
        for definition in definitions {
            definition
                .validate()
                .map_err(CatalogError::InvalidDefinition)?;
            if let Some(prior) = identities.insert(&definition.id, definition)
                && prior != definition
            {
                return Err(CatalogError::InvalidDefinition(
                    "同一身份包含不同定义".into(),
                ));
            }
            if let Some(raw) = self
                .conn
                .query_row(
                    "SELECT definition FROM catalog_tag WHERE id=?1",
                    [&definition.id],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
            {
                let existing: CatalogTag = serde_json::from_str(&raw)?;
                if existing.namespace != definition.namespace {
                    return Err(CatalogError::NamespaceMismatch);
                }
            }
        }
        Ok(())
    }
}

impl CatalogInspection {
    /// Replace provider-local snapshot labels with the current portable content definitions.
    /// Uses the complete catalog, never a UI-filtered view or resolved name preferences.
    /// Legacy tags without an application mapping keep the library snapshot dependency.
    pub fn apply_content_definitions(
        &self,
        library_id: &str,
        snapshot: &mut crate::library::ImageSnapshot,
    ) -> Result<(), CatalogError> {
        for tag in &mut snapshot.tags {
            let mapping = self.mappings.iter().find(|mapping| {
                mapping.library_id == library_id
                    && Some(&mapping.local_tag_id) == tag.local_tag_id.as_ref()
            });
            if let Some(mapping) = mapping {
                let shared = self
                    .tags
                    .iter()
                    .find(|tag| tag.id == mapping.catalog_id)
                    .ok_or(CatalogError::UnknownTag)?;
                let definition = content_definition(shared);
                tag.namespace = definition.namespace;
                tag.names = definition.default_names.clone();
                tag.external = definition
                    .external
                    .iter()
                    .filter(|external| external.vocabulary == "danbooru")
                    .map(|external| external.name.clone())
                    .collect();
                tag.definition = Some(definition);
            }
        }
        Ok(())
    }
}
