//! The selected aggregate source is a complete identity, independent of active browsing.

use super::*;
use kinshoko_core::CommandError;
use kinshoko_core::workspace::{Workspace, WorkspaceSourceTarget, group_sources};

pub(super) fn action<R: Runtime, T>(
    app: &AppHandle<R>,
    target: &WorkspaceSourceTarget,
    safe: bool,
    f: impl FnOnce(
        &mut Workspace,
        &mut DeviceLibraries,
        &mut TagCatalog,
        &WorkspaceSourceTarget,
    ) -> Result<T, CatalogError>,
) -> Result<T, CommandError> {
    guarded(app, safe, |w, d, c| f(w, d, c, target))
}

/// 来源动作共用的锁与安全模式复核；所选来源由 `f` 自己核对。
fn guarded<R: Runtime, T>(
    app: &AppHandle<R>,
    safe: bool,
    f: impl FnOnce(&mut Workspace, &mut DeviceLibraries, &mut TagCatalog) -> Result<T, CatalogError>,
) -> Result<T, CommandError> {
    let state = app.state::<LibraryState>();
    let _transition = lock(&state.transition);
    // Includes the production SourceEditor rating path and permanent source deletion.
    let _visibility = lock(&state.visibility_commit);
    let expected = state.safe_mode.snapshot();
    if saved_safe_mode(app) != safe {
        return Err(kinshoko_core::library::Error::LensChanged.into());
    }
    let value = workspace::with_resources(&state, f)?;
    if !state.safe_mode.still(&expected) || saved_safe_mode(app) != safe {
        return Err(kinshoko_core::library::Error::LensChanged.into());
    }
    Ok(value)
}

/// 跨图库的多份来源一次整理（#290）：按图库分组，每个图库只切一次可写句柄、调一次整理；
/// 一个图库失败不影响其他图库。返回没有完成的图库与原因，全部完成时为空。
#[tauri::command]
pub(super) async fn workspace_edit_sources<R: Runtime>(
    app: AppHandle<R>,
    targets: Vec<WorkspaceSourceTarget>,
    safe_mode: bool,
    edits: Vec<ImageEdit>,
) -> Result<Vec<LibraryBatchFailure>, CommandError> {
    blocking(move || {
        let results = each_library(group_sources(&targets), |batch| {
            let writer = writable(&app, &batch.library_id)?;
            guarded(&app, safe_mode, |w, d, c| {
                w.write_sources_with(d, c, &batch.targets, safe_mode, &writer, |library, ids| {
                    library.edit(ids, &edits).map(|_| ())
                })
            })
        });
        if results.iter().any(|(_, result)| result.is_ok()) {
            app.state::<LibraryState>().search.invalidate();
        }
        Ok(results
            .into_iter()
            .filter_map(|(batch, result)| {
                result.err().map(|error| LibraryBatchFailure {
                    library_id: batch.library_id,
                    error,
                })
            })
            .collect())
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
) -> Result<kinshoko_core::reference_groups::ReferenceGroup, CommandError> {
    blocking(move || {
        let mut pin = action(&app, &target, safe_mode, |w, d, c, t| {
            w.source_reference(d, c, t, safe_mode)
        })?;
        let group = crate::desktop::with_groups(&app, |groups| match (group_id, name) {
            (Some(id), None) => groups.save_pins(&id, std::slice::from_mut(&mut pin)),
            (None, Some(name)) => groups.create(&name, std::slice::from_mut(&mut pin)),
            _ => Err(kinshoko_core::reference_groups::GroupError::InvalidName),
        })
        .ok_or_else(groups_not_ready)?
        .map_err(CommandError::from)?;
        crate::desktop::reference_groups_changed(&app);
        Ok(group)
    })
    .await
}
