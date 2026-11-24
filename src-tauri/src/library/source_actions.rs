//! The selected aggregate source is a complete identity, independent of active browsing.

use super::*;
use kinshoko_core::CommandError;
use kinshoko_core::workspace::{WorkspaceSourceTarget, group_sources};

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
            with_lens(&app, safe_mode, Hold::Commit, |w, d, c| {
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

/// 图库墙“加入参考组”：把这张图加进参考组 `group_id`。那个参考组正摆在桌面上时钉到桌面上。
#[tauri::command]
pub(super) async fn workspace_source_group<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::Window<R>,
    target: WorkspaceSourceTarget,
    safe_mode: bool,
    group_id: String,
    shown: Option<kinshoko_core::desktop::ScreenRect>,
) -> Result<kinshoko_core::reference_groups::ReferenceGroup, CommandError> {
    // 摆在桌面上的那个参考组：图钉在右键处（`shown`，相对窗口客户区的物理像素），与“钉住”相同。
    let centre = shown.and_then(|s| {
        let origin = window.inner_position().ok()?;
        Some((
            origin.x + s.x + (s.width / 2) as i32,
            origin.y + s.y + (s.height / 2) as i32,
        ))
    });
    blocking(move || {
        let pin = with_lens(&app, safe_mode, Hold::Commit, |w, d, c| {
            w.source_reference(d, c, &target, safe_mode)
        })?;
        crate::desktop::add_to_reference_group(&app, &group_id, pin, centre)
            .ok_or_else(groups_not_ready)?
    })
    .await
}
