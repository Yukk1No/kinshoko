//! 参考组（#66）的命令：把桌面上的资料库钉图存成参考组、存回、打开（成员钉到桌面）、重命名、删除；
//! 参考组包（#68）的导出与导入。
//! 规则与存储在 `kinshoko_core::reference_groups`；参考组是应用数据目录 `reference-groups/` 下
//! 独立于资料库的 JSON（ADR-0002）。
//!
//! 成员按“资料库＋参考图”引用，可跨资料库：活动资料库经参考视角，其他已登记的资料库只读打开
//! （[`crate::library::with_references`]）。资料库不可用、图已删除的成员照样按原布局钉出来，钉图上
//! 写出原因；安全模式下被封印的成员原位遮蔽，画师在钉图菜单里逐张确认显示。
//!
//! 参考组变化后向所有窗口推送 `reference-groups`（无载荷），主窗口据此重新读取列表。

use kinshoko_core::desktop::{CaptureChoice, CaptureEntry, SavedPin, pull_onto_screen};
use std::path::PathBuf;

use kinshoko_core::reference_groups::{
    GroupSummary, PACKAGE_EXTENSION, ReferenceGroup, ReferenceGroupView,
};
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt as _;

use super::{lock, pins, state};

pub(super) const CHANGED_EVENT: &str = "reference-groups";

fn changed(app: &AppHandle) {
    let _ = app.emit(CHANGED_EVENT, ());
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// 把存进参考组后钉图记下的成员写回钉图状态。
fn remember_members(app: &AppHandle, saved: &[SavedPin]) {
    pins::remember_group_members(app, saved);
}

/// 列出当前桌面上需决定是否入组的截图（包括已手动收藏的）。
#[tauri::command]
pub async fn group_save_captures(app: AppHandle) -> Result<Vec<CaptureEntry>, String> {
    blocking(move || {
        let open = pins::open_pins(&app);
        let history = lock(&state(&app).history);
        let mut captures = Vec::new();
        for id in open.iter().filter_map(SavedPin::capture_id) {
            if !captures.iter().any(|e: &CaptureEntry| e.id == id) {
                captures.push(
                    history
                        .entry(id)
                        .ok_or("截图已不在历史中，请关闭这张钉图后重试")?,
                );
            }
        }
        Ok(captures)
    })
    .await
}

fn prepare_pins(app: &AppHandle, choices: &[CaptureChoice]) -> Result<Vec<SavedPin>, String> {
    let open = pins::open_pins(app);
    // 先核对全部选择；预览后新出现的截图也必须明确处理。
    for id in open.iter().filter_map(SavedPin::capture_id) {
        if choices.iter().filter(|c| c.capture_id == id).count() != 1 {
            return Err("桌面截图有变化，请重新选择每张截图的资料库或明确不加入参考组".into());
        }
    }
    let mut prepared = Vec::new();
    for pin in open {
        let Some(id) = pin.capture_id() else {
            prepared.push(pin);
            continue;
        };
        let choice = choices
            .iter()
            .find(|c| c.capture_id == id)
            .expect("已核对选择");
        let Some(library_id) = &choice.library_id else {
            continue;
        };
        let reference = crate::library::with_collection(app, library_id, |library| {
            lock(&state(app).history)
                .collect_pin(&pin, library)
                .map_err(|e| e.to_string())
        })?;
        prepared.push(reference);
    }
    super::history_changed(app);
    Ok(prepared)
}

/// 参考组的名称；没有或读不懂时为 `None`。钉图菜单用。
pub fn group_name(app: &AppHandle, group_id: &str) -> Option<String> {
    lock(&state(app).groups).get(group_id).ok().map(|g| g.name)
}

/// 把桌面上来自参考组 `group_id` 的钉图存回它（钉图菜单“存回参考组”）。
pub fn save_back(app: &AppHandle, group_id: &str) -> Result<ReferenceGroup, String> {
    let mut open: Vec<SavedPin> = pins::open_pins(app)
        .into_iter()
        .filter(|p| p.member.as_ref().is_some_and(|m| m.group_id == group_id))
        .collect();
    let group = lock(&state(app).groups)
        .save_pins(group_id, &mut open)
        .map_err(|e| e.to_string())?;
    remember_members(app, &open);
    changed(app);
    Ok(group)
}

/// 本设备的参考组，最近保存的在前；读不懂的文件也列出并说明原因。
#[tauri::command]
pub async fn reference_groups(app: AppHandle) -> Result<Vec<GroupSummary>, String> {
    blocking(move || lock(&state(&app).groups).list().map_err(|e| e.to_string())).await
}

/// 一个参考组及每个成员此刻能否显示（不可用时的原因、安全模式下是否遮蔽）。
#[tauri::command]
pub async fn reference_group(
    app: AppHandle,
    group_id: String,
) -> Result<ReferenceGroupView, String> {
    blocking(move || {
        let group = lock(&state(&app).groups)
            .get(&group_id)
            .map_err(|e| e.to_string())?;
        Ok(crate::library::with_references(&app, |refs| {
            ReferenceGroupView::new(group, refs)
        }))
    })
    .await
}

/// 把桌面钉图存成新的参考组；截图按逐张选择收藏后入组，或明确略过。
#[tauri::command]
pub async fn save_reference_group(
    app: AppHandle,
    name: String,
    captures: Option<Vec<CaptureChoice>>,
) -> Result<ReferenceGroup, String> {
    blocking(move || {
        let mut open = prepare_pins(&app, &captures.unwrap_or_default())?;
        let group = lock(&state(&app).groups)
            .create(&name, &mut open)
            .map_err(|e| e.to_string())?;
        remember_members(&app, &open);
        changed(&app);
        Ok(group)
    })
    .await
}

/// 把桌面上的资料库钉图存进已有的参考组：来自它的钉图更新原成员，其他的加为新成员，
/// 不在桌面上的成员保留。
#[tauri::command]
pub async fn save_pins_to_group(
    app: AppHandle,
    group_id: String,
    captures: Option<Vec<CaptureChoice>>,
) -> Result<ReferenceGroup, String> {
    blocking(move || {
        let mut open = prepare_pins(&app, &captures.unwrap_or_default())?;
        let group = lock(&state(&app).groups)
            .save_pins(&group_id, &mut open)
            .map_err(|e| e.to_string())?;
        remember_members(&app, &open);
        changed(&app);
        Ok(group)
    })
    .await
}

/// 打开参考组：每个成员按保存的局部与摆放钉到桌面（已在桌面上的成员不重复钉）。资料库不可用、
/// 图已删除的成员也钉出来，保留布局并在钉图上写出原因。返回新钉出的数量。
#[tauri::command]
pub async fn open_reference_group(app: AppHandle, group_id: String) -> Result<usize, String> {
    blocking(move || {
        let group = lock(&state(&app).groups)
            .get(&group_id)
            .map_err(|e| e.to_string())?;
        let open = pins::open_pins(&app);
        let monitors = pins::monitors();
        let fresh: Vec<SavedPin> = group
            .pins()
            .into_iter()
            .filter(|p| {
                !open
                    .iter()
                    .any(|o| o.member.is_some() && o.member == p.member)
            })
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
        let mut errors = Vec::new();
        for pin in &fresh {
            if let Err(e) = pins::open_window(&app, pin) {
                errors.push(e);
            }
        }
        match errors.first() {
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
) -> Result<ReferenceGroup, String> {
    blocking(move || {
        let group = lock(&state(&app).groups)
            .rename(&group_id, &name)
            .map_err(|e| e.to_string())?;
        changed(&app);
        Ok(group)
    })
    .await
}

/// 删除参考组。引用的图与资料库不受影响；桌面上来自它的钉图留着，只是不再记得这个参考组。
#[tauri::command]
pub async fn delete_reference_group(app: AppHandle, group_id: String) -> Result<(), String> {
    blocking(move || {
        lock(&state(&app).groups)
            .delete(&group_id)
            .map_err(|e| e.to_string())?;
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
) -> Result<Option<PathBuf>, String> {
    blocking(move || {
        let groups = lock(&state(&app).groups).clone();
        let group = groups.get(&group_id).map_err(|e| e.to_string())?;
        let Some(path) = path.or_else(|| {
            app.dialog()
                .file()
                .set_file_name(format!("{}.{PACKAGE_EXTENSION}", group.name))
                .add_filter("参考组包", &[PACKAGE_EXTENSION])
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

/// 导入参考组包（#68）到资料库 `library_id`（界面正在操作的资料库），另存为新的参考组。`path` 为空时
/// 弹出选择对话框；取消时返回 `null`。包有损坏时什么都不写。
#[tauri::command]
pub async fn import_reference_group_package(
    app: AppHandle,
    library_id: String,
    path: Option<PathBuf>,
) -> Result<Option<ReferenceGroup>, String> {
    blocking(move || {
        crate::library::current(&app, &library_id)?;
        let Some(path) = path.or_else(|| {
            app.dialog()
                .file()
                .add_filter("参考组包", &[PACKAGE_EXTENSION])
                .blocking_pick_file()
                .and_then(|p| p.into_path().ok())
        }) else {
            return Ok(None);
        };
        let groups = lock(&state(&app).groups).clone();
        let group = crate::library::with_current(&app, &library_id, |library| {
            crate::library::import_reference_package(&app, &groups, &path, library)
        })?;
        changed(&app);
        Ok(Some(group))
    })
    .await
}

/// 从参考组中去掉一个成员（桌面上的钉图留着）。
#[tauri::command]
pub async fn remove_group_member(
    app: AppHandle,
    group_id: String,
    member_id: String,
) -> Result<ReferenceGroup, String> {
    blocking(move || {
        let group = lock(&state(&app).groups)
            .remove_member(&group_id, &member_id)
            .map_err(|e| e.to_string())?;
        changed(&app);
        Ok(group)
    })
    .await
}
