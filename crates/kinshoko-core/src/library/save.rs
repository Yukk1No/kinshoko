//! Fixed save destination, separate from the workspace browse scope.
use super::{Error, ImportOptions, ImportSource, ImportTask, Library};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Explicit library and folder for saving. No folder means the library's unassigned area.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SaveDestination {
    pub library_id: String,
    pub folder_id: Option<String>,
}

impl Library {
    pub(crate) fn revoke_save_destination(&self) {
        self.inner
            .write_revoked
            .store(true, super::Ordering::SeqCst);
    }
    /// Snapshot for a visible, explicit source; original-only reference access remains private.
    pub fn content_snapshot(&self, image_id: &str) -> Result<super::ImageSnapshot, Error> {
        self.image(image_id)?;
        super::ReferenceLens::open_detached(&self.info().root, &self.info().id)?.snapshot(image_id)
    }

    /// Copy content and source facts. Existing manual note/rating/tag decisions are retained.
    pub fn copy_from(&self, source: &Library, image_id: &str) -> Result<String, Error> {
        self.copy_snapshot_from(source, image_id, &source.content_snapshot(image_id)?)
    }

    /// Allows the application catalog to attach current portable definitions to the same snapshot.
    pub fn copy_snapshot_from(
        &self,
        source: &Library,
        image_id: &str,
        snapshot: &super::ImageSnapshot,
    ) -> Result<String, Error> {
        source.image(image_id)?;
        let path = source.original_path(image_id)?;
        let origin = super::PackageOrigin {
            package_id: format!("copy-{}", source.info().id),
            source_library_id: source.info().id.clone(),
            source_image_id: image_id.into(),
            group_id: "source-copy".into(),
            group_name: format!("从「{}」复制", source.info().name),
            exported_at: super::now_ms(),
            location: path.to_string_lossy().into_owned(),
        };
        self.import_from_package(&origin, &std::fs::read(path)?, snapshot)
    }

    /// A fixed destination view reuses this provider's inner handle; it never reopens or activates it.
    pub fn for_destination(&self, destination: &SaveDestination) -> Result<Library, Error> {
        self.validate_destination(destination)?;
        Ok(Library {
            inner: self.inner.clone(),
            save_destination: Some(destination.clone()),
        })
    }

    pub fn import_to(
        &self,
        source: ImportSource,
        options: ImportOptions,
        destination: &SaveDestination,
    ) -> Result<ImportTask, Error> {
        self.validate_destination(destination)?;
        Ok(super::import::start_to(
            self.inner.clone(),
            source,
            options,
            destination.clone(),
        ))
    }

    pub fn validate_destination(&self, destination: &SaveDestination) -> Result<(), Error> {
        validate(&self.inner, destination)
    }
}

pub(super) fn validate(inner: &super::Inner, destination: &SaveDestination) -> Result<(), Error> {
    validate_authority(&inner.write_revoked)?;
    if inner.detached {
        return Err(Error::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "此资料库为只读提供方",
        )));
    }
    if destination.library_id != inner.info.id
        || Library::inspect(&inner.root)?.id != destination.library_id
    {
        return Err(Error::SourceChanged);
    }
    validate_folder(&inner.readers.get(), destination)
}

pub(super) fn validate_folder(
    conn: &rusqlite::Connection,
    destination: &SaveDestination,
) -> Result<(), Error> {
    if let Some(folder) = &destination.folder_id {
        super::folders::ensure_folder(conn, folder)?;
    }
    Ok(())
}

pub(super) fn assign(
    conn: &rusqlite::Connection,
    destination: &SaveDestination,
    image_id: &str,
) -> Result<(), Error> {
    if let Some(folder) = &destination.folder_id {
        conn.execute("INSERT OR IGNORE INTO folder_member (folder_id, image_id, added_at) SELECT ?1, id, ?3 FROM image WHERE id=?2 AND deleted_at IS NULL", rusqlite::params![folder, image_id, super::now_ms()])?;
        conn.execute("INSERT INTO folder_decision (folder_id, image_id, member) SELECT ?1, id, 1 FROM image WHERE id=?2 AND deleted_at IS NULL ON CONFLICT(folder_id,image_id) DO UPDATE SET member=1", rusqlite::params![folder, image_id])?;
    }
    Ok(())
}

pub(super) fn validate_authority(revoked: &std::sync::atomic::AtomicBool) -> Result<(), Error> {
    if revoked.load(super::Ordering::SeqCst) {
        return Err(Error::Io(std::io::Error::new(
            std::io::ErrorKind::NotConnected,
            "资料库已取消登记，保存目标不可用",
        )));
    }
    Ok(())
}
