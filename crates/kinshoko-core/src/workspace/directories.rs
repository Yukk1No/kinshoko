//! 工作区目录投影：所有登记根与单个资料库侧栏都按同一份安全快照计数。
use super::*;

impl Workspace {
    /// Every registered root and its complete directory tree share one safety/revision snapshot.
    pub fn directories(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        safe: bool,
    ) -> Result<WorkspaceDirectories, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        let mut providers = Vec::new();
        for provider in &snapshot.providers {
            let (sidebar, unassigned, descendants) = if provider.registration.unavailable.is_none()
            {
                let library = self.provider(device, &provider.registration.library)?;
                let (sidebar, descendants) =
                    directory_sidebar(&snapshot, provider, &library, safe)?;
                if library.provider_revision()? != (provider.list, provider.revision) {
                    return Err(Error::CursorExpired.into());
                }
                let unassigned = provider
                    .images
                    .iter()
                    .filter(|i| {
                        !i.deleted
                            && i.folders.is_empty()
                            && (!safe || !snapshot.adult.contains(&i.sha256))
                    })
                    .count() as u32;
                (Some(sidebar), unassigned, descendants)
            } else {
                (None, 0, BTreeMap::new())
            };
            providers.push(WorkspaceDirectory {
                registration: provider.registration.clone(),
                sidebar,
                unassigned,
                descendants,
            });
        }
        if self.snapshot(device, catalog)?.status.revision != snapshot.status.revision {
            return Err(Error::CursorExpired.into());
        }
        Ok(WorkspaceDirectories {
            status: snapshot.status(safe),
            providers,
            registration_order: device.libraries().iter().map(|r| r.id.clone()).collect(),
        })
    }
    /// Compatibility projection of one provider; forest reads use `directories`.
    pub fn sidebar(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        library_id: &str,
        safe: bool,
    ) -> Result<crate::library::Sidebar, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        let provider = snapshot
            .providers
            .iter()
            .find(|p| p.registration.library.id == library_id)
            .ok_or(CatalogError::UnknownMapping)?;
        // 与 `directories` 一样经长期打开的只读句柄读（#337）：不再每次重新打开资料库。
        let library = self.provider(device, &provider.registration.library)?;
        Ok(directory_sidebar(&snapshot, provider, &library, safe)?.0)
    }
}
fn directory_sidebar(
    snapshot: &Snapshot,
    provider: &Provider,
    library: &crate::Library,
    safe: bool,
) -> Result<(crate::library::Sidebar, BTreeMap<String, u32>), CatalogError> {
    // Folder structure is independent of local safety; every count is replaced from the global snapshot.
    let mut sidebar = library.sidebar()?;
    let visible = provider
        .images
        .iter()
        .filter(|i| !safe || !snapshot.adult.contains(&i.sha256))
        .collect::<Vec<_>>();
    sidebar.all = visible.iter().filter(|i| !i.deleted).count() as u32;
    sidebar.trash = visible.iter().filter(|i| i.deleted).count() as u32;
    let mut direct: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for image in visible.iter().filter(|i| !i.deleted) {
        for folder in &image.folders {
            direct.entry(folder).or_default().insert(&image.id);
        }
    }
    fn folders<'a>(
        nodes: &mut [crate::library::FolderNode],
        direct: &BTreeMap<&str, BTreeSet<&'a str>>,
        counts: &mut BTreeMap<String, u32>,
    ) -> BTreeSet<&'a str> {
        let mut all = BTreeSet::new();
        for node in nodes {
            let mut images = direct.get(node.id.as_str()).cloned().unwrap_or_default();
            node.count = images.len() as u32;
            images.extend(folders(&mut node.children, direct, counts));
            counts.insert(node.id.clone(), images.len() as u32);
            all.extend(images);
        }
        all
    }
    let mut descendants = BTreeMap::new();
    folders(&mut sidebar.folders, &direct, &mut descendants);
    Ok((sidebar, descendants))
}
