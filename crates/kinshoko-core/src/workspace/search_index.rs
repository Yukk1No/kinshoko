//! 工作区查找索引：候选与条件解析分别按安全视角和内置近似表缓存；没有未挂接预置标签时共享同一份构建。
use super::*;

#[derive(Clone)]
pub(super) struct CachedSearch {
    builtin: BuiltinApproxTable,
    search: std::sync::Arc<Search>,
}
impl Workspace {
    pub fn resolve(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        input: &SearchInput,
        lang: &str,
        safe: bool,
        builtin: &BuiltinApproxTable,
    ) -> Result<ConditionTree, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        // 点分组里还没人用过的预置标签也要解析成它自己（#484），近似对应才能展开。
        let search = self.resolve_search(&snapshot, safe, builtin);
        Ok(search.resolve_with_tag_fallback(input, lang, |id| {
            // 已点选的标签不因没有活动图片而消失，但仍须遵守安全模式。
            management_vocabulary(&snapshot, safe)
                .tags
                .iter()
                .find(|tag| tag.id == id)
                .map(|tag| display_label(id, tag.namespace, &tag.names, &tag.external, lang))
        }))
    }
    #[allow(clippy::too_many_arguments)]
    pub fn candidates(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        text: &str,
        lang: &str,
        limit: usize,
        safe: bool,
        builtin: &BuiltinApproxTable,
    ) -> Result<Vec<Candidate>, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        Ok(self
            .candidate_search(&snapshot, safe, builtin)
            .candidates(text, lang, limit))
    }
    fn candidate_search(
        &mut self,
        snapshot: &Snapshot,
        safe: bool,
        builtin: &BuiltinApproxTable,
    ) -> std::sync::Arc<Search> {
        let slot = if safe {
            &snapshot.safe_search
        } else {
            &snapshot.full_search
        };
        if let Some(search) = cached_search(slot, builtin) {
            return search;
        }
        let search = std::sync::Arc::new(Search::new(global_vocabulary(snapshot, safe), builtin));
        self.search_builds += 1;
        cache_search(slot, builtin, &search);
        search
    }
    fn resolve_search(
        &mut self,
        snapshot: &Snapshot,
        safe: bool,
        builtin: &BuiltinApproxTable,
    ) -> std::sync::Arc<Search> {
        let slot = if safe {
            &snapshot.safe_resolve_search
        } else {
            &snapshot.full_resolve_search
        };
        if let Some(search) = cached_search(slot, builtin) {
            return search;
        }
        let global = global_vocabulary(snapshot, safe);
        let present = global
            .tags
            .iter()
            .map(|tag| tag.id.as_str())
            .collect::<BTreeSet<_>>();
        let extra = unattached_preset_tags(snapshot)
            .into_iter()
            .filter(|tag| !present.contains(tag.id.as_str()))
            .collect::<Vec<_>>();
        let search = if extra.is_empty() {
            self.candidate_search(snapshot, safe, builtin)
        } else {
            let mut vocabulary = global.clone();
            vocabulary.tags.extend(extra);
            let search = std::sync::Arc::new(Search::new(&vocabulary, builtin));
            self.search_builds += 1;
            search
        };
        cache_search(slot, builtin, &search);
        search
    }
}
fn cached_search(
    slot: &std::sync::Mutex<Option<CachedSearch>>,
    builtin: &BuiltinApproxTable,
) -> Option<std::sync::Arc<Search>> {
    let entry = slot.lock().unwrap_or_else(|e| e.into_inner()).clone()?;
    (entry.builtin == *builtin).then_some(entry.search)
}
fn cache_search(
    slot: &std::sync::Mutex<Option<CachedSearch>>,
    builtin: &BuiltinApproxTable,
    search: &std::sync::Arc<Search>,
) {
    *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(CachedSearch {
        builtin: builtin.clone(),
        search: search.clone(),
    });
}
