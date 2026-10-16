//! Safe-mode-filtered adapter for the core's all-or-nothing legacy name ownership action.
use super::*;
use kinshoko_core::tag_catalog::{
    LegacyNameDecision, LegacyNameMigrationPreview, LegacyNameMigrationWorkspace,
};

fn view(
    catalog: &mut TagCatalog,
    libraries: &DeviceLibraries,
    safe: bool,
) -> Result<LegacyNameMigrationWorkspace, CatalogError> {
    let visible = catalog.inspect_libraries(libraries, safe)?;
    Ok(LegacyNameMigrationWorkspace {
        plan: catalog.plan_name_migration(&visible.catalog)?,
        libraries: visible.libraries,
    })
}

#[tauri::command]
pub(super) async fn plan_legacy_names<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
) -> Result<LegacyNameMigrationWorkspace, String> {
    let (dir, libraries, catalog) = (
        state.device_dir.clone(),
        state.libraries.clone(),
        state.catalog.clone(),
    );
    let generation = state.safe_mode_generation.load(Ordering::SeqCst);
    let safe = saved_safe_mode(&app);
    let result = blocking(move || {
        with_libraries(&dir, &libraries, |libraries| {
            Ok(with_catalog(&dir, &catalog, |catalog| {
                view(catalog, libraries, safe)
            }))
        })?
    })
    .await?;
    if state.safe_mode_generation.load(Ordering::SeqCst) != generation
        || saved_safe_mode(&app) != safe
    {
        return Err("安全模式已变化，请重新打开名称迁移向导".into());
    }
    Ok(result)
}

#[tauri::command]
pub(super) async fn confirm_legacy_names<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    revision: i64,
    decisions: Vec<LegacyNameDecision>,
) -> Result<LegacyNameMigrationWorkspace, String> {
    let (dir, libraries, catalog) = (
        state.device_dir.clone(),
        state.libraries.clone(),
        state.catalog.clone(),
    );
    let generation = state.safe_mode_generation.load(Ordering::SeqCst);
    let safe = saved_safe_mode(&app);
    let result = blocking(move || {
        with_libraries(&dir, &libraries, |libraries| {
            Ok(with_catalog(&dir, &catalog, |catalog| {
                let current = view(catalog, libraries, safe)?;
                if current.plan.revision != revision {
                    return Err(CatalogError::StaleNameMigration);
                }
                catalog.confirm_name_migration(&current.plan, &decisions)?;
                view(catalog, libraries, safe)
            }))
        })?
    })
    .await?;
    names::refresh_labels(&app, &state)?;
    if state.safe_mode_generation.load(Ordering::SeqCst) != generation
        || saved_safe_mode(&app) != safe
    {
        return Err("安全模式已变化，请重新打开名称迁移向导".into());
    }
    Ok(result)
}

#[tauri::command]
pub(super) async fn preview_legacy_names<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    revision: i64,
    decisions: Vec<LegacyNameDecision>,
) -> Result<LegacyNameMigrationPreview, String> {
    let (dir, libraries, catalog) = (
        state.device_dir.clone(),
        state.libraries.clone(),
        state.catalog.clone(),
    );
    let generation = state.safe_mode_generation.load(Ordering::SeqCst);
    let safe = saved_safe_mode(&app);
    let result = blocking(move || {
        with_libraries(&dir, &libraries, |libraries| {
            Ok(with_catalog(&dir, &catalog, |catalog| {
                let current = view(catalog, libraries, safe)?;
                if current.plan.revision != revision {
                    return Err(CatalogError::StaleNameMigration);
                }
                catalog.preview_name_migration(&current.plan, &decisions)
            }))
        })?
    })
    .await?;
    if state.safe_mode_generation.load(Ordering::SeqCst) != generation
        || saved_safe_mode(&app) != safe
    {
        return Err("安全模式已变化，请重新打开名称迁移向导".into());
    }
    Ok(result)
}
