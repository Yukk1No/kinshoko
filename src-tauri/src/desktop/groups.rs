//! 参考组（#66）的命令：把桌面上的资料库钉图存成参考组、存回、打开（成员钉到桌面）、重命名、删除；
//! 参考组包（#68）的导出与导入。
//! 规则与存储在 `kinshoko_core::reference_groups`；参考组是应用数据目录 `reference-groups/` 下
//! 独立于资料库的 JSON（ADR-0002）。
//!
//! 截图钉图可以收藏进资料库后入组，也可以只存在参考组里（#270）：截图文件复制进参考组，打开参考组时
//! 放回截图历史再钉出。
//!
//! 成员按“资料库＋参考图”引用，可跨资料库：活动资料库经参考视角，其他已登记的资料库只读打开
//! （[`crate::library::with_references`]）。资料库不可用、图已删除的成员照样按原布局钉出来，钉图上
//! 写出原因；安全模式下被封印的成员原位遮蔽，画师在钉图菜单里逐张确认显示。
//!
//! 参考组变化后向所有窗口推送 `reference-groups`（无载荷），主窗口据此重新读取列表。

use crate::ui_text::{Text, text};
use kinshoko_core::CommandError;
use kinshoko_core::command_error::ErrorKind;
use kinshoko_core::desktop::{
    CaptureChoice, CaptureEntry, CollectedCapture, PinContent, SavedPin, pull_onto_screen,
};
use std::path::PathBuf;

use kinshoko_core::reference_groups::{
    GroupCapture, GroupSummary, PACKAGE_EXTENSION, ReferenceGroup, ReferenceGroupView,
};
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt as _;

use super::{lock, pins, state};

pub(super) const CHANGED_EVENT: &str = "reference-groups";

/// 截图钉图对应的截图已不在截图历史中。
fn capture_left_history() -> CommandError {
    CommandError::new(
        ErrorKind::CaptureLeftHistory,
        "截图已不在历史中，请关闭这张钉图后重试",
    )
}

fn changed(app: &AppHandle) {
    let _ = app.emit(CHANGED_EVENT, ());
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(CommandError::system)?
}

/// 把存进参考组后钉图记下的成员写回钉图状态。
fn remember_members(app: &AppHandle, saved: &[SavedPin]) {
    pins::remember_group_members(app, saved);
}

/// 已是参考组 `target` 自带截图的截图钉图：存进它时原样更新那个成员，不用再选。
fn kept_in(target: Option<&ReferenceGroup>, pin: &SavedPin) -> bool {
    let (Some(group), Some(member)) = (target, &pin.member) else {
        return false;
    };
    pin.capture_id().is_some()
        && member.group_id == group.id
        && group
            .members
            .iter()
            .any(|m| m.id == member.member_id && m.library_id().is_none())
}

fn target_group(
    app: &AppHandle,
    group_id: Option<&str>,
) -> Result<Option<ReferenceGroup>, CommandError> {
    group_id
        .map(|id| lock(&state(app).groups).get(id).map_err(CommandError::from))
        .transpose()
}

/// 列出当前桌面上需决定怎样入组的截图（包括已手动收藏的）。存进已有的参考组 `group_id` 时，
/// 已是它自带截图的不列出。
#[tauri::command]
pub async fn group_save_captures(
    app: AppHandle,
    group_id: Option<String>,
) -> Result<Vec<CaptureEntry>, CommandError> {
    blocking(move || {
        let target = target_group(&app, group_id.as_deref())?;
        let open = pins::open_pins(&app);
        let history = lock(&state(&app).history);
        let mut captures = Vec::new();
        for id in open
            .iter()
            .filter(|p| !kept_in(target.as_ref(), p))
            .filter_map(SavedPin::capture_id)
        {
            if !captures.iter().any(|e: &CaptureEntry| e.id == id) {
                captures.push(history.entry(id).ok_or_else(capture_left_history)?);
            }
        }
        Ok(captures)
    })
    .await
}

/// 按逐张选择准备要存进参考组的钉图：收藏进资料库的截图钉图改连参考图；只存在参考组里的截图
/// 一并给出它在截图历史中的文件，由参考组复制；明确不加入的略过。
fn prepare_pins(
    app: &AppHandle,
    choices: &[CaptureChoice],
    target: Option<&ReferenceGroup>,
) -> Result<(Vec<SavedPin>, Vec<GroupCapture>), CommandError> {
    let open = pins::open_pins(app);
    // 先核对全部选择；预览后新出现的截图也必须明确处理。
    for id in open
        .iter()
        .filter(|p| !kept_in(target, p))
        .filter_map(SavedPin::capture_id)
    {
        if choices.iter().filter(|c| c.capture_id == id).count() != 1 {
            return Err(CommandError::new(
                ErrorKind::CaptureSavePlanChanged,
                "桌面截图有变化，请重新选择每张截图存到哪里",
            ));
        }
    }
    let mut prepared = Vec::new();
    let mut kept = Vec::new();
    let mut completed_captures = 0;
    for pin in open {
        let Some(id) = pin.capture_id() else {
            prepared.push(pin);
            continue;
        };
        if kept_in(target, &pin) {
            prepared.push(pin);
            continue;
        }
        let choice = choices
            .iter()
            .find(|c| c.capture_id == id)
            .expect("已核对选择");
        if choice.keeps_in_group() {
            if !kept.iter().any(|c: &GroupCapture| c.capture_id == id) {
                kept.push(
                    lock(&state(app).history)
                        .group_capture(id)
                        .ok_or_else(capture_left_history)?,
                );
            }
            prepared.push(pin);
            continue;
        }
        let Some(library_id) = &choice.library_id else {
            continue;
        };
        let destination = kinshoko_core::library::SaveDestination {
            library_id: library_id.clone(),
            folder_id: choice.folder_id.clone(),
        };
        let reference = crate::library::with_destination_published(app, &destination, |library| {
            let pending = lock(&state(app).history)
                .prepare_collect(id)
                .map_err(CommandError::from)?;
            let collected = pending.import(library).map_err(CommandError::from)?;
            lock(&state(app).history)
                .finish_collect_pin(&pin, collected)
                .map_err(CommandError::from)
        }).map_err(|error| {
            super::history_changed(app);
            let number = completed_captures + 1;
            CommandError::caused_by(
                error,
                |cause| ErrorKind::CaptureCollectIncomplete {
                    number,
                    completed: completed_captures,
                    cause,
                },
                |error| format!("第 {number} 张截图的收藏未完成：{error}。之前完成的 {completed_captures} 张收藏已保留；参考组尚未保存。"),
            )
        })?;
        completed_captures += 1;
        // 这张截图若已是别的参考组自带的截图，那些成员也改连收藏成的参考图。
        if let PinContent::Reference {
            library_id,
            image_id,
            ..
        } = &reference.content
        {
            let collected = CollectedCapture {
                library_id: library_id.clone(),
                image_id: image_id.clone(),
            };
            capture_collected(app, id, &collected);
        }
        prepared.push(reference);
    }
    super::history_changed(app);
    Ok((prepared, kept))
}

/// 截图收藏进了资料库（钉图菜单或截图历史的“收藏”）：截图历史记得由它而来的组内截图成员，
/// 都改为引用收藏成的参考图（局部与摆放不变，组内那份截图删除）；桌面上来自这些成员的截图钉图
/// 也改连，不论它显示的是哪条截图历史条目。
/// 钉图早已关掉、截图在几个参考组里都一样。只转换这次改连成功的成员的钉图；没改连的写进运行日志。
pub fn capture_collected(app: &AppHandle, capture_id: &str, collected: &CollectedCapture) {
    let Some(entry) = lock(&state(app).history).entry(capture_id) else {
        return;
    };
    let open = pins::open_pins(app);
    // 与其他写参考组的命令一样持着参考组锁改写，免得和“存回参考组”交错；先参考组、后截图历史。
    let report = {
        let groups = lock(&state(app).groups);
        let mut history = lock(&state(app).history);
        groups.link_captures(&mut history, &open);
        groups.relink_collected(&mut history, capture_id, collected)
    };
    // 没改连的成员仍是组内截图，参考组照常可用；关联留着，下次收藏这张截图时再试。
    for failed in &report.failed {
        crate::run_log::warn(
            "参考组成员未改连到收藏的参考图",
            format!(
                "参考组 {} 成员 {}：{}",
                failed.member.group_id, failed.member.member_id, failed.reason
            ),
        );
    }
    if let Some(error) = &report.unlink_error {
        crate::run_log::warn("截图历史未去掉已改连的关联", error);
    }
    let relinked = report.relinked;
    if relinked.is_empty() {
        return;
    }
    let converted: Vec<SavedPin> = open
        .into_iter()
        // 按成员认：重新打开参考组钉出的钉图显示的是另一条截图历史条目。
        .filter(|p| p.capture_id().is_some())
        .filter(|p| p.member.as_ref().is_some_and(|m| relinked.contains(m)))
        .map(|mut pin| {
            pin.content = PinContent::Reference {
                library_id: collected.library_id.clone(),
                image_id: collected.image_id.clone(),
                source_width: entry.width,
                source_height: entry.height,
            };
            pin
        })
        .collect();
    remember_members(app, &converted);
    changed(app);
}

/// 存进参考组后记下截图历史条目与组内截图成员的关联（[`capture_collected`] 用）。
fn link_captures(app: &AppHandle, saved: &[SavedPin]) {
    let groups = lock(&state(app).groups);
    groups.link_captures(&mut lock(&state(app).history), saved);
}

/// 参考组的名称；没有或读不懂时为 `None`。钉图菜单用。
pub fn group_name(app: &AppHandle, group_id: &str) -> Option<String> {
    lock(&state(app).groups).get(group_id).ok().map(|g| g.name)
}

/// 把桌面上来自参考组 `group_id` 的钉图存回它（钉图菜单“存回参考组”）。来自它自带截图的截图钉图
/// 更新那个成员，截图文件不动。
pub fn save_back(app: &AppHandle, group_id: &str) -> Result<ReferenceGroup, CommandError> {
    let mut open: Vec<SavedPin> = pins::open_pins(app)
        .into_iter()
        .filter(|p| p.member.as_ref().is_some_and(|m| m.group_id == group_id))
        .collect();
    let group = lock(&state(app).groups)
        .save_pins(group_id, &mut open)
        .map_err(CommandError::from)?;
    remember_members(app, &open);
    link_captures(app, &open);
    changed(app);
    Ok(group)
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
        let group = groups.get(&group_id).map_err(CommandError::from)?;
        Ok(crate::library::with_references(&app, |refs| {
            groups.view(group, refs)
        }))
    })
    .await
}

/// 把桌面钉图存成新的参考组；截图按逐张选择收藏后入组、只存在参考组里，或明确略过。
#[tauri::command]
pub async fn save_reference_group(
    app: AppHandle,
    name: String,
    captures: Option<Vec<CaptureChoice>>,
) -> Result<ReferenceGroup, CommandError> {
    blocking(move || {
        let (mut open, kept) = prepare_pins(&app, &captures.unwrap_or_default(), None)?;
        let group = lock(&state(&app).groups)
            .create_with_captures(&name, &mut open, &kept)
            .map_err(CommandError::from)?;
        remember_members(&app, &open);
        link_captures(&app, &open);
        changed(&app);
        Ok(group)
    })
    .await
}

/// 把桌面上的资料库钉图存进已有的参考组：来自它的钉图更新原成员，其他的加为新成员，
/// 不在桌面上的成员保留。已是它自带截图的截图钉图更新那个成员，不用再选。
#[tauri::command]
pub async fn save_pins_to_group(
    app: AppHandle,
    group_id: String,
    captures: Option<Vec<CaptureChoice>>,
) -> Result<ReferenceGroup, CommandError> {
    blocking(move || {
        let target = target_group(&app, Some(&group_id))?;
        let (mut open, kept) = prepare_pins(&app, &captures.unwrap_or_default(), target.as_ref())?;
        let group = lock(&state(&app).groups)
            .save_pins_with_captures(&group_id, &mut open, &kept)
            .map_err(CommandError::from)?;
        remember_members(&app, &open);
        link_captures(&app, &open);
        changed(&app);
        Ok(group)
    })
    .await
}

/// 打开参考组：每个成员按保存的局部与摆放钉到桌面（已在桌面上的成员不重复钉）。资料库不可用、
/// 图已删除的成员也钉出来，保留布局并在钉图上写出原因。参考组自带的截图放回截图历史后钉出，
/// 文件缺失的说明原因。返回新钉出的数量。
#[tauri::command]
pub async fn open_reference_group(app: AppHandle, group_id: String) -> Result<usize, CommandError> {
    blocking(move || {
        let groups = lock(&state(&app).groups).clone();
        let group = groups.get(&group_id).map_err(CommandError::from)?;
        let open = pins::open_pins(&app);
        let monitors = pins::monitors();
        let opened = groups.open_pins(&group, &mut lock(&state(&app).history), |m| {
            open.iter().any(|o| o.member.as_ref() == Some(m))
        });
        if opened.pins.iter().any(|p| p.capture_id().is_some()) {
            super::history_changed(&app);
        }
        let fresh: Vec<SavedPin> = opened
            .pins
            .into_iter()
            .map(|mut p| {
                let (x, y) = pull_onto_screen(p.rect(), &monitors);
                p.placement.x = x;
                p.placement.y = y;
                p
            })
            .collect();
        {
            let mut store = lock(&state(&app).store);
            for pin in &fresh {
                store.put(pin.clone());
            }
            let _ = store.save();
        }
        for pin in &fresh {
            pins::open_pin(&app, pin);
        }
        match opened.problems.first() {
            Some(e) => Err(e.clone()),
            None => Ok(fresh.len()),
        }
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
        let group = lock(&state(&app).groups)
            .rename(&group_id, &name)
            .map_err(CommandError::from)?;
        changed(&app);
        Ok(group)
    })
    .await
}

/// 删除参考组和它自带的截图。引用的图与资料库不受影响；桌面上来自它的钉图留着，只是不再记得
/// 这个参考组（自带截图的钉图仍显示截图历史里的那份）。
#[tauri::command]
pub async fn delete_reference_group(app: AppHandle, group_id: String) -> Result<(), CommandError> {
    blocking(move || {
        lock(&state(&app).groups)
            .delete(&group_id)
            .map_err(CommandError::from)?;
        {
            let mut store = lock(&state(&app).store);
            let ids: Vec<String> = store
                .pins()
                .iter()
                .filter(|p| p.member.as_ref().is_some_and(|m| m.group_id == group_id))
                .map(|p| p.id.clone())
                .collect();
            for id in ids {
                store.edit(&id, |p| p.member = None);
            }
            let _ = store.save();
        }
        changed(&app);
        Ok(())
    })
    .await
}

/// 把参考组导出成参考组包（#68）：带上所用原图与标签、备注、来源、分级的快照。`path` 为空时弹出
/// 保存对话框；取消时返回 `null`，成功时返回包的位置。有成员取不到原图时不导出并说明。
#[tauri::command]
pub async fn export_reference_group_package(
    app: AppHandle,
    group_id: String,
    path: Option<PathBuf>,
) -> Result<Option<PathBuf>, CommandError> {
    blocking(move || {
        let groups = lock(&state(&app).groups).clone();
        let group = groups.get(&group_id).map_err(CommandError::from)?;
        let Some(path) = path.or_else(|| {
            app.dialog()
                .file()
                .set_file_name(format!("{}.{PACKAGE_EXTENSION}", group.name))
                .add_filter(text(Text::FilterReferencePackage), &[PACKAGE_EXTENSION])
                .blocking_save_file()
                .and_then(|p| p.into_path().ok())
        }) else {
            return Ok(None);
        };
        crate::library::export_reference_package(&app, &groups, &group_id, &path)?;
        Ok(Some(path))
    })
    .await
}

/// 导入参考组包（#68）到明确选择的资料库和文件夹，另存为新的参考组。`path` 为空时
/// 弹出选择对话框；取消时返回 `null`。包有损坏时什么都不写。
#[tauri::command]
pub async fn import_reference_group_package(
    app: AppHandle,
    library_id: String,
    destination: Option<kinshoko_core::library::SaveDestination>,
    path: Option<PathBuf>,
) -> Result<Option<ReferenceGroup>, CommandError> {
    blocking(move || {
        let destination = destination.unwrap_or(kinshoko_core::library::SaveDestination {
            library_id: library_id.clone(),
            folder_id: None,
        });
        if destination.library_id != library_id {
            return Err(CommandError::new(
                ErrorKind::SaveTargetMismatch,
                "保存目标资料库与任务归属不一致",
            ));
        }
        let Some(path) = path.or_else(|| {
            app.dialog()
                .file()
                .add_filter(text(Text::FilterReferencePackage), &[PACKAGE_EXTENSION])
                .blocking_pick_file()
                .and_then(|p| p.into_path().ok())
        }) else {
            return Ok(None);
        };
        let groups = lock(&state(&app).groups).clone();
        let group = crate::library::with_destination(&app, &destination, |library| {
            crate::library::import_reference_package(&app, &groups, &path, library)
        })?;
        changed(&app);
        Ok(Some(group))
    })
    .await
}

/// 从参考组中去掉一个成员（桌面上的钉图留着）。参考组自带的截图没有成员再用时删除。
#[tauri::command]
pub async fn remove_group_member(
    app: AppHandle,
    group_id: String,
    member_id: String,
) -> Result<ReferenceGroup, CommandError> {
    blocking(move || {
        let group = lock(&state(&app).groups)
            .remove_member(&group_id, &member_id)
            .map_err(CommandError::from)?;
        changed(&app);
        Ok(group)
    })
    .await
}
