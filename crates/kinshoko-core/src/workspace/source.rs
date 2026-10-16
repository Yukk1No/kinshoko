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
        let snapshot = self.snapshot(device, catalog)?;
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
        library.set_safe_mode(safe);
        Ok(action(&library)?)
    }
}
