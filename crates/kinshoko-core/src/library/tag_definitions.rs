//! Ordinary content dependencies. Read-only providers never synthesize or publish them.
use super::{Error, Library, LocalizedName, TagAlias, TagNamespace};
use crate::portable_tags::{PortableTagBinding, PortableTagDefinition};
use crate::tag_catalog::ExternalTagIdentity;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use std::collections::BTreeMap;

pub(super) fn read(conn: &Connection) -> Result<Vec<PortableTagBinding>, Error> {
    let mut stmt = conn.prepare("SELECT local_tag_id,definition,authoritative FROM tag_definition_dependency ORDER BY local_tag_id")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, bool>(2)?,
        ))
    })?;
    rows.map(|row| {
        let (local_tag_id, json, authoritative) = row?;
        Ok(PortableTagBinding {
            local_tag_id,
            definition: serde_json::from_str(&json)
                .map_err(|e| Error::TagDefinitions(e.to_string()))?,
            authoritative,
        })
    })
    .collect()
}

/// New local definitions are saved by the same transaction as their first tag fact/decision.
/// A later explicit application publication owns those definitions and is never overwritten here.
pub(super) fn seed(tx: &Transaction<'_>) -> Result<(), Error> {
    let mut stmt = tx.prepare("SELECT t.id,t.namespace,d.definition FROM tag t LEFT JOIN tag_definition_dependency d ON d.local_tag_id=t.id JOIN tag_definition_dirty dirty ON dirty.local_tag_id=t.id WHERE coalesce(d.authoritative,0)=0 ORDER BY t.id")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    for (local, namespace, old) in rows {
        let mut definition = PortableTagDefinition {
            id: match old {
                Some(json) => {
                    serde_json::from_str::<PortableTagDefinition>(&json)
                        .map_err(|e| Error::TagDefinitions(e.to_string()))?
                        .id
                }
                None => uuid::Uuid::now_v7().simple().to_string(),
            },
            namespace: TagNamespace::parse(&namespace)?,
            default_names: Vec::new(),
            aliases: Vec::new(),
            external: Vec::new(),
        };
        let mut stmt =
            tx.prepare("SELECT lang,name FROM tag_name WHERE tag_id=?1 ORDER BY lang")?;
        definition.default_names = stmt
            .query_map([&local], |r| {
                Ok(LocalizedName {
                    lang: r.get(0)?,
                    name: r.get(1)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        let mut stmt =
            tx.prepare("SELECT name,lang FROM tag_alias WHERE tag_id=?1 ORDER BY name")?;
        definition.aliases = stmt
            .query_map([&local], |r| {
                Ok(TagAlias {
                    name: r.get(0)?,
                    lang: r.get(1)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        let mut stmt = tx.prepare("SELECT name FROM tag_external WHERE tag_id=?1 ORDER BY name")?;
        definition.external = stmt
            .query_map([&local], |r| {
                Ok(ExternalTagIdentity {
                    vocabulary: "danbooru".into(),
                    name: r.get(0)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        tx.execute("INSERT INTO tag_definition_dependency(local_tag_id,catalog_id,definition,authoritative) VALUES (?1,?2,?3,0) ON CONFLICT(local_tag_id) DO UPDATE SET definition=excluded.definition",
            params![local,definition.id,serde_json::to_string(&definition).map_err(|e| Error::TagDefinitions(e.to_string()))?])?;
    }
    tx.execute("DELETE FROM tag_definition_dirty", [])?;
    Ok(())
}

impl Library {
    /// Export-only content metadata, including sealed/trash dependencies. This does not change mode
    /// or write a provider. Ordinary UI vocabulary still passes through the safe-mode view.
    pub fn tag_definition_dependencies(&self) -> Result<Vec<PortableTagBinding>, Error> {
        read(&self.inner.readers.get())
    }
}

impl Library {
    /// Explicit writable publication. Every supplied local mapping is validated before any write,
    /// and the whole dependency batch commits in one library transaction. Application preferences
    /// are absent from the type. A read-only provider returns its ordinary read-only storage error.
    pub fn publish_tag_definitions(&self, bindings: &[PortableTagBinding]) -> Result<(), Error> {
        let bindings = bindings.to_vec();
        self.inner.writer.run(move |conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let mut definitions = BTreeMap::new();
            let mut local_ids = std::collections::BTreeSet::new();
            for binding in &bindings {
                binding.definition.validate().map_err(Error::TagDefinitions)?;
                if !local_ids.insert(&binding.local_tag_id) { return Err(Error::TagDefinitions("本地标签对应重复".into())); }
                if let Some(prior) = definitions.insert(&binding.definition.id, &binding.definition)
                    && prior != &binding.definition { return Err(Error::TagDefinitions("同一身份包含不同定义".into())); }
                let namespace = tx.query_row("SELECT namespace FROM tag WHERE id=?1", [&binding.local_tag_id], |r| r.get::<_,String>(0)).optional()?.ok_or(Error::UnknownTag)?;
                if TagNamespace::parse(&namespace)? != binding.definition.namespace {
                    return Err(Error::TagDefinitions("命名空间不一致".into()));
                }
            }
            seed(&tx)?;
            for binding in bindings {
                tx.execute("INSERT INTO tag_definition_dependency(local_tag_id,catalog_id,definition,authoritative) VALUES (?1,?2,?3,?4) ON CONFLICT(local_tag_id) DO UPDATE SET catalog_id=excluded.catalog_id,definition=excluded.definition,authoritative=excluded.authoritative",
                    params![binding.local_tag_id,binding.definition.id,serde_json::to_string(&binding.definition).map_err(|e| Error::TagDefinitions(e.to_string()))?,binding.authoritative])?;
                super::fault::storage("portable_tags_publish_row")?;
            }
            tx.commit()?;
            Ok(())
        })
    }
}

/// Modern snapshots resolve exactly by their declared stable identity. Same names, aliases,
/// or external values do not claim a pre-existing unrelated local tag.
pub(super) fn resolve_snapshot(
    tx: &Transaction<'_>,
    definition: &PortableTagDefinition,
    namespace: TagNamespace,
) -> Result<String, Error> {
    definition.validate().map_err(Error::TagDefinitions)?;
    if definition.namespace != namespace {
        return Err(Error::TagDefinitions("快照命名空间与定义不同".into()));
    }
    if let Some((local,local_namespace)) = tx.query_row(
        "SELECT d.local_tag_id,t.namespace FROM tag_definition_dependency d JOIN tag t ON t.id=d.local_tag_id WHERE d.catalog_id=?1 ORDER BY d.local_tag_id LIMIT 1",
        [&definition.id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()? {
        if TagNamespace::parse(&local_namespace)? != namespace { return Err(Error::TagDefinitions("同一身份命名空间冲突".into())); }
        return Ok(local);
    }
    let local = uuid::Uuid::now_v7().simple().to_string();
    tx.execute(
        "INSERT INTO tag(id,namespace,created_at) VALUES (?1,?2,?3)",
        params![local, namespace.as_str(), super::now_ms()],
    )?;
    for name in &definition.default_names {
        tx.execute(
            "INSERT INTO tag_name(tag_id,lang,name) VALUES (?1,?2,?3)",
            params![local, name.lang, name.name],
        )?;
    }
    for alias in &definition.aliases {
        tx.execute(
            "INSERT OR IGNORE INTO tag_alias(tag_id,name,lang) VALUES (?1,?2,?3)",
            params![local, alias.name, alias.lang],
        )?;
    }
    for external in &definition.external {
        if external.vocabulary == "danbooru" {
            tx.execute(
                "INSERT OR IGNORE INTO tag_external(name,tag_id) VALUES (?1,?2)",
                params![external.name, local],
            )?;
        }
    }
    tx.execute("INSERT INTO tag_definition_dependency(local_tag_id,catalog_id,definition,authoritative) VALUES (?1,?2,?3,1)",
        params![local,definition.id,serde_json::to_string(definition).map_err(|e|Error::TagDefinitions(e.to_string()))?])?;
    Ok(local)
}
