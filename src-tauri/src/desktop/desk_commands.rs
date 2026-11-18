//! 参考组改成桌面（#588、#591）的命令，与 `kinshoko_core::reference_groups::Desk` 的操作一一对应：
//! 侧栏三段（常用、最近、更早）、切换、清空桌面（“新建”）、钉回、移出没钉着的、设为常用、
//! 加进上一组、移到新参考组，以及后三者的撤销。删除与撤销沿用 [`super::group_trash`] 的命令，
//! 改名沿用 [`super::groups`] 的，开关打开时那边改走桌面上的参考组。规则都在 core，这里只接窗口。
//!
//! 桌面可以空着（没有参考组）：钉下的第一张开一个新参考组，推送 [`STARTED_EVENT`]。
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
use kinshoko_core::reference_groups::{Desk, DeskLists, GroupError, Pruned, Split, Switched};
use tauri::{AppHandle, Emitter};

use super::groups::{blocking, changed};
use super::{history_changed, lock, menu, pins, state};

/// 空桌上钉下第一张、开了新参考组，而且有上一组时推送；载荷是上一组的 id，界面据此提示
/// “加进「上一组」”（[`fold_into_previous`]）。
pub const STARTED_EVENT: &str = "desk-group-started";

/// 最近一次“移出没钉着的”，撤销用（[`undo_prune_unpinned`]）。里面有自带截图的字节，不发给界面。
static LAST_PRUNED: Mutex<Option<Pruned>> = Mutex::new(None);

/// 最近一次“移到新参考组”，撤销用（[`undo_split_off`]）。
static LAST_SPLIT: Mutex<Option<Split>> = Mutex::new(None);

/// 同一时刻只有一次在对齐钉图窗口。不在 `DesktopState` 里：持有它时要调用窗口 API。
static ALIGNING: Mutex<()> = Mutex::new(());

/// 另起线程时重新对齐一次（[`super::pins::add_and_open`]）。
pub(in crate::desktop) fn realign(app: &AppHandle) {
    align(app);
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

/// 空桌上开了新参考组（[`super::pins::add`] 调用，不持有锁）：列表变了；有上一组时推送 [`STARTED_EVENT`]。
pub(in crate::desktop) fn started(app: &AppHandle, fold_into: Option<String>) {
    if let Some(previous) = fold_into {
        let _ = app.emit(STARTED_EVENT, previous);
    }
    changed(app);
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

/// 侧栏的三段：常用（按画师设的先后）、最近（新建的在前）、更早（没设常用又一个月没用过的）。
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

/// 清空桌面（“新建”）：原来那一组原样留着，之后钉下的第一张开一个新参考组。
#[tauri::command]
pub async fn new_reference_desk(app: AppHandle) -> Result<(), CommandError> {
    blocking(move || {
        let switched = with_desk(&app, |desk, history| desk.new_desk(history))?;
        apply(&app, Some(switched));
        Ok(())
    })
    .await
}

/// 钉回桌面上参考组里没钉着的成员 `member_id`，在它原来的位置。已经钉着时什么都不做。
#[tauri::command]
pub async fn repin_group_member(app: AppHandle, member_id: String) -> Result<(), CommandError> {
    blocking(move || {
        let repinned = with_desk(&app, |desk, history| desk.repin(&member_id, history))?;
        if repinned.is_some() {
            mark_dirty(&app);
            apply(&app, None);
        }
        Ok(())
    })
    .await
}

/// 移出桌面上参考组里没钉着的成员，返回移出了几个（0 时什么都没做）。撤销用
/// [`undo_prune_unpinned`]，只撤销最近一次。
#[tauri::command]
pub async fn prune_unpinned_members(app: AppHandle) -> Result<usize, CommandError> {
    blocking(move || {
        let pruned = with_desk(&app, |desk, _| desk.prune_unpinned())?;
        let count = pruned.as_ref().map_or(0, Pruned::count);
        if pruned.is_some() {
            *LAST_PRUNED.lock().unwrap_or_else(|e| e.into_inner()) = pruned;
            changed(&app);
        }
        Ok(count)
    })
    .await
}

/// 从桌面上的参考组移出成员 `member_id`，钉着它的钉图一起关掉。撤销与“移出没钉着的”共用
/// [`undo_prune_unpinned`]。成员不在桌面上的参考组里时返回 `false`，什么都不做。
pub(super) fn remove_desk_member(app: &AppHandle, member_id: &str) -> Result<bool, CommandError> {
    let removed = with_desk(app, |desk, history| desk.remove_member(member_id, history))?;
    let Some(removed) = removed else {
        return Ok(false);
    };
    *LAST_PRUNED.lock().unwrap_or_else(|e| e.into_inner()) = Some(removed);
    apply(app, None);
    Ok(true)
}

/// 撤销最近一次“移出没钉着的”或移出一个成员。没有可撤销的时什么都不做。
#[tauri::command]
pub async fn undo_prune_unpinned(app: AppHandle) -> Result<(), CommandError> {
    blocking(move || {
        let Some(pruned) = LAST_PRUNED.lock().unwrap_or_else(|e| e.into_inner()).take() else {
            return Ok(());
        };
        with_desk(&app, |desk, _| desk.undo_prune(&pruned))?;
        changed(&app);
        Ok(())
    })
    .await
}

/// 设为常用（排在常用的最后）或取消常用。
#[tauri::command]
pub async fn set_reference_group_favorite(
    app: AppHandle,
    group_id: String,
    favorite: bool,
) -> Result<(), CommandError> {
    blocking(move || {
        with_desk(&app, |desk, _| desk.set_favorite(&group_id, favorite))?;
        changed(&app);
        Ok(())
    })
    .await
}

/// 加进上一组：桌面上参考组的成员连同自带截图移进 `target_id`，删掉桌面上那个，把 `target_id`
/// 摆上桌面。
#[tauri::command]
pub async fn fold_into_previous(app: AppHandle, target_id: String) -> Result<(), CommandError> {
    blocking(move || {
        let switched = with_desk(&app, |desk, history| {
            desk.fold_into_previous(&target_id, history)
        })?;
        apply(&app, Some(switched));
        Ok(())
    })
    .await
}

/// 移到新参考组：桌面上参考组里在本地日期 `day`（`YYYY-MM-DD`）添加的成员移到一个新参考组，
/// 新参考组摆上桌面，原来那组原样留着（#595）。返回新参考组的 id；这一段为空或就是全部成员时为
/// `None`。撤销用 [`undo_split_off`]，只撤销最近一次。
#[tauri::command]
pub async fn split_off_reference_group(
    app: AppHandle,
    day: String,
) -> Result<Option<String>, CommandError> {
    blocking(move || {
        let added = local_day(&day)?;
        let moved = with_desk(&app, |desk, history| {
            let Some(split) = desk.split_off(added, history)? else {
                return Ok(None);
            };
            let switched = desk.switch_to(&split.to, history)?;
            Ok(Some((split, switched)))
        })?;
        let Some((split, switched)) = moved else {
            return Ok(None);
        };
        let to = split.to.clone();
        *LAST_SPLIT.lock().unwrap_or_else(|e| e.into_inner()) = Some(split);
        apply(&app, Some(switched));
        Ok(Some(to))
    })
    .await
}

/// 撤销最近一次“移到新参考组”。没有可撤销的时什么都不做。
#[tauri::command]
pub async fn undo_split_off(app: AppHandle) -> Result<(), CommandError> {
    blocking(move || {
        let Some(split) = LAST_SPLIT.lock().unwrap_or_else(|e| e.into_inner()).take() else {
            return Ok(());
        };
        let switched = with_desk(&app, |desk, history| desk.undo_split(&split, history))?;
        apply(&app, Some(switched));
        Ok(())
    })
    .await
}

/// 有改动要落盘（[`super::edge`] 的后台线程写回）。
fn mark_dirty(app: &AppHandle) {
    state(app)
        .dirty
        .store(true, std::sync::atomic::Ordering::Relaxed);
}

/// 本地日期 `day`（`YYYY-MM-DD`）这一天的范围（毫秒，左闭右开）。
fn local_day(day: &str) -> Result<std::ops::Range<i64>, CommandError> {
    // 不上界面：界面传来的日期读不懂是程序错误，按系统错误报，界面只显示通用的出错文字。
    let bad = |e: jiff::Error| CommandError::system(format!("日期读不懂：{e}"));
    let date: jiff::civil::Date = day.parse().map_err(bad)?;
    let tz = jiff::tz::TimeZone::system();
    let start = date.to_zoned_datetime(tz.clone()).map_err(bad)?;
    let end = date
        .tomorrow()
        .and_then(|d| d.to_zoned_datetime(tz))
        .map_err(bad)?;
    Ok(start.timestamp().as_millisecond()..end.timestamp().as_millisecond())
}
