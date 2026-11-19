//! 参考组（#66）的命令：列表、成员此刻能否显示、重命名、移出成员；参考组包（#68）的导出与导入。
//! 桌面上至多摆着一个参考组（#588），切换、新建、钉回、常用、加进上一组、移到新参考组见
//! [`super::desk_commands`]。
//! 规则与存储在 `kinshoko_core::reference_groups`；参考组是应用数据目录 `reference-groups/` 下
//! 独立于资料库的 JSON（ADR-0002）。
//!
//! 截图钉图是参考组自带的截图（#270）：截图文件复制进参考组，摆到桌面上时放回截图历史再钉出；
//! 收藏进资料库后改连收藏成的参考图（[`capture_collected`]）。
//!
//! 成员按“资料库＋参考图”引用，可跨资料库：活动资料库经参考视角，其他已登记的资料库只读打开
//! （[`crate::library::with_references`]）。资料库不可用、图已删除的成员照样按原布局钉出来，钉图上
//! 写出原因；安全模式下被封印的成员原位遮蔽，画师在钉图菜单里逐张确认显示。
//!
//! 参考组变化后向所有窗口推送 `reference-groups`（无载荷），主窗口据此重新读取列表。

use kinshoko_core::CommandError;
use kinshoko_core::desktop::CollectedCapture;

use kinshoko_core::reference_groups::{GroupSummary, ReferenceGroup, ReferenceGroupView};
use tauri::{AppHandle, Emitter};

use super::{lock, pins, state};

mod package;
pub use package::*;

pub(super) const CHANGED_EVENT: &str = "reference-groups";

pub(super) fn changed(app: &AppHandle) {
    let _ = app.emit(CHANGED_EVENT, ());
}

pub(super) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(CommandError::system)?
}

/// 截图收藏进了资料库（钉图菜单或截图历史的“收藏”）：截图历史记得由它而来的组内截图成员，
/// 都改为引用收藏成的参考图（局部与摆放不变，组内那份截图删除）；桌面上来自这些成员的截图钉图
/// 也改连，不论它显示的是哪条截图历史条目。
/// 钉图早已关掉、截图在几个参考组里都一样。只转换这次改连成功的成员的钉图；没改连的写进运行日志。
pub fn capture_collected(app: &AppHandle, capture_id: &str, collected: &CollectedCapture) {
    let done = super::desk_commands::with_desk(app, |desk, history| {
        desk.collected(history, capture_id, collected)
    });
    let done = match done {
        Ok(done) => done,
        Err(e) => {
            crate::run_log::warn("桌面上的参考组未改连到收藏的参考图", e);
            return;
        }
    };
    for failed in &done.report.failed {
        crate::run_log::warn(
            "参考组成员未改连到收藏的参考图",
            format!(
                "参考组 {} 成员 {}：{}",
                failed.member.group_id, failed.member.member_id, failed.reason
            ),
        );
    }
    let converted: Vec<String> = done.converted.iter().map(|p| p.id.clone()).collect();
    pins::converted_to_references(app, &converted);
    changed(app);
}

/// 本设备的参考组，最近保存的在前；读不懂的文件也列出并说明原因。
#[tauri::command]
pub async fn reference_groups(app: AppHandle) -> Result<Vec<GroupSummary>, CommandError> {
    blocking(move || lock(&state(&app).groups).list().map_err(CommandError::from)).await
}

/// 一个参考组及每个成员此刻能否显示（不可用时的原因、安全模式下是否遮蔽）。
#[tauri::command]
pub async fn reference_group(
    app: AppHandle,
    group_id: String,
) -> Result<ReferenceGroupView, CommandError> {
    blocking(move || {
        let groups = lock(&state(&app).groups).clone();
        // 桌面上那组以内存为准：钉住、关掉之后侧栏马上重读，这时可能还没落盘。
        let on_desk = lock(&state(&app).store)
            .desk()
            .group()
            .filter(|g| g.id == group_id)
            .cloned();
        let group = match on_desk {
            Some(group) => group,
            None => groups.get(&group_id).map_err(CommandError::from)?,
        };
        Ok(crate::library::with_references(&app, |refs| {
            groups.view(group, refs)
        }))
    })
    .await
}

#[tauri::command]
pub async fn rename_reference_group(
    app: AppHandle,
    group_id: String,
    name: String,
) -> Result<ReferenceGroup, CommandError> {
    blocking(move || {
        // 桌面上的参考组以内存里的为准，经桌面模块改名。名称可以为空：回到写日期（#588）。
        let group = super::desk_commands::with_desk(&app, |desk, _| desk.rename(&group_id, &name))?;
        changed(&app);
        Ok(group)
    })
    .await
}

/// 从参考组中去掉一个成员。开关关着时桌面上的钉图留着；打开时是桌面上那组的，钉着它的钉图一起关掉，
/// 能用 `undo_prune_unpinned` 撤销。参考组自带的截图没有成员再用时删除。
#[tauri::command]
pub async fn remove_group_member(
    app: AppHandle,
    group_id: String,
    member_id: String,
) -> Result<Option<ReferenceGroup>, CommandError> {
    blocking(move || {
        // 桌面上那个参考组的成员由桌面模块移出，钉着它的钉图一起关掉。
        // 空的且没有名称的参考组随之消失，这时返回 `None`。
        if super::desk_commands::remove_desk_member(&app, &member_id)? {
            return Ok(lock(&state(&app).groups).get(&group_id).ok());
        }
        let group = lock(&state(&app).groups)
            .remove_member(&group_id, &member_id)
            .map_err(CommandError::from)?;
        changed(&app);
        Ok(Some(group))
    })
    .await
}
