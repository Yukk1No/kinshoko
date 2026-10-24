//! Content dependencies explain identities without carrying application preferences.
use crate::library::{LocalizedName, TagAlias, TagNamespace};
use crate::tag_catalog::ExternalTagIdentity;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A shared identity's content definition. Resolved display preferences never belong here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PortableTagDefinition {
    pub id: String,
    pub namespace: TagNamespace,
    pub default_names: Vec<LocalizedName>,
    pub aliases: Vec<TagAlias>,
    pub external: Vec<ExternalTagIdentity>,
}

/// A library's explicit local correspondence. Initial local definitions may still acquire an
/// external correspondence during first enrollment; published application choices are authoritative.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PortableTagBinding {
    pub local_tag_id: String,
    pub definition: PortableTagDefinition,
    pub authoritative: bool,
}

impl PortableTagDefinition {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 128
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("统一标签身份无效".into());
        }
        let mut languages = std::collections::BTreeSet::new();
        for name in &self.default_names {
            if name.lang.trim().is_empty()
                || name.name.trim().is_empty()
                || !languages.insert(&name.lang)
            {
                return Err("标签默认名称无效或语言重复".into());
            }
        }
        for alias in &self.aliases {
            if alias.name.trim().is_empty()
                || alias.lang.as_ref().is_some_and(|l| l.trim().is_empty())
            {
                return Err("标签别名无效".into());
            }
        }
        if self
            .external
            .iter()
            .any(|e| e.vocabulary.trim().is_empty() || e.name.trim().is_empty())
        {
            return Err("标签外部对应无效".into());
        }
        Ok(())
    }
}
