//! Receipt projection uses the same all-known-provider inventory as ordinary browsing.
use super::*;
use crate::{ImportTaskSnapshot, library::ImportOutcome};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone)]
struct PreviewEntry {
    image_id: String,
    sha256: String,
}
pub(crate) struct ImportPreviewAuthorization {
    id: String,
    pub(crate) task_id: String,
    library_id: String,
    revision: String,
    entries: BTreeMap<String, PreviewEntry>,
    active: AtomicBool,
}
/// An opaque read. Decoding can run without retaining the task/device registry lock.
/// Its result cannot expose bytes until completion revalidates the context.
pub struct PreparedImportPreview {
    authorization: Arc<ImportPreviewAuthorization>,
    entry: PreviewEntry,
    library: Arc<crate::Library>,
    target_px: u32,
}
pub struct ResolvedImportPreview {
    authorization: Arc<ImportPreviewAuthorization>,
    entry: PreviewEntry,
    content: ImportPreviewContent,
}
pub struct ImportPreviewContent {
    pub bytes: Vec<u8>,
    pub mime_type: String,
}
impl PreparedImportPreview {
    pub fn resolve(self) -> Result<ResolvedImportPreview, CatalogError> {
        if !self.authorization.active.load(Ordering::SeqCst) {
            return Err(Error::LensChanged.into());
        }
        let (bytes, mime_type) = self.library.read_import_duplicate(
            &self.entry.image_id,
            &self.entry.sha256,
            self.target_px,
        )?;
        if !self.authorization.active.load(Ordering::SeqCst) {
            return Err(Error::LensChanged.into());
        }
        Ok(ResolvedImportPreview {
            authorization: self.authorization,
            entry: self.entry,
            content: ImportPreviewContent { bytes, mime_type },
        })
    }
}
impl DeviceLibraries {
    /// Close this preview or revoke every preview when its UI context is lost.
    /// A late close for an older session cannot cancel newer explicit consent.
    pub fn close_import_preview(&mut self, session_id: Option<&str>) -> bool {
        if self
            .import_preview
            .as_ref()
            .is_some_and(|preview| session_id.is_none_or(|id| id == preview.id))
        {
            if let Some(preview) = self.import_preview.take() {
                preview.active.store(false, Ordering::SeqCst);
            }
            return true;
        }
        false
    }
}
fn duplicate(
    snapshot: &Snapshot,
    owner: &str,
    image: &crate::library::provider::ProviderImage,
    outcome: &ImportOutcome,
) -> bool {
    matches!(
        outcome,
        ImportOutcome::Merged { .. } | ImportOutcome::Refreshed { .. }
    ) || snapshot.providers.iter().any(|p| {
        p.images.iter().any(|other| {
            other.sha256 == image.sha256
                && (p.registration.library.id != owner || other.id != image.id)
        })
    })
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportPreviewSession {
    pub id: String,
    pub items: Vec<String>,
}

impl Workspace {
    /// Explicit consent for a completed, backend-owned receipt.
    pub fn open_import_preview(
        &mut self,
        device: &mut DeviceLibraries,
        catalog: &mut TagCatalog,
        library_id: &str,
        task_id: &str,
        safe: bool,
    ) -> Result<ImportPreviewSession, CatalogError> {
        device.close_import_preview(None);
        if !safe {
            return Err(Error::LensChanged.into());
        }
        let receipt = device
            .import_task(task_id)
            .filter(|receipt| receipt.destination.library_id == library_id && !receipt.finishing)
            .ok_or(Error::SourceChanged)?;
        let report = receipt.report.ok_or(Error::SourceChanged)?;
        let snapshot = self.snapshot(device, catalog)?;
        let provider = snapshot
            .providers
            .iter()
            .find(|p| {
                p.registration.library.id == library_id && p.registration.unavailable.is_none()
            })
            .ok_or(Error::SourceChanged)?;
        let mut entries = BTreeMap::new();
        let mut seen = BTreeSet::new();
        for item in report.items {
            let Some(id) = item.outcome.image_id() else {
                continue;
            };
            let Some(image) = provider
                .images
                .iter()
                .find(|image| image.id == id && !image.deleted)
            else {
                continue;
            };
            if snapshot.adult.contains(&image.sha256)
                && duplicate(&snapshot, library_id, image, &item.outcome)
                && seen.insert(image.id.clone())
            {
                entries.insert(
                    uuid::Uuid::new_v4().simple().to_string(),
                    PreviewEntry {
                        image_id: image.id.clone(),
                        sha256: image.sha256.clone(),
                    },
                );
            }
        }
        if entries.is_empty() {
            return Err(Error::UnknownImage.into());
        }
        let authorization = Arc::new(ImportPreviewAuthorization {
            id: uuid::Uuid::new_v4().simple().to_string(),
            task_id: task_id.into(),
            library_id: library_id.into(),
            revision: snapshot.status.revision.clone(),
            entries,
            active: AtomicBool::new(true),
        });
        let session = ImportPreviewSession {
            id: authorization.id.clone(),
            items: authorization.entries.keys().cloned().collect(),
        };
        device.import_preview = Some(authorization);
        Ok(session)
    }
    fn validate_import_preview(
        &mut self,
        device: &mut DeviceLibraries,
        catalog: &mut TagCatalog,
        authorization: &Arc<ImportPreviewAuthorization>,
        safe: bool,
    ) -> Result<(), CatalogError> {
        if !safe {
            device.close_import_preview(Some(&authorization.id));
        }
        let valid = safe
            && authorization.active.load(Ordering::SeqCst)
            && device
                .import_preview
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, authorization));
        if !valid {
            return Err(Error::LensChanged.into());
        }
        let receipt = device
            .import_task(&authorization.task_id)
            .filter(|receipt| {
                receipt.destination.library_id == authorization.library_id
                    && receipt.report.is_some()
                    && !receipt.finishing
            })
            .ok_or(Error::SourceChanged)?;
        let snapshot = self.snapshot(device, catalog)?;
        if snapshot.status.revision != authorization.revision {
            authorization.active.store(false, Ordering::SeqCst);
            return Err(Error::SourceChanged.into());
        }
        let provider = snapshot
            .providers
            .iter()
            .find(|p| {
                p.registration.library.id == authorization.library_id
                    && p.registration.unavailable.is_none()
            })
            .ok_or(Error::SourceChanged)?;
        for entry in authorization.entries.values() {
            let allowed = provider.images.iter().any(|image| {
                image.id == entry.image_id
                    && image.sha256 == entry.sha256
                    && !image.deleted
                    && snapshot.adult.contains(&image.sha256)
            });
            let on_receipt = receipt.report.as_ref().is_some_and(|r| {
                r.items
                    .iter()
                    .any(|item| item.outcome.image_id() == Some(entry.image_id.as_str()))
            });
            if !allowed || !on_receipt {
                return Err(Error::SourceChanged.into());
            }
        }
        Ok(())
    }
    pub fn prepare_import_preview(
        &mut self,
        device: &mut DeviceLibraries,
        catalog: &mut TagCatalog,
        session_id: &str,
        item_id: &str,
        safe: bool,
        target_px: u32,
    ) -> Result<PreparedImportPreview, CatalogError> {
        let authorization = device
            .import_preview
            .as_ref()
            .filter(|p| p.id == session_id)
            .cloned()
            .ok_or(Error::LensChanged)?;
        self.validate_import_preview(device, catalog, &authorization, safe)?;
        let entry = authorization
            .entries
            .get(item_id)
            .cloned()
            .ok_or(Error::UnknownImage)?;
        let library = device
            .read(&authorization.library_id)
            .map_err(|e| CatalogError::Io(std::io::Error::other(e.to_string())))?;
        Ok(PreparedImportPreview {
            authorization,
            entry,
            library,
            target_px: target_px.clamp(1, 4096),
        })
    }
    /// Authorization is checked after decoding and file reads, immediately before bytes leave.
    pub fn complete_import_preview(
        &mut self,
        device: &mut DeviceLibraries,
        catalog: &mut TagCatalog,
        resolved: ResolvedImportPreview,
        safe: bool,
    ) -> Result<ImportPreviewContent, CatalogError> {
        self.validate_import_preview(device, catalog, &resolved.authorization, safe)?;
        let library = device
            .read(&resolved.authorization.library_id)
            .map_err(|e| CatalogError::Io(std::io::Error::other(e.to_string())))?;
        let current = library.provider_snapshot()?;
        if !current.images.iter().any(|image| {
            image.id == resolved.entry.image_id
                && image.sha256 == resolved.entry.sha256
                && !image.deleted
        }) {
            return Err(Error::SourceChanged.into());
        }
        Ok(resolved.content)
    }
    pub fn import_receipts(
        &mut self,
        device: &mut DeviceLibraries,
        catalog: &mut TagCatalog,
        safe: bool,
    ) -> Result<Vec<ImportTaskSnapshot>, CatalogError> {
        let mut receipts = device.import_tasks();
        if !safe {
            return Ok(receipts);
        }
        let snapshot = self.snapshot(device, catalog)?;
        for receipt in &mut receipts {
            let Some(report) = &mut receipt.report else {
                continue;
            };
            let provider = snapshot.providers.iter().find(|provider| {
                provider.registration.library.id == receipt.destination.library_id
                    && provider.registration.unavailable.is_none()
            });
            let mut hidden = false;
            for item in &report.items {
                let Some(id) = item.outcome.image_id() else {
                    continue;
                };
                let image = provider.and_then(|p| p.images.iter().find(|image| image.id == id));
                let Some(image) = image else {
                    hidden = true;
                    continue;
                };
                if image.deleted
                    && duplicate(
                        &snapshot,
                        &receipt.destination.library_id,
                        image,
                        &item.outcome,
                    )
                {
                    report.trash_duplicates = true;
                }
                if !snapshot.adult.contains(&image.sha256) {
                    continue;
                }
                hidden = true;
                let duplicate = duplicate(
                    &snapshot,
                    &receipt.destination.library_id,
                    image,
                    &item.outcome,
                );
                report.sealed_duplicates |= duplicate && !image.deleted;
            }
            if hidden {
                *report = report.clone().without_content_details();
                // The completed total minus retained failures would reveal a sealed-only
                // success count. Live task progress remains in the existing task owner.
                receipt.progress = Default::default();
            }
        }
        Ok(receipts)
    }
}
