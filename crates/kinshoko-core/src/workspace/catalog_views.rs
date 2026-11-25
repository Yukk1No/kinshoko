//! 工作区上的标签目录投影：状态、共享分组与整理视图都读同一份快照。
use super::*;

impl Workspace {
    /// Names and group management share browse safety, while unused definitions remain manageable.
    /// 复用这个工作区的快照（#337）：应用壳经共享的工作区读，不必每次从头装配各提供方。
    pub fn inspect_catalog(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        safe: bool,
    ) -> Result<TagCatalogWorkspace, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        let visible = visible_catalog(&snapshot, safe);
        if self.snapshot(device, catalog)?.status.revision != snapshot.status.revision {
            return Err(Error::CursorExpired.into());
        }
        Ok(TagCatalogWorkspace {
            catalog: visible,
            libraries: snapshot.status.libraries.clone(),
        })
    }
    pub fn status(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        safe: bool,
    ) -> Result<WorkspaceStatus, CatalogError> {
        Ok(self.snapshot(device, catalog)?.status(safe))
    }
    /// Shared groups use unified identities and the workspace's all-source safety view.
    pub fn tag_groups(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        _library_id: &str,
        lang: &str,
        safe: bool,
    ) -> Result<Vec<crate::library::TagGroupView>, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        catalog.groups(management_vocabulary(&snapshot, safe), lang)
    }
    pub fn shared_tag_groups(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        lang: &str,
        safe: bool,
    ) -> Result<Vec<crate::tag_catalog::CatalogGroupView>, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        catalog.group_views(management_vocabulary(&snapshot, safe), lang)
    }
}
