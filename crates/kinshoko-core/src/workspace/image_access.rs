//! 工作区图片访问授权：按快照判定字节身份与安全封印，并发放长期只读句柄。
use super::*;

impl Workspace {
    /// Authorize one image read for a thumbnail or display request (#123) and return its provider
    /// reader: the slow path behind [`ImageGate::authorize`]. Same checks as `contains` bracketed by
    /// an unchanged revision; the snapshot it takes is published to the gate, so the next requests
    /// take the fast path again. The reader is the shared unfiltered one (see `ImageGate`).
    pub fn image_reader(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        library_id: &str,
        image_id: &str,
        safe: bool,
    ) -> Result<std::sync::Arc<crate::library::Library>, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        let allowed = snapshot
            .identities
            .get(&(library_id.into(), image_id.into()))
            .is_some_and(|hash| !safe || !snapshot.adult.contains(hash));
        if !allowed {
            return Err(Error::UnknownImage.into());
        }
        let registration = device
            .libraries()
            .iter()
            .find(|r| r.id == library_id)
            .ok_or(Error::UnknownImage)?
            .clone();
        let library = self.provider(device, &registration)?;
        if self.snapshot(device, catalog)?.status.revision != snapshot.status.revision {
            return Err(Error::CursorExpired.into());
        }
        Ok(library)
    }
    /// 登记的提供方的长期只读句柄（[`ImageGate`]）：不按安全模式过滤，调用方按快照判断封印。
    pub(super) fn provider(
        &self,
        device: &DeviceLibraries,
        registration: &crate::RegisteredLibrary,
    ) -> Result<std::sync::Arc<crate::library::Library>, CatalogError> {
        self.gate
            .reader(registration, device.safe_mode_scope())
            .map_err(|e| CatalogError::Command(Box::new(e)))
    }
    /// O(log n) authorization after bounded provider/catalog revision checks, including trash views.
    pub fn contains(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        library_id: &str,
        image_id: &str,
        safe: bool,
    ) -> Result<bool, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        let Some(hash) = snapshot
            .identities
            .get(&(library_id.into(), image_id.into()))
        else {
            return Ok(false);
        };
        Ok(!safe || !snapshot.adult.contains(hash))
    }
}
