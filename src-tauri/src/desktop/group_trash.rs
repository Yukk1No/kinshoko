//! 删除参考组可撤销（#480）的命令。

use kinshoko_core::CommandError;
use kinshoko_core::desktop::GroupMemberRef;
use kinshoko_core::reference_groups::{DeletedGroup, UnlinkedPin};
use tauri::AppHandle;

use super::groups::{blocking, changed};
use super::{lock, state};

/// 删除参考组（#480，可撤销）：参考组和它自带的截图暂放在回收位置，返回的内容交给
/// [`restore_reference_group`] 撤销，提示过期后调用 [`purge_deleted_reference_group`] 真正删除；程序启动时
/// 清掉没来得及删的。引用的图与资料库不受影响；桌面上来自它的钉图留着，只是暂时不记得这个参考组
/// （自带截图的钉图仍显示截图历史里的那份）。
#[tauri::command]
pub async fn delete_reference_group(
    app: AppHandle,
    group_id: String,
) -> Result<DeletedGroup, CommandError> {
    blocking(move || {
        let groups = lock(&state(&app).groups);
        let name = groups.get(&group_id).map(|g| g.name).unwrap_or_default();
        groups.trash(&group_id).map_err(CommandError::from)?;
        drop(groups);
        let mut unlinked_pins = Vec::new();
        {
            let mut store = lock(&state(&app).store);
            let linked: Vec<(String, String)> = store
                .pins()
                .iter()
                .filter_map(|p| {
                    p.member
                        .as_ref()
                        .filter(|m| m.group_id == group_id)
                        .map(|m| (p.id.clone(), m.member_id.clone()))
                })
                .collect();
            for (pin_id, member_id) in linked {
                store.edit(&pin_id, |p| p.member = None);
                unlinked_pins.push(UnlinkedPin { pin_id, member_id });
            }
            let _ = store.save();
        }
        changed(&app);
        Ok(DeletedGroup {
            group_id,
            name,
            unlinked_pins,
        })
    })
    .await
}

/// 撤销 [`delete_reference_group`]：参考组放回原处，桌面上还在的钉图重新记起自己是哪个成员。
#[tauri::command]
pub async fn restore_reference_group(
    app: AppHandle,
    deleted: DeletedGroup,
) -> Result<(), CommandError> {
    blocking(move || {
        lock(&state(&app).groups)
            .untrash(&deleted.group_id)
            .map_err(CommandError::from)?;
        {
            let mut store = lock(&state(&app).store);
            for UnlinkedPin { pin_id, member_id } in deleted.unlinked_pins {
                let free = store
                    .pins()
                    .iter()
                    .any(|p| p.id == pin_id && p.member.is_none());
                if free {
                    let group_id = deleted.group_id.clone();
                    store.edit(&pin_id, |p| {
                        p.member = Some(GroupMemberRef {
                            group_id,
                            member_id,
                        })
                    });
                }
            }
            let _ = store.save();
        }
        changed(&app);
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
    blocking(move || {
        lock(&state(&app).groups)
            .purge(&group_id)
            .map_err(CommandError::from)
    })
    .await
}
