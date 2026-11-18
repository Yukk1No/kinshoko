//! 参考组改成桌面（#588、#591）的命令：切换列表与归档、切换、新建、归档、取出。删除与撤销沿用
//! [`super::group_trash`] 的命令，开关打开时那边改走桌面上的参考组。规则都在
//! `kinshoko_core::reference_groups::Desk`，这里只接窗口。
//!
//! 开关（设置里界面上没有的 `deskReferenceGroups`）关着时，这些命令报错、什么都不改。
//!
//! 换一桌钉图（[`apply`]）：先在锁里让桌面模块换好，放开锁后再动窗口——关掉菜单，旧钉图一起关掉，
//! 新钉图一起打开，不加转场；之前是收起的（F4），新钉图也直接收起。窗口按桌面模块此刻的钉图对齐，
//! 所以连按几次切换时，最后留在桌面上的只有最后那一次的钉图。

use std::collections::HashSet;
use std::sync::Mutex;

use kinshoko_core::CommandError;
use kinshoko_core::command_error::ErrorKind;
use kinshoko_core::desktop::SavedPin;
use kinshoko_core::reference_groups::{Desk, DeskLists, GroupError, MergeUndo, Switched};
use tauri::AppHandle;

use super::groups::{blocking, changed};
use super::{history_changed, lock, menu, pins, state};

/// 同一时刻只有一次在对齐钉图窗口。不在 `DesktopState` 里：持有它时要调用窗口 API。
static ALIGNING: Mutex<()> = Mutex::new(());

fn flag_off() -> CommandError {
    CommandError::new(ErrorKind::DeskGroupsOff, "参考组改成桌面的开关没打开")
}

/// 在桌面模块上做一件事：先参考组、后钉图状态、再截图历史。开关关着时报错。
pub(super) fn with_desk<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut Desk, &mut kinshoko_core::desktop::CaptureHistory) -> Result<T, GroupError>,
) -> Result<T, CommandError> {
    let _groups = lock(&state(app).groups);
    let mut store = lock(&state(app).store);
    let desk = store.desk().ok_or_else(flag_off)?;
    let mut history = lock(&state(app).history);
    f(desk, &mut history).map_err(CommandError::from)
}

/// 开关打开着。
pub(super) fn desk_on(app: &AppHandle) -> bool {
    lock(&state(app).store).is_desk()
}

/// 换了一桌：动窗口，再通知各窗口截图历史与参考组变了。成员钉不出来时只写运行日志，
/// 其余成员照常摆出。不持有任何 `DesktopState` 的锁调用。
pub(super) fn apply(app: &AppHandle, switched: Option<Switched>) {
    if let Some(switched) = &switched {
        for problem in &switched.opened.problems {
            crate::run_log::warn("桌面上的参考组有成员钉不出来", problem);
        }
    }
    align(app);
    history_changed(app);
    changed(app);
}

/// 让钉图窗口与桌面上的参考组一致：不在其中的关掉，新的打开。
fn align(app: &AppHandle) {
    let _aligning = ALIGNING.lock().unwrap_or_else(|e| e.into_inner());
    menu::close_open(app);
    let hidden = lock(&state(app).edge).any_hidden();
    let wanted: Vec<SavedPin> = lock(&state(app).store).pins().to_vec();
    let wanted_ids: HashSet<&str> = wanted.iter().map(|p| p.id.as_str()).collect();
    let open: Vec<String> = lock(&state(app).pins).keys().cloned().collect();
    for id in open.iter().filter(|id| !wanted_ids.contains(id.as_str())) {
        pins::dismiss(app, id);
    }
    let open: HashSet<String> = open.into_iter().collect();
    let fresh: Vec<&SavedPin> = wanted.iter().filter(|p| !open.contains(&p.id)).collect();
    if fresh.iter().any(|p| p.capture_id().is_none()) {
        // 资料库钉图要经参考视角读图、核对遮蔽。
        let _ = crate::library::current_or_last(app);
    }
    for pin in fresh {
        pins::open_pin(app, pin);
    }
    if hidden {
        super::edge::tuck_all(app);
    }
}

/// 切换列表（最近用过的在前）与归档（最近保存的在前）。
#[tauri::command]
pub async fn desk_reference_groups(app: AppHandle) -> Result<DeskLists, CommandError> {
    blocking(move || with_desk(&app, |desk, _| desk.lists())).await
}

/// 整桌换成参考组 `group_id`，原来那一桌原样留着。
#[tauri::command]
pub async fn switch_reference_group(app: AppHandle, group_id: String) -> Result<(), CommandError> {
    blocking(move || {
        let switched = with_desk(&app, |desk, history| desk.switch_to(&group_id, history))?;
        apply(&app, Some(switched));
        Ok(())
    })
    .await
}

/// 换到一张新的空桌（不起名、不落盘）。
#[tauri::command]
pub async fn new_reference_desk(app: AppHandle) -> Result<(), CommandError> {
    blocking(move || {
        let switched = with_desk(&app, |desk, history| desk.new_desk(history))?;
        apply(&app, Some(switched));
        Ok(())
    })
    .await
}

/// 把参考组收出切换列表。收的正是桌面上那个时，桌面换到最近用过的另一个，没有就换到空桌。
#[tauri::command]
pub async fn archive_reference_group(app: AppHandle, group_id: String) -> Result<(), CommandError> {
    blocking(move || {
        let switched = with_desk(&app, |desk, history| desk.archive(&group_id, history))?;
        apply(&app, switched);
        Ok(())
    })
    .await
}

/// 从归档取出：放回切换列表并摆到桌面上，改的是原件。
#[tauri::command]
pub async fn unarchive_reference_group(
    app: AppHandle,
    group_id: String,
) -> Result<(), CommandError> {
    blocking(move || {
        let switched = with_desk(&app, |desk, history| desk.unarchive(&group_id, history))?;
        apply(&app, Some(switched));
        Ok(())
    })
    .await
}

/// 并入（#595）：把参考组 `group_id` 的成员复制到桌面上的参考组并钉出来，来源不变。
/// 返回撤销要用的记录，交给 [`undo_merge_reference_group`]。
#[tauri::command]
pub async fn merge_reference_group(
    app: AppHandle,
    group_id: String,
) -> Result<MergeUndo, CommandError> {
    blocking(move || {
        let monitors = pins::monitors();
        let merged = with_desk(&app, |desk, history| {
            desk.merge_in(&group_id, history, &monitors)
        })?;
        for problem in &merged.opened.problems {
            crate::run_log::warn("并入的参考组有成员钉不出来", problem);
        }
        apply(&app, None);
        Ok(merged.undo)
    })
    .await
}

/// 撤销并入：去掉那次并入的成员和复制来的截图。
#[tauri::command]
pub async fn undo_merge_reference_group(
    app: AppHandle,
    undo: MergeUndo,
) -> Result<(), CommandError> {
    blocking(move || {
        with_desk(&app, |desk, history| desk.undo_merge(&undo, history))?;
        apply(&app, None);
        Ok(())
    })
    .await
}

/// 钉图菜单“移到参考组 ▸”（#595）：钉图 `pin` 移到参考组 `group_id`，桌面上不再显示它。已在菜单的
/// 线程上。钉图随即消失，旁边没有地方写提示，也不打断画画，所以成功时不提示；失败时在钉图上说原因。
pub(super) fn move_from_menu(
    app: &AppHandle,
    pin: &str,
    group_id: &str,
) -> Option<kinshoko_core::desktop::PinNotice> {
    match with_desk(app, |desk, history| desk.move_pin(pin, group_id, history)) {
        Ok(_) => {
            apply(app, None);
            super::edge::hand_back_focus();
            None
        }
        Err(e) => Some(e.into()),
    }
}

/// 快捷键“上个参考组”“下个参考组”（#594）：在别的线程上按切换列表的先后换过去，快捷键回调不阻塞。
/// 换过去后在一张新钉图上写出参考组的名称，焦点交还绘画软件。开关关着时（快捷键本不该注册）什么都不做。
pub fn step_in_background(app: &AppHandle, forward: bool) {
    let app = app.clone();
    std::thread::spawn(move || {
        match with_desk(&app, |desk, history| desk.step(forward, history)) {
            Ok(Some(switched)) => {
                apply(&app, Some(switched));
                announce(&app);
            }
            Ok(None) => {}
            Err(e) => crate::run_log::warn("快捷键切换参考组失败", e),
        }
        super::edge::hand_back_focus();
    });
}

/// 快捷键“新参考组”（#594）：换到空桌。空桌没有钉图，不提示。
pub fn new_desk_in_background(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        match with_desk(&app, |desk, history| desk.new_desk(history)) {
            Ok(switched) => apply(&app, Some(switched)),
            Err(e) => crate::run_log::warn("快捷键新建参考组失败", e),
        }
        super::edge::hand_back_focus();
    });
}

/// 在桌面上第一张钉图上写出参考组的名称（没有名称写“未命名”和时间）。只写一张；提示只是文字，
/// 遮蔽的钉图照样遮蔽。
fn announce(app: &AppHandle) {
    let (pin, label) = {
        let mut store = lock(&state(app).store);
        let Some(desk) = store.desk() else {
            return;
        };
        let group = desk.group();
        let label = crate::ui_text::group_label(&group.name, group.updated_at);
        let Some(pin) = desk.pins().first().map(|p| p.id.clone()) else {
            return;
        };
        (pin, label)
    };
    pins::notify(app, &pin, &label);
}

/// 钉图菜单要显示的桌面上的参考组名称（#593，没有名称为空）；开关关着时为 `None`。
pub(super) fn desk_name(app: &AppHandle) -> Option<String> {
    lock(&state(app).store)
        .desk()
        .map(|desk| desk.group().name.trim().to_owned())
}

/// 钉图菜单“切换到 ▸”里选了一个（`group_id`）或“新参考组”（`None`，#593）。已在菜单的线程上。
/// 返回要在钉图上提示什么：失败时说原因；成功时原来那张钉图已经不在，不提示。
pub(super) fn switch_from_menu(
    app: &AppHandle,
    group_id: Option<&str>,
) -> Option<kinshoko_core::desktop::PinNotice> {
    let switched = with_desk(app, |desk, history| match group_id {
        Some(id) => desk.switch_to(id, history),
        None => desk.new_desk(history),
    });
    match switched {
        Ok(switched) => {
            apply(app, Some(switched));
            super::edge::hand_back_focus();
            None
        }
        Err(e) => Some(e.into()),
    }
}

/// 托盘菜单里参考组那一段（#593）：切换列表里最近的几个（桌面上的那个打勾）。开关关着时为 `None`。
/// 会读参考组文件。
pub(super) fn tray_groups(app: &AppHandle) -> Option<Vec<(String, String, bool)>> {
    const TRAY_GROUPS: usize = 8;
    let lists = with_desk(app, |desk, _| desk.lists()).ok()?;
    Some(
        lists
            .switch_list
            .iter()
            .take(TRAY_GROUPS)
            .map(|g| {
                let label = crate::ui_text::group_label(&g.name, g.updated_at);
                (
                    g.id.clone(),
                    label,
                    lists.on_desk.as_deref() == Some(g.id.as_str()),
                )
            })
            .collect(),
    )
}

/// 托盘菜单里选了参考组（`group_id`）或“新参考组”（`None`，#593）：在别的线程上换过去。
pub(super) fn switch_from_tray(app: &AppHandle, group_id: Option<String>) {
    let app = app.clone();
    std::thread::spawn(move || {
        let switched = with_desk(&app, |desk, history| match &group_id {
            Some(id) => desk.switch_to(id, history),
            None => desk.new_desk(history),
        });
        match switched {
            Ok(switched) => apply(&app, Some(switched)),
            Err(e) => crate::run_log::warn("托盘切换参考组失败", e),
        }
    });
}
