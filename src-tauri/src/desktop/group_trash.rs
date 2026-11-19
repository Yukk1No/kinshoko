//! 删除参考组可撤销（#480）的命令。都经桌面上的参考组（#588）：删的正是桌面上那个时桌面换走。

use kinshoko_core::CommandError;
use kinshoko_core::reference_groups::DeletedGroup;
use tauri::AppHandle;

use super::desk_commands::{apply, with_desk};
use super::groups::blocking;
use super::{lock, state};

/// 删除参考组（#480，可撤销）：参考组和它自带的截图暂放在回收位置，返回的内容交给
/// [`restore_reference_group`] 撤销，提示过期后调用 [`purge_deleted_reference_group`] 真正删除；程序启动时
/// 清掉没来得及删的。引用的图与资料库不受影响。删的是桌面上那个时，桌面换到最近用过的另一个。
#[tauri::command]
pub async fn delete_reference_group(
    app: AppHandle,
    group_id: String,
) -> Result<DeletedGroup, CommandError> {
    blocking(move || {
        let name = lock(&state(&app).groups)
            .get(&group_id)
            .map(|g| g.name)
            .unwrap_or_default();
        let switched = with_desk(&app, |desk, history| desk.discard(&group_id, history))?;
        apply(&app, switched);
        Ok(DeletedGroup { group_id, name })
    })
    .await
}

/// 撤销 [`delete_reference_group`]：参考组放回原处；删除时摆在桌面上的，放回桌面。
#[tauri::command]
pub async fn restore_reference_group(
    app: AppHandle,
    deleted: DeletedGroup,
) -> Result<(), CommandError> {
    blocking(move || {
        let (report, switched) = with_desk(&app, |desk, history| {
            desk.undo_discard(&deleted.group_id, history)
        })?;
        for failed in &report.failed {
            crate::run_log::warn("撤销删除后参考组成员未改连", &failed.reason);
        }
        apply(&app, switched);
        Ok(())
    })
    .await
}

/// 撤销提示过期：真正删除暂放的参考组。
#[tauri::command]
pub async fn purge_deleted_reference_group(
    app: AppHandle,
    group_id: String,
) -> Result<(), CommandError> {
    blocking(move || with_desk(&app, |desk, _| desk.purge(&group_id))).await
}
