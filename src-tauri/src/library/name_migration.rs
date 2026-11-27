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
) -> Result<LegacyNameMigrationWorkspace, CommandError> {
    verbs::current_lens(
        app,
        |_| safe_mode_changed(),
        |w, d, c, safe| view(w, c, d, safe),
    )
    .await
}

#[tauri::command]
pub(super) async fn confirm_legacy_names<R: Runtime>(
    app: AppHandle<R>,
    revision: i64,
    decisions: Vec<LegacyNameDecision>,
) -> Result<LegacyNameMigrationWorkspace, CommandError> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        let grant = state.session.grant();
        let result = state.session.with_current_lens(
            |_| safe_mode_changed(),
            |workspace, libraries, catalog, safe| {
                let current = view(workspace, catalog, libraries, safe)?;
                if current.plan.revision != revision {
                    return Err(CatalogError::StaleNameMigration);
                }
                catalog.confirm_name_migration(&current.plan, &decisions)?;
                view(workspace, catalog, libraries, safe)
            },
        )?;
        names::refresh_labels(&app, &state)?;
        if !state.session.is_grant_current(&grant) {
            return Err(safe_mode_changed());
        }
        Ok(result)
    })
    .await
}

#[tauri::command]
pub(super) async fn preview_legacy_names<R: Runtime>(
    app: AppHandle<R>,
    revision: i64,
    decisions: Vec<LegacyNameDecision>,
) -> Result<LegacyNameMigrationPreview, CommandError> {
    verbs::current_lens(
        app,
        |_| safe_mode_changed(),
        move |w, d, c, safe| {
            let current = view(w, c, d, safe)?;
            if current.plan.revision != revision {
                return Err(CatalogError::StaleNameMigration);
            }
            c.preview_name_migration(&current.plan, &decisions)
        },
    )
    .await
}
