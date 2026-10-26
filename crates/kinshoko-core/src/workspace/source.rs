//! Explicit aggregate-source actions. Byte identity is a guard, never a fallback lookup.
use super::*;
use crate::Library;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceSourceTarget {
    pub library_id: String,
    pub image_id: String,
    pub content_id: String,
}

/// 同一个图库里要一起整理的来源（#290）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceSourceBatch {
    pub library_id: String,
    pub targets: Vec<WorkspaceSourceTarget>,
}

/// 按图库分组，图库按第一次出现的先后，组内去掉重复的图并保持先后。
pub fn group_sources(targets: &[WorkspaceSourceTarget]) -> Vec<WorkspaceSourceBatch> {
    let mut batches: Vec<WorkspaceSourceBatch> = Vec::new();
    for target in targets {
        let index = match batches
            .iter()
            .position(|b| b.library_id == target.library_id)
        {
            Some(index) => index,
            None => {
                batches.push(WorkspaceSourceBatch {
                    library_id: target.library_id.clone(),
                    targets: Vec::new(),
                });
                batches.len() - 1
            }
        };
        let batch = &mut batches[index];
        if !batch.targets.iter().any(|t| t.image_id == target.image_id) {
            batch.targets.push(target.clone());
        }
    }
    batches
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceSourceInspection {
    pub detail: crate::library::ImageDetail,
    pub tags: crate::tag_catalog::CatalogImageTags,
    pub sidebar: crate::library::Sidebar,
}

impl Workspace {
    pub fn inspect_source(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        target: &WorkspaceSourceTarget,
        safe: bool,
        lang: &str,
    ) -> Result<WorkspaceSourceInspection, CatalogError> {
        let before = self.status(device, catalog, safe)?.revision;
        let library = self.read_source(device, catalog, target, safe)?;
        let detail = library.image(&target.image_id)?;
        let tags = catalog.image_tags(&library, &target.image_id, lang)?;
        let sidebar = self.sidebar(device, catalog, &target.library_id, safe)?;
        self.require_source(device, catalog, target, safe)?;
        if before != self.status(device, catalog, safe)?.revision {
            return Err(Error::CursorExpired.into());
        }
        Ok(WorkspaceSourceInspection {
            detail,
            tags,
            sidebar,
        })
    }

    /// Local IDs for editing, with vocabulary/counts filtered by the workspace's
    /// all-known-source Adult veto. A picker cannot leak tags belonging only to hidden copies.
    pub fn source_candidates(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        target: &WorkspaceSourceTarget,
        safe: bool,
        text: &str,
        lang: &str,
    ) -> Result<Vec<Candidate>, CatalogError> {
        self.require_source(device, catalog, target, safe)?;
        let snapshot = self.snapshot(device, catalog)?;
        let provider = snapshot
            .providers
            .iter()
            .find(|p| p.registration.library.id == target.library_id)
            .ok_or(Error::SourceChanged)?;
        let raw = provider.vocabulary.as_ref().ok_or(Error::SourceChanged)?;
        let mut vocabulary = snapshot.catalog.search_vocabulary(&target.library_id, raw);
        let mut counts = BTreeMap::<&str, u32>::new();
        for image in &provider.images {
            if image.deleted || (safe && snapshot.adult.contains(&image.sha256)) {
                continue;
            }
            for tag in &image.tags {
                *counts.entry(tag).or_default() += 1;
            }
        }
        vocabulary.tags.retain_mut(|tag| {
            tag.count = counts.get(tag.id.as_str()).copied().unwrap_or(0);
            tag.count > 0
        });
        Ok(Search::new(&vocabulary, &BuiltinApproxTable::default()).candidates(text, lang, 8))
    }

    /// Create a stable reference to the selected library and original image. Byte-identical
    /// alternatives can later help display, but do not change this saved identity.
    pub fn source_reference(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        target: &WorkspaceSourceTarget,
        safe: bool,
    ) -> Result<crate::desktop::SavedPin, CatalogError> {
        let library = self.read_source(device, catalog, target, safe)?;
        if !library.original_path(&target.image_id)?.is_file() {
            return Err(CatalogError::Io(std::io::Error::other(
                "此来源的原图文件不可用，请连接原资料库",
            )));
        }
        let lens =
            crate::library::ReferenceLens::open_detached(&library.info().root, &target.library_id)?;
        let image = lens.image(&target.image_id)?;
        crate::desktop::SavedPin::reference(
            &uuid::Uuid::new_v4().simple().to_string(),
            &target.library_id,
            &image,
            None,
            crate::desktop::Placement::default(),
        )
        .map_err(|e| CatalogError::Io(std::io::Error::other(e.to_string())))
    }

    fn require_source(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        target: &WorkspaceSourceTarget,
        safe: bool,
    ) -> Result<(), CatalogError> {
        self.require_sources(device, catalog, std::slice::from_ref(target), safe)
    }

    /// 在同一份快照上核对每一份来源。
    fn require_sources(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        targets: &[WorkspaceSourceTarget],
        safe: bool,
    ) -> Result<(), CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        for target in targets {
            Self::require_in(&snapshot, target, safe)?;
        }
        Ok(())
    }

    fn require_in(
        snapshot: &Snapshot,
        target: &WorkspaceSourceTarget,
        safe: bool,
    ) -> Result<(), CatalogError> {
        let provider = snapshot
            .providers
            .iter()
            .find(|p| p.registration.library.id == target.library_id)
            .ok_or(Error::SourceChanged)?;
        if let Some(reason) = &provider.registration.unavailable {
            return Err(CatalogError::Io(std::io::Error::other(reason.clone())));
        }
        let hash = snapshot
            .identities
            .get(&(target.library_id.clone(), target.image_id.clone()))
            .filter(|hash| **hash == target.content_id)
            .ok_or(Error::SourceChanged)?;
        if safe && snapshot.adult.contains(hash) {
            return Err(Error::UnknownImage.into());
        }
        Ok(())
    }

    /// Read the exact selected source, including all-known-source safety. No activation.
    pub fn read_source(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        target: &WorkspaceSourceTarget,
        safe: bool,
    ) -> Result<Arc<Library>, CatalogError> {
        self.require_source(device, catalog, target, safe)?;
        let library = device
            .read(&target.library_id)
            .map_err(|e| CatalogError::Io(std::io::Error::other(e.to_string())))?;
        library.set_safe_mode(safe);
        Ok(library)
    }

    /// Complete a synchronous action in the chosen provider. The caller serializes registry
    /// transitions; the target is checked again on every action. No other copy is edited.
    pub fn write_source<T>(
        &mut self,
        device: &mut DeviceLibraries,
        catalog: &mut TagCatalog,
        target: &WorkspaceSourceTarget,
        safe: bool,
        action: impl FnOnce(&Library) -> Result<T, Error>,
    ) -> Result<T, CatalogError> {
        self.require_source(device, catalog, target, safe)?;
        let library = device
            .write(&target.library_id)
            .map_err(|e| CatalogError::Io(std::io::Error::other(e.to_string())))?;
        self.write_source_with(device, catalog, target, safe, &library, action)
    }

    /// 同 [`Self::write_source`]，但用调用方已按需取得的可写句柄（ADR-0008：应用壳经
    /// [`DeviceLibraries::organize`] 切换唯一的可写句柄、等导入收尾），不另开一个。
    /// 句柄必须属于所选来源的图库；来源在这里重新核对。
    pub fn write_source_with<T>(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        target: &WorkspaceSourceTarget,
        safe: bool,
        writer: &Library,
        action: impl FnOnce(&Library) -> Result<T, Error>,
    ) -> Result<T, CatalogError> {
        self.write_sources_with(
            device,
            catalog,
            std::slice::from_ref(target),
            safe,
            writer,
            |library, _| action(library),
        )
    }

    /// 同 [`Self::write_source_with`]，一次整理同一图库的多份来源（#290）：只核对一次，
    /// `action` 只调一次，拿到这些来源的图片 id（顺序同输入）。任何一份来源不属于句柄的图库、
    /// 或核对不过时整批都不做。
    pub fn write_sources_with<T>(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        targets: &[WorkspaceSourceTarget],
        safe: bool,
        writer: &Library,
        action: impl FnOnce(&Library, &[String]) -> Result<T, Error>,
    ) -> Result<T, CatalogError> {
        if targets.iter().any(|t| writer.info().id != t.library_id) {
            return Err(Error::SourceChanged.into());
        }
        self.require_sources(device, catalog, targets, safe)?;
        writer.set_safe_mode(safe);
        let ids: Vec<String> = targets.iter().map(|t| t.image_id.clone()).collect();
        Ok(action(writer, &ids)?)
    }
}
