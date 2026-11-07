//! 单图详情的读取（#424）与整理的写入（#425）：都按（资料库，图）寻址。读取不切换任何句柄；
//! 写入用调用方按需取得的可写句柄。可见性复核与安全模式封印都在 `require_visible_images` 这一处。
use super::*;
use crate::Library;
use crate::library::ImageDetail;
use crate::safe_mode::SafeModeState;
use crate::tag_catalog::CatalogImageTags;

/// 快照建到一半提供方又变了（导入收尾、后台打标）时重取几次，不把这种竞争报给界面。
const SNAPSHOT_ATTEMPTS: u32 = 3;

impl Workspace {
    pub fn image_detail(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        safe_mode: &SafeModeState,
        library_id: &str,
        image_id: &str,
    ) -> Result<ImageDetail, CatalogError> {
        self.read_visible_image(
            device,
            catalog,
            safe_mode,
            library_id,
            image_id,
            |_, _, l| Ok(l.image(image_id)?),
        )
    }

    pub fn image_tags(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        safe_mode: &SafeModeState,
        library_id: &str,
        image_id: &str,
        lang: &str,
    ) -> Result<CatalogImageTags, CatalogError> {
        self.read_visible_image(
            device,
            catalog,
            safe_mode,
            library_id,
            image_id,
            |_, c, l| c.image_tags(l, image_id, lang),
        )
    }

    /// 读这张图的内容。读之前和读之后各核对一次：资料库已移除、图不存在或已被封印（含别的资料库
    /// 里同一文件的分级）时都是 [`Error::UnknownImage`]；其间安全模式有过提交时丢弃结果，
    /// 报 [`Error::LensChanged`]。不比较修订号：别的图在变不影响这张图的读取。
    pub fn read_visible_image<T>(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        safe_mode: &SafeModeState,
        library_id: &str,
        image_id: &str,
        read: impl FnOnce(&mut Self, &mut TagCatalog, &Library) -> Result<T, CatalogError>,
    ) -> Result<T, CatalogError> {
        let expected = safe_mode.snapshot();
        let safe = safe_mode.current().on;
        let ids = [image_id.to_owned()];
        self.require_visible_images(device, catalog, library_id, &ids, safe)?;
        let library = device
            .resolve(library_id, safe)
            .map_err(|e| CatalogError::Command(Box::new(e.into())))?;
        let value = read(self, catalog, &library)?;
        self.require_visible_images(device, catalog, library_id, &ids, safe)?;
        if !safe_mode.still(&expected) {
            return Err(Error::LensChanged.into());
        }
        Ok(value)
    }

    /// 把 `action` 写到 `writer` 的资料库。写之前在同一份快照上核对这些图都可见，规则同
    /// [`Self::read_visible_image`]；有一张不可见时整批都不写。句柄由调用方按需取得（ADR-0008）。
    pub fn write_visible_images<T>(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        safe_mode: &SafeModeState,
        writer: &Library,
        image_ids: &[String],
        action: impl FnOnce(&Library) -> Result<T, Error>,
    ) -> Result<T, CatalogError> {
        let safe = safe_mode.current().on;
        self.require_visible_images(device, catalog, &writer.info().id, image_ids, safe)?;
        writer.set_safe_mode(safe);
        Ok(action(writer)?)
    }

    fn require_visible_images(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        library_id: &str,
        image_ids: &[String],
        safe: bool,
    ) -> Result<(), CatalogError> {
        let mut attempts = 1;
        let snapshot = loop {
            match self.snapshot(device, catalog) {
                Err(CatalogError::Library(Error::CursorExpired))
                    if attempts < SNAPSHOT_ATTEMPTS =>
                {
                    attempts += 1;
                }
                result => break result?,
            }
        };
        let provider = snapshot
            .providers
            .iter()
            .find(|p| p.registration.library.id == library_id)
            .ok_or(Error::UnknownImage)?;
        if let Some(reason) = &provider.registration.unavailable {
            return Err(CatalogError::Command(Box::new(reason.clone())));
        }
        for image_id in image_ids {
            let hash = snapshot
                .identities
                .get(&(library_id.to_owned(), image_id.clone()))
                .ok_or(Error::UnknownImage)?;
            if safe && snapshot.adult.contains(hash) {
                return Err(Error::UnknownImage.into());
            }
        }
        Ok(())
    }
}
