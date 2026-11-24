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

impl Workspace {
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
            return Err(CatalogError::Command(Box::new(crate::CommandError::new(
                crate::command_error::ErrorKind::SourceOriginalMissing,
                "此来源的原图文件不可用，请连接原资料库",
            ))));
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
        .map_err(|e| CatalogError::Command(Box::new(e.into())))
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
            return Err(CatalogError::Command(Box::new(reason.clone())));
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
            .map_err(|e| CatalogError::Command(Box::new(e.into())))?;
        library.set_safe_mode(safe);
        Ok(library)
    }

    /// 一次整理同一图库的多份来源（#290），用调用方按需取得的可写句柄（ADR-0008）：只核对一次，
    /// `action` 只调一次，拿到这些来源的图片 id（顺序同输入）。任何一份来源不属于句柄的图库、
    /// 或核对不过时整批都不做。不碰别的副本。
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
