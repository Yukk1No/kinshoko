//! 本地备份与恢复（#69）的命令层：规则都在 `kinshoko_core::backup`，这里只接应用：读本设备登记表、
//! 定时检查空闲、退出与关闭主窗口时触发自动备份、推送状态。
//!
//! - 计划（目标、范围、最近一次结果）存在数据目录的 `backup.json`（`KINSHOKO_DATA_DIR` 覆盖）。
//! - 每天第一次退出（关闭主窗口或托盘“退出”）或空闲时自动备份一次；目标不在时记下，界面与托盘
//!   提示，下次再试。
//! - 备份按位置与身份读资料库，不经活动资料库的句柄；读登记表时取切换锁（#49）。恢复出的资料库
//!   只登记、不切换；参考组恢复为新的参考组，推送 `reference-groups` 让列表刷新。
//! - 状态变化推送 `backup-status`（[`BackupStatus`]）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use kinshoko_core::backup::{
    BackupPlan, BackupPreview, BackupProgress, BackupReport, BackupSources, BackupStatus,
    BackupTarget, RestoreReport, ScopeSelection, SnapshotSummary, Stamp, compute_scope,
};
use kinshoko_core::reference_groups::ReferenceGroups;
use tauri::{AppHandle, Emitter, Manager};

const STATUS_EVENT: &str = "backup-status";
/// 参考组列表变化（与 desktop::groups 相同的事件）。
const GROUPS_EVENT: &str = "reference-groups";
const GROUPS_DIR: &str = "reference-groups";
/// 没有键盘、鼠标、笔输入这么久算空闲。
const IDLE_AFTER_MS: u32 = 10 * 60 * 1000;
const CHECK_EVERY: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct BackupState {
    plan: Mutex<Option<BackupPlan>>,
    running: Mutex<Option<BackupProgress>>,
    last_report: Mutex<Option<BackupReport>>,
    /// 正在备份或恢复：同一时间只做一件。
    busy: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 现在，带本地时区偏移。
fn now() -> Stamp {
    let local = chrono::Local::now();
    Stamp::new(
        local.timestamp_millis(),
        local.offset().local_minus_utc() / 60,
    )
}

fn with_plan<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut BackupPlan) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<BackupState>();
    let mut plan = lock(&state.plan);
    if plan.is_none() {
        *plan = Some(BackupPlan::open(&crate::library::data_dir(app)).map_err(|e| e.to_string())?);
    }
    f(plan.as_mut().expect("计划已读取"))
}

fn groups(app: &AppHandle) -> Result<ReferenceGroups, String> {
    ReferenceGroups::open(&crate::library::data_dir(app).join(GROUPS_DIR))
        .map_err(|e| e.to_string())
}

fn status(app: &AppHandle) -> Result<BackupStatus, String> {
    let plan = with_plan(app, |p| Ok(p.view(now())))?;
    let state = app.state::<BackupState>();
    Ok(BackupStatus {
        plan,
        running: *lock(&state.running),
        last_report: lock(&state.last_report).clone(),
    })
}

fn publish(app: &AppHandle) {
    if let Ok(status) = status(app) {
        let tooltip = if status.running.is_some() {
            "Kinshoko：正在备份…".to_owned()
        } else if let Some(failure) = &status.plan.last_failure {
            format!("Kinshoko：备份没有完成，下次再试。{}", failure.reason)
        } else {
            "Kinshoko".to_owned()
        };
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_tooltip(Some(tooltip));
        }
        let _ = app.emit(STATUS_EVENT, status);
    }
}

/// 应用启动时调用：管理状态，开始每分钟检查一次“空闲且到期”。
pub fn manage(app: &AppHandle) {
    app.manage(BackupState::default());
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("kinshoko-backup-idle".into())
        .spawn(move || {
            loop {
                std::thread::sleep(CHECK_EVERY);
                if idle() && due(&app) {
                    run(&app);
                }
            }
        });
}

#[cfg(windows)]
fn idle() -> bool {
    crate::desktop::win32::idle_ms().is_some_and(|ms| ms >= IDLE_AFTER_MS)
}

#[cfg(not(windows))]
fn idle() -> bool {
    false
}

fn due(app: &AppHandle) -> bool {
    with_plan(app, |p| Ok(p.due(now()))).unwrap_or(false)
}

/// 主窗口关闭（画师眼里的“退出”）：今天还没备份就在后台备份，进程留在托盘。
pub fn on_main_window_closed(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if due(&app) {
            run(&app);
        }
    });
}

/// 托盘“退出”：今天还没备份就先备份（或等正在进行的备份结束），再结束进程。
pub fn quit(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if due(&app) {
            run(&app);
        }
        while app.state::<BackupState>().busy.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(200));
        }
        app.exit(0);
    });
}

/// 按计划备份一次（在调用方的线程上）。已经在备份或恢复时什么也不做。
fn run(app: &AppHandle) {
    let state = app.state::<BackupState>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    *lock(&state.running) = Some(BackupProgress { done: 0, total: 0 });
    publish(app);
    let started = now();
    let outcome = (|| {
        let (target, selection) = with_plan(app, |p| {
            Ok((p.target().map(PathBuf::from), p.selection().clone()))
        })?;
        let Some(target) = target else {
            return Err("还没有选择备份目标".to_owned());
        };
        let registry = crate::library::registered(app)?;
        let groups = groups(app)?;
        let scope = compute_scope(
            &registry,
            &groups.list().map_err(|e| e.to_string())?,
            &selection,
        );
        let mut last = std::time::Instant::now();
        let result = BackupTarget::new(&target).run(
            &scope,
            &BackupSources {
                libraries: &registry,
                groups: &groups,
            },
            started,
            &mut |progress| {
                *lock(&app.state::<BackupState>().running) = Some(progress);
                if last.elapsed() > Duration::from_millis(250) || progress.done == progress.total {
                    last = std::time::Instant::now();
                    publish(app);
                }
            },
        );
        Ok(result)
    })();
    let _ = with_plan(app, |plan| {
        match &outcome {
            Ok(Ok(report)) if report.complete => plan.record_success(started, &report.snapshot_id),
            Ok(Ok(report)) => plan.record_problem(now(), report.problems.join("；"), false),
            Ok(Err(e)) => plan.record_failure(now(), e),
            Err(e) => plan.record_problem(now(), e.clone(), false),
        }
        .map_err(|e| e.to_string())
    });
    if let Ok(Ok(report)) = outcome {
        *lock(&state.last_report) = Some(report);
    }
    *lock(&state.running) = None;
    state.busy.store(false, Ordering::SeqCst);
    publish(app);
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn backup_status(app: AppHandle) -> Result<BackupStatus, String> {
    blocking(move || status(&app)).await
}

/// 选择（`None` 为清除）备份目标目录。
#[tauri::command]
pub async fn set_backup_target(
    app: AppHandle,
    target: Option<PathBuf>,
) -> Result<BackupStatus, String> {
    blocking(move || {
        if let Some(t) = &target
            && !t.is_dir()
        {
            return Err(format!("备份目标不在：{}", t.display()));
        }
        with_plan(&app, |p| {
            p.set_target(target.as_deref()).map_err(|e| e.to_string())
        })?;
        publish(&app);
        status(&app)
    })
    .await
}

#[tauri::command]
pub async fn set_backup_selection(
    app: AppHandle,
    selection: ScopeSelection,
) -> Result<BackupStatus, String> {
    blocking(move || {
        with_plan(&app, |p| {
            p.set_selection(selection).map_err(|e| e.to_string())
        })?;
        publish(&app);
        status(&app)
    })
    .await
}

/// 执行前的范围与容量：会一起带上的关联参考组与外库、没覆盖的内容、要新写入的量。
#[tauri::command]
pub async fn backup_preview(
    app: AppHandle,
    selection: ScopeSelection,
) -> Result<BackupPreview, String> {
    blocking(move || {
        let registry = crate::library::registered(&app)?;
        let groups = groups(&app)?;
        let scope = compute_scope(
            &registry,
            &groups.list().map_err(|e| e.to_string())?,
            &selection,
        );
        let target =
            with_plan(&app, |p| Ok(p.target().map(PathBuf::from)))?.map(|t| BackupTarget::new(&t));
        let available = target.as_ref().is_some_and(BackupTarget::available);
        let estimate = target
            .unwrap_or_else(|| BackupTarget::new(std::path::Path::new("")))
            .estimate(
                &scope,
                &BackupSources {
                    libraries: &registry,
                    groups: &groups,
                },
            )
            .map_err(|e| e.to_string())?;
        Ok(BackupPreview {
            scope,
            estimate,
            target_available: available,
        })
    })
    .await
}

/// 马上备份一次（手动），在后台进行；进度与结果经 `backup-status` 推送。
#[tauri::command]
pub async fn start_backup(app: AppHandle) -> Result<(), String> {
    if app.state::<BackupState>().busy.load(Ordering::SeqCst) {
        return Err("正在备份，请等这次完成".into());
    }
    std::thread::spawn(move || run(&app));
    Ok(())
}

/// 备份目标里的完整快照，新的在前。
#[tauri::command]
pub async fn backup_snapshots(app: AppHandle) -> Result<Vec<SnapshotSummary>, String> {
    blocking(move || {
        let target = with_plan(&app, |p| Ok(p.target().map(PathBuf::from)))?
            .ok_or_else(|| "还没有选择备份目标".to_owned())?;
        BackupTarget::new(&target)
            .snapshots()
            .map_err(|e| e.to_string())
    })
    .await
}

/// 从快照恢复出独立的资料库（放在 `into` 下，登记到本设备但不切换）与参考组，并返回自动运行的
/// 往返检查结果。不覆盖现有的资料库与参考组。
#[tauri::command]
pub async fn restore_backup(
    app: AppHandle,
    snapshot_id: String,
    into: PathBuf,
) -> Result<RestoreReport, String> {
    blocking(move || {
        let state = app.state::<BackupState>();
        if state.busy.swap(true, Ordering::SeqCst) {
            return Err("正在备份或恢复，请等这次完成".into());
        }
        let result = (|| {
            let target = with_plan(&app, |p| Ok(p.target().map(PathBuf::from)))?
                .ok_or_else(|| "还没有选择备份目标".to_owned())?;
            let groups = groups(&app)?;
            let report = BackupTarget::new(&target)
                .restore(&snapshot_id, &into, &groups, now())
                .map_err(|e| e.to_string())?;
            let roots: Vec<PathBuf> = report
                .libraries
                .iter()
                .map(|l| l.library.root.clone())
                .collect();
            crate::library::register_restored(&app, &roots)?;
            Ok(report)
        })();
        state.busy.store(false, Ordering::SeqCst);
        let _ = app.emit(GROUPS_EVENT, ());
        result
    })
    .await
}
