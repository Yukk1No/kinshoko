//! Safe-mode-filtered adapter for the core's all-or-nothing legacy name ownership action.

use super::*;
use kinshoko_core::CommandError;
use kinshoko_core::tag_catalog::{
    LegacyNameDecision, LegacyNameMigrationPreview, LegacyNameMigrationWorkspace,
};

/// 经共享的工作区读可见目录（#337）：复用它的快照，不再每次从头装配各提供方、长时间占着锁。
fn safe_mode_changed() -> CommandError {
    CommandError::new(
        ErrorKind::NameMigrationSafeModeChanged,
        "安全模式已变化，请重新打开名称迁移向导",
    )
}

fn view(
    workspace: &mut kinshoko_core::workspace::Workspace,
    catalog: &mut TagCatalog,
    libraries: &DeviceLibraries,
    safe: bool,
) -> Result<LegacyNameMigrationWorkspace, CatalogError> {
    let visible = workspace.inspect_catalog(libraries, catalog, safe)?;
    Ok(LegacyNameMigrationWorkspace {
        plan: catalog.plan_name_migration(&visible.catalog)?,
        libraries: visible.libraries,
    })
}

#[tauri::command]
pub(super) async fn plan_legacy_names<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
) -> Result<LegacyNameMigrationWorkspace, CommandError> {
    let reader = app.clone();
    let lens = state.safe_mode.lens();
    let result = blocking(move || {
        workspace::with_resources(
            &reader.state::<LibraryState>(),
            |workspace, libraries, catalog| view(workspace, catalog, libraries, lens.on()),
        )
    })
    .await?;
    lens.confirm(&state.safe_mode)
        .map_err(|_| safe_mode_changed())?;
    Ok(result)
}

#[tauri::command]
pub(super) async fn confirm_legacy_names<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    revision: i64,
    decisions: Vec<LegacyNameDecision>,
) -> Result<LegacyNameMigrationWorkspace, CommandError> {
    let reader = app.clone();
    let lens = state.safe_mode.lens();
    let result = blocking(move || {
        workspace::with_resources(
            &reader.state::<LibraryState>(),
            |workspace, libraries, catalog| {
                let current = view(workspace, catalog, libraries, lens.on())?;
                if current.plan.revision != revision {
                    return Err(CatalogError::StaleNameMigration);
                }
                catalog.confirm_name_migration(&current.plan, &decisions)?;
                view(workspace, catalog, libraries, lens.on())
            },
        )
    })
    .await?;
    names::refresh_labels(&app, &state)?;
    lens.confirm(&state.safe_mode)
        .map_err(|_| safe_mode_changed())?;
    Ok(result)
}

#[tauri::command]
pub(super) async fn preview_legacy_names<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    revision: i64,
    decisions: Vec<LegacyNameDecision>,
) -> Result<LegacyNameMigrationPreview, CommandError> {
    let reader = app.clone();
    let lens = state.safe_mode.lens();
    let result = blocking(move || {
        workspace::with_resources(
            &reader.state::<LibraryState>(),
            |workspace, libraries, catalog| {
                let current = view(workspace, catalog, libraries, lens.on())?;
                if current.plan.revision != revision {
                    return Err(CatalogError::StaleNameMigration);
                }
                catalog.preview_name_migration(&current.plan, &decisions)
            },
        )
    })
    .await?;
    lens.confirm(&state.safe_mode)
        .map_err(|_| safe_mode_changed())?;
    Ok(result)
}
