//! 工作区的标签目录与词表：按安全模式与实际使用决定哪些定义可见，以及用它们的整理入口。
use super::*;

pub(super) fn local_labels(
    tag: &TagLabel,
    catalog: &CatalogInspection,
    library: &str,
) -> Vec<TagLabel> {
    catalog
        .mappings
        .iter()
        .filter(|m| m.library_id == library && m.catalog_id == tag.id)
        .map(|m| TagLabel {
            id: m.local_tag_id.clone(),
            ..tag.clone()
        })
        .collect()
}
pub(super) fn local_tree(
    tree: &ConditionTree,
    catalog: &CatalogInspection,
    library: &str,
) -> ConditionTree {
    ConditionTree {
        conditions: tree
            .conditions
            .iter()
            .map(|condition| Condition {
                negate: condition.negate,
                any: condition
                    .any
                    .iter()
                    .flat_map(|term| match term {
                        Term::Rating { .. } => vec![term.clone()],
                        Term::Tag { tag, similar } => std::iter::once(tag)
                            .chain(similar.iter().map(|s| &s.tag))
                            .flat_map(|label| local_labels(label, catalog, library))
                            .map(|tag| Term::Tag {
                                tag,
                                similar: vec![],
                            })
                            .collect(),
                        Term::Text {
                            text,
                            tags,
                            similar,
                            ratings,
                        } => vec![Term::Text {
                            ratings: ratings.clone(),
                            text: text.clone(),
                            tags: tags
                                .iter()
                                .chain(similar.iter().map(|s| &s.tag))
                                .flat_map(|label| local_labels(label, catalog, library))
                                .collect(),
                            similar: vec![],
                        }],
                    })
                    .collect(),
            })
            .collect(),
    }
}
/// Preserve definitions with no effective usage. Hide only definitions whose usage is all vetoed.
/// Deleted images still establish usage, matching Library's sealed-only rule; counts exclude trash.
pub(super) fn visible_catalog(snapshot: &Snapshot, safe: bool) -> CatalogInspection {
    let mut visible = BTreeSet::new();
    for provider in &snapshot.providers {
        let Some(vocabulary) = &provider.vocabulary else {
            continue;
        };
        let mut sealed = BTreeSet::new();
        let mut unsealed = BTreeSet::new();
        if safe {
            for image in &provider.images {
                let target = if snapshot.adult.contains(&image.sha256) {
                    &mut sealed
                } else {
                    &mut unsealed
                };
                target.extend(image.tags.iter().map(String::as_str));
            }
        }
        visible.extend(
            vocabulary
                .tags
                .iter()
                .filter(|tag| {
                    !sealed.contains(tag.id.as_str()) || unsealed.contains(tag.id.as_str())
                })
                .map(|tag| (provider.registration.library.id.as_str(), tag.id.as_str())),
        );
    }
    let mut catalog = snapshot.catalog.clone();
    catalog.mappings.retain(|mapping| {
        visible.contains(&(mapping.library_id.as_str(), mapping.local_tag_id.as_str()))
    });
    let ids = catalog
        .mappings
        .iter()
        .map(|mapping| mapping.catalog_id.as_str())
        .collect::<BTreeSet<_>>();
    catalog.tags.retain(|tag| ids.contains(tag.id.as_str()));
    // 来源名称只取看得见的映射：不可用资料库或安全模式藏起的标签不能露出原文。
    for tag in &mut catalog.tags {
        let id = tag.id.clone();
        let sources = catalog
            .mappings
            .iter()
            .filter(|mapping| mapping.catalog_id == id)
            .flat_map(|mapping| &mapping.source_names);
        crate::tag_catalog::fill_names(tag, sources);
    }
    catalog
}
/// Search candidates remain tied to live effective usage. Management also retains legitimate zero-use definitions.
pub(super) fn management_vocabulary(snapshot: &Snapshot, safe: bool) -> &Vocabulary {
    let cache = if safe {
        &snapshot.safe_management_vocabulary
    } else {
        &snapshot.full_management_vocabulary
    };
    cache.get_or_init(|| {
        let mut vocabulary = global_vocabulary(snapshot, safe).clone();
        let present = vocabulary
            .tags
            .iter()
            .map(|tag| tag.id.clone())
            .collect::<BTreeSet<_>>();
        for tag in visible_catalog(snapshot, safe).tags {
            if !present.contains(&tag.id) {
                vocabulary.tags.push(VocabularyTag {
                    id: tag.id,
                    namespace: tag.namespace,
                    names: tag.names,
                    aliases: tag.aliases,
                    external: tag
                        .external
                        .into_iter()
                        .filter(|entry| entry.vocabulary == "danbooru")
                        .map(|entry| entry.name)
                        .collect(),
                    count: 0,
                    source_names: Vec::new(),
                });
            }
        }
        vocabulary.tags.sort_by(|a, b| a.id.cmp(&b.id));
        vocabulary
    })
}
pub(super) fn global_vocabulary(snapshot: &Snapshot, safe: bool) -> &Vocabulary {
    let cache = if safe {
        &snapshot.safe_vocabulary
    } else {
        &snapshot.full_vocabulary
    };
    cache.get_or_init(|| build_vocabulary(snapshot, safe))
}
pub(super) fn build_vocabulary(snapshot: &Snapshot, safe: bool) -> Vocabulary {
    let hidden = &snapshot.adult;
    let mut counts = BTreeMap::<String, BTreeSet<String>>::new();
    let mut tags = BTreeMap::<String, VocabularyTag>::new();
    for provider in &snapshot.providers {
        let Some(local_vocabulary) = &provider.vocabulary else {
            continue;
        };
        let vocabulary = snapshot
            .catalog
            .search_vocabulary(&provider.registration.library.id, local_vocabulary);
        let shared = snapshot
            .catalog
            .tags
            .iter()
            .map(|tag| (tag.id.as_str(), tag))
            .collect::<BTreeMap<_, _>>();
        let mappings = snapshot
            .catalog
            .mappings
            .iter()
            .filter(|m| m.library_id == provider.registration.library.id)
            .map(|m| (m.local_tag_id.as_str(), m.catalog_id.as_str()))
            .collect::<BTreeMap<_, _>>();
        // One pass over effective memberships; no vocabulary × image scan.
        let mut visible = BTreeMap::<&str, BTreeSet<String>>::new();
        for image in &provider.images {
            if image.deleted || (safe && hidden.contains(&image.sha256)) {
                continue;
            }
            for local_id in &image.tags {
                visible
                    .entry(local_id.as_str())
                    .or_default()
                    .insert(image.sha256.clone());
            }
        }
        for local in &vocabulary.tags {
            let Some(catalog_id) = mappings.get(local.id.as_str()) else {
                continue;
            };
            let Some(hashes) = visible.remove(local.id.as_str()) else {
                continue;
            };
            if hashes.is_empty() {
                continue;
            }
            counts
                .entry((*catalog_id).to_owned())
                .or_default()
                .extend(hashes);
            let entry = tags
                .entry((*catalog_id).to_owned())
                .or_insert_with(|| VocabularyTag {
                    id: (*catalog_id).to_owned(),
                    count: 0,
                    // 跨库显示：名称偏好 > 默认名称 > 按资料库顺序的第一个来源名称（ADR-0012）。
                    names: shared
                        .get(catalog_id)
                        .map_or_else(|| local.names.clone(), |tag| tag.names.clone()),
                    source_names: Vec::new(),
                    ..local.clone()
                });
            for alias in local
                .aliases
                .iter()
                .cloned()
                .chain(local.names.iter().map(|n| TagAlias {
                    name: n.name.clone(),
                    lang: Some(n.lang.clone()),
                }))
            {
                if !entry.aliases.contains(&alias) {
                    entry.aliases.push(alias);
                }
            }
            for external in &local.external {
                if !entry.external.contains(external) {
                    entry.external.push(external.clone());
                }
            }
        }
    }
    for (id, tag) in &mut tags {
        tag.count = counts.get(id).map_or(0, |c| c.len() as u32);
    }
    Vocabulary {
        revision: snapshot.catalog.revision,
        tags: tags.into_values().collect(),
        personal_approx: snapshot.personal_approx.clone(),
        safe_mode: safe,
        safe_mode_scope: snapshot.scope,
    }
}

impl Workspace {
    pub fn edit_group(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        edit: &crate::tag_catalog::CatalogGroupEdit,
        safe: bool,
    ) -> Result<(), CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        catalog.edit_group(edit, management_vocabulary(&snapshot, safe))
    }
}

impl Workspace {
    pub fn edit_approx(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        edit: &crate::tag_catalog::CatalogApproxEdit,
        safe: bool,
    ) -> Result<(), CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        catalog.edit_approx(edit, management_vocabulary(&snapshot, safe))
    }
}

impl Workspace {
    pub fn personal_approx(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        lang: &str,
        safe: bool,
    ) -> Result<crate::tag_catalog::CatalogApproxView, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        catalog.approx_view(management_vocabulary(&snapshot, safe), lang)
    }
}
