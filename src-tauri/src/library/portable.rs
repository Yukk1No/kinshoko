//! Explicit writable publication; registered provider reads remain read-only.
use super::*;

/// Reuse T09's registered, identity-checked writable pool without activating the provider.
/// Do not call while already holding LibraryState.transition.
pub fn publish_definition_dependencies<R: Runtime>(
    app: &AppHandle<R>,
    library_id: &str,
) -> Result<(), String> {
    let state = app.state::<LibraryState>();
    let _transition = lock(&state.transition);
    let library = with_libraries(&state.device_dir, &state.libraries, |libraries| {
        libraries.write(library_id)
    })?;
    state.install_translations(&library);
    library.set_safe_mode(saved_safe_mode(app));
    with_catalog(&state.device_dir, &state.catalog, |catalog| {
        catalog.publish_library_definitions(&library)
    })
}

#[tauri::command]
pub(super) async fn publish_tag_definitions<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
) -> Result<TagCatalogWorkspace, String> {
    let generation = state.safe_mode_generation.load(Ordering::SeqCst);
    let safe = saved_safe_mode(&app);
    let worker = app.clone();
    let result = blocking(move || {
        publish_definition_dependencies(&worker, &library_id).map_err(|error| format!(
            "标签定义未保存到资料库：{error}。程序中的对应和名称选择已保留；资料库可写后，请重试保存标签定义。"
        ))?;
        let state = worker.state::<LibraryState>();
        with_libraries(&state.device_dir, &state.libraries, |libraries| {
            Ok(with_catalog(&state.device_dir, &state.catalog, |catalog| {
                catalog.inspect_libraries(libraries, safe)
            }))
        })?
    }).await?;
    if state.safe_mode_generation.load(Ordering::SeqCst) != generation
        || saved_safe_mode(&app) != safe
    {
        return Err("安全模式已变化，请重新检查标签对应".into());
    }
    Ok(result)
}

/// Package export uses current app definitions without asking source providers to become writable.
pub fn export_package<R: Runtime>(
    app: &AppHandle<R>,
    groups: &kinshoko_core::reference_groups::ReferenceGroups,
    group_id: &str,
    path: &Path,
) -> Result<(), String> {
    let state = app.state::<LibraryState>();
    with_catalog(&state.device_dir, &state.catalog, |catalog| {
        Ok(with_references(app, |references| {
            groups.export_package_with_catalog(group_id, references, path, catalog)
        }))
    })?
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn import_package<R: Runtime>(
    app: &AppHandle<R>,
    groups: &kinshoko_core::reference_groups::ReferenceGroups,
    path: &Path,
    library: &Library,
) -> Result<kinshoko_core::reference_groups::ReferenceGroup, String> {
    let state = app.state::<LibraryState>();
    with_catalog(&state.device_dir, &state.catalog, |catalog| {
        Ok(groups.import_package_with_catalog(path, library, catalog))
    })?
    .map_err(|error| error.to_string())
}
