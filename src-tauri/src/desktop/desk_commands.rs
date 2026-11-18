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
use kinshoko_core::reference_groups::{Desk, DeskLists, GroupError, Switched};
use tauri::AppHandle;

use super::groups::{blocking, changed};
use super::{history_changed, lock, menu, pins, state};

/// 同一时刻只有一次在对齐钉图窗口。不在 `DesktopState` 里：持有它时要调用窗口 API。
static ALIGNING: Mutex<()> = Mutex::new(());

/// 新钉图从放进钉图状态到开出窗口这段，不能夹进一次对齐（[`super::pins::add_and_open`]）。
pub(in crate::desktop) fn aligning() -> std::sync::MutexGuard<'static, ()> {
    ALIGNING.lock().unwrap_or_else(|e| e.into_inner())
}

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
