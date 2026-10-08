//! Thin adapter for application groups. No active library is required or mutated.
use super::*;
use kinshoko_core::tag_catalog::{CatalogGroupEdit, CatalogGroupView};

#[tauri::command]
pub(super) async fn shared_tag_groups<R: Runtime>(
    app: AppHandle<R>,
    lang: String,
    safe_mode: bool,
) -> Result<Vec<CatalogGroupView>, String> {
    blocking(move || {
        workspace::stable(&app, safe_mode, |workspace, device, catalog| {
            workspace.shared_tag_groups(device, catalog, &lang, safe_mode)
        })
    })
    .await
}

#[tauri::command]
pub(super) async fn create_shared_tag_group<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    namespace: Option<TagNamespace>,
) -> Result<String, String> {
    blocking(move || {
        let safe = saved_safe_mode(&app);
        workspace::action(&app, safe, |workspace, device, catalog| {
            // Existing source groups enroll before a new group is appended.
            workspace.status(device, catalog, safe)?;
            catalog.create_group(&name, namespace)
        })
    })
    .await
}

#[tauri::command]
pub(super) async fn edit_shared_tag_group<R: Runtime>(
    app: AppHandle<R>,
    edit: CatalogGroupEdit,
    safe_mode: bool,
) -> Result<(), String> {
    blocking(move || {
        let generation = workspace::generation(&app);
        workspace::current(&app, safe_mode, generation)?;
        workspace::action(&app, safe_mode, |workspace, device, catalog| {
            workspace.edit_group(device, catalog, &edit, safe_mode)
        })?;
        workspace::current(&app, safe_mode, generation)
    })
    .await
}
