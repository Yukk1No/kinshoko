//! The selected aggregate source is a complete identity, independent of active browsing.

use super::*;
use kinshoko_core::CommandError;
use kinshoko_core::workspace::{
    Workspace, WorkspaceSourceInspection, WorkspaceSourceTarget, group_sources,
};

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
        return Err(kinshoko_core::library::Error::LensChanged
            .to_string()
            .into());
    }
    let value = workspace::with_resources(&state, f)?;
    if !state.safe_mode.still(&expected) || saved_safe_mode(app) != safe {
        return Err(kinshoko_core::library::Error::LensChanged
            .to_string()
            .into());
    }
    Ok(value)
}

#[tauri::command]
pub(super) async fn workspace_source_inspection<R: Runtime>(
    app: AppHandle<R>,
    target: WorkspaceSourceTarget,
    safe_mode: bool,
    lang: String,
) -> Result<WorkspaceSourceInspection, CommandError> {
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
) -> Result<Vec<Candidate>, CommandError> {
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
) -> Result<(), CommandError> {
    blocking(move || {
        // 与其他整理命令同一条路（ADR-0008）：按需切换唯一的可写句柄、等导入收尾。
        let writer = writable(&app, &target.library_id)?;
        action(&app, &target, safe_mode, |w, d, c, t| {
            w.write_source_with(d, c, t, safe_mode, &writer, |library| {
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
pub(super) async fn workspace_edit_source_tags<R: Runtime>(
    app: AppHandle<R>,
    target: WorkspaceSourceTarget,
    safe_mode: bool,
    edits: Vec<TagEdit>,
) -> Result<(), CommandError> {
    blocking(move || {
        let writer = writable(&app, &target.library_id)?;
        action(&app, &target, safe_mode, |w, d, c, t| {
            w.write_source_with(d, c, t, safe_mode, &writer, |library| {
                library.use_translations_for_new_tags(bundled_translations());
                library.edit_tags(std::slice::from_ref(&t.image_id), &edits)
            })
        })?;
        app.state::<LibraryState>().search.invalidate();
        publish_definition_dependencies(&app, &target.library_id).map_err(|error| CommandError::message(format!("这个来源的标签整理已保存，但资料库定义尚未更新：{error}。请在统一标签目录中重试保存标签定义。")))?;
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
        .ok_or("参考组还没有准备好")?
        .map_err(CommandError::from)?;
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
) -> Result<PermanentDeletePreview, CommandError> {
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
) -> Result<(), CommandError> {
    blocking(move || {
        let writer = writable(&app, &target.library_id)?;
        action(&app, &target, safe_mode, |w, d, c, t| {
            w.write_source_with(d, c, t, safe_mode, &writer, |library| {
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
