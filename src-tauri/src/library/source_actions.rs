//! The selected aggregate source is a complete identity, independent of active browsing.
use super::*;
use kinshoko_core::workspace::{Workspace, WorkspaceSourceInspection, WorkspaceSourceTarget};

fn action<R: Runtime, T>(
    app: &AppHandle<R>,
    target: &WorkspaceSourceTarget,
    safe: bool,
    f: impl FnOnce(
        &mut Workspace,
        &mut DeviceLibraries,
        &mut TagCatalog,
        &WorkspaceSourceTarget,
    ) -> Result<T, CatalogError>,
) -> Result<T, String> {
    let state = app.state::<LibraryState>();
    let _transition = lock(&state.transition);
    let expected = state.safe_mode_generation.load(Ordering::SeqCst);
    if saved_safe_mode(app) != safe {
        return Err(kinshoko_core::library::Error::LensChanged.to_string());
    }
    let value = with_libraries(&state.device_dir, &state.libraries, |device| {
        Ok(with_catalog(&state.device_dir, &state.catalog, |catalog| {
            let mut slot = lock(&state.workspace);
            if slot.is_none() {
                *slot = Some(Workspace::open(&state.device_dir)?);
            }
            f(
                slot.as_mut().expect("workspace opened"),
                device,
                catalog,
                target,
            )
        }))
    })??;
    if state.safe_mode_generation.load(Ordering::SeqCst) != expected || saved_safe_mode(app) != safe
    {
        return Err(kinshoko_core::library::Error::LensChanged.to_string());
    }
    Ok(value)
}

#[tauri::command]
pub(super) async fn workspace_source_inspection<R: Runtime>(
    app: AppHandle<R>,
    target: WorkspaceSourceTarget,
    safe_mode: bool,
    lang: String,
) -> Result<WorkspaceSourceInspection, String> {
    blocking(move || {
        action(&app, &target, safe_mode, |w, d, c, t| {
            w.inspect_source(d, c, t, safe_mode, &lang)
        })
    })
    .await
}

#[tauri::command]
pub(super) async fn workspace_source_candidates<R: Runtime>(
    app: AppHandle<R>,
    target: WorkspaceSourceTarget,
    safe_mode: bool,
    text: String,
    lang: String,
) -> Result<Vec<Candidate>, String> {
    blocking(move || {
        action(&app, &target, safe_mode, |w, d, c, t| {
            w.source_candidates(d, c, t, safe_mode, &text, &lang)
        })
    })
    .await
}

#[tauri::command]
pub(super) async fn workspace_edit_source<R: Runtime>(
    app: AppHandle<R>,
    target: WorkspaceSourceTarget,
    safe_mode: bool,
    edits: Vec<ImageEdit>,
) -> Result<(), String> {
    blocking(move || {
        action(&app, &target, safe_mode, |w, d, c, t| {
            w.write_source(d, c, t, safe_mode, |library| {
                library
                    .edit(std::slice::from_ref(&t.image_id), &edits)
                    .map(|_| ())
            })
        })?;
        app.state::<LibraryState>().search.invalidate();
        Ok(())
    })
    .await
}

#[tauri::command]
pub(super) async fn workspace_edit_source_tags<R: Runtime>(
    app: AppHandle<R>,
    target: WorkspaceSourceTarget,
    safe_mode: bool,
    edits: Vec<TagEdit>,
) -> Result<(), String> {
    blocking(move || {
        action(&app, &target, safe_mode, |w, d, c, t| {
            w.write_source(d, c, t, safe_mode, |library| {
                library.use_translations_for_new_tags(bundled_translations());
                library.edit_tags(std::slice::from_ref(&t.image_id), &edits)
            })
        })?;
        app.state::<LibraryState>().search.invalidate();
        Ok(())
    })
    .await
}

#[tauri::command]
pub(super) async fn workspace_source_group<R: Runtime>(
    app: AppHandle<R>,
    target: WorkspaceSourceTarget,
    safe_mode: bool,
    group_id: Option<String>,
    name: Option<String>,
) -> Result<kinshoko_core::reference_groups::ReferenceGroup, String> {
    blocking(move || {
        let mut pin = action(&app, &target, safe_mode, |w, d, c, t| {
            w.source_reference(d, c, t, safe_mode)
        })?;
        let group = crate::desktop::with_groups(&app, |groups| match (group_id, name) {
            (Some(id), None) => groups.save_pins(&id, std::slice::from_mut(&mut pin)),
            (None, Some(name)) => groups.create(&name, std::slice::from_mut(&mut pin)),
            _ => Err(kinshoko_core::reference_groups::GroupError::InvalidName),
        })
        .ok_or("参考组还没有准备好")?
        .map_err(|e| e.to_string())?;
        crate::desktop::reference_groups_changed(&app);
        Ok(group)
    })
    .await
}

#[tauri::command]
pub(super) async fn workspace_preview_source_delete<R: Runtime>(
    app: AppHandle<R>,
    target: WorkspaceSourceTarget,
    safe_mode: bool,
) -> Result<PermanentDeletePreview, String> {
    blocking(move || {
        action(&app, &target, safe_mode, |w, d, c, t| {
            let library = w.read_source(d, c, t, safe_mode)?;
            crate::desktop::with_groups(&app, |groups| {
                library.preview_permanent_delete(std::slice::from_ref(&t.image_id), groups)
            })
            .ok_or_else(|| CatalogError::Io(std::io::Error::other("参考组还没有准备好")))?
            .map_err(CatalogError::Library)
        })
    })
    .await
}

#[tauri::command]
pub(super) async fn workspace_permanent_source_delete<R: Runtime>(
    app: AppHandle<R>,
    target: WorkspaceSourceTarget,
    safe_mode: bool,
    token: String,
) -> Result<(), String> {
    blocking(move || {
        action(&app, &target, safe_mode, |w, d, c, t| {
            w.write_source(d, c, t, safe_mode, |library| {
                crate::desktop::with_groups(&app, |groups| {
                    library.permanent_delete(std::slice::from_ref(&t.image_id), &token, groups)
                })
                .ok_or_else(|| {
                    kinshoko_core::library::Error::ReferenceGroups("参考组还没有准备好".into())
                })?
            })
        })?;
        crate::desktop::reference_groups_changed(&app);
        Ok(())
    })
    .await
}
