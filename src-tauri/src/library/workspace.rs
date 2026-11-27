//! Workspace adapter: detached provider reads, revisions and global safe-mode boundaries.

use super::*;
use kinshoko_core::CommandError;
use kinshoko_core::diagnostics::took;
use kinshoko_core::workspace::{
    WorkspaceCard, WorkspaceDirectories, WorkspacePage, WorkspaceQuery, WorkspaceStatus,
};

/// 主窗口不可见或最小化时的兜底重检间隔：平时由窗口恢复/聚焦事件即时唤醒，超时仅防漏发。
const INACTIVE_RECHECK: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Default)]
pub(super) struct MonitorWake {
    seq: std::sync::Mutex<u64>,
    condvar: std::sync::Condvar,
}

impl MonitorWake {
    fn wake(&self) {
        let mut seq = lock(&self.seq);
        *seq = seq.wrapping_add(1);
        self.condvar.notify_all();
    }

    fn snapshot(&self) -> u64 {
        *lock(&self.seq)
    }

    fn wait_timeout(&self, seen: &mut u64, timeout: std::time::Duration) -> bool {
        let guard = lock(&self.seq);
        let (guard, _) = self
            .condvar
            .wait_timeout_while(guard, timeout, |seq| *seq == *seen)
            .unwrap_or_else(|e| e.into_inner());
        if *guard != *seen {
            *seen = *guard;
            true
        } else {
            false
        }
    }
}

pub(crate) fn wake_on_notice<R: Runtime>(app: &AppHandle<R>, notice: &AppNotice) {
    if matches!(
        notice,
        AppNotice::Library(
            LibraryEvent::VocabularyChanged { .. }
                | LibraryEvent::ImagesChanged { .. }
                | LibraryEvent::ListStale { .. }
                | LibraryEvent::SafeModeChanged { .. }
                | LibraryEvent::TaskFinished { .. }
        ) | AppNotice::WritableLibraryChanged(_)
            | AppNotice::RegistryChanged
            | AppNotice::LibraryWriteCommitted
            | AppNotice::TagGroupsChanged
            | AppNotice::PersonalApproxChanged
            | AppNotice::CatalogLabelsChanged(_)
            | AppNotice::MainWindowActivated
            | AppNotice::SafeModeCommitted(_)
            | AppNotice::ApplicationSettingsRestored(_)
            | AppNotice::TaggingStatus(_)
    ) {
        app.state::<LibraryState>().workspace_wake.wake();
    }
}

/// 后台状态轮询的退避状态机：无变化时逐档退避到上限，收到变化或复位后回到初始间隔。
#[derive(Debug, Clone, Copy)]
struct PollBackoff {
    step: usize,
}

impl PollBackoff {
    const STEPS_MS: [u64; 4] = [1500, 3000, 5000, 10_000];

    fn new() -> Self {
        Self { step: 0 }
    }

    fn current(self) -> std::time::Duration {
        std::time::Duration::from_millis(Self::STEPS_MS[self.step])
    }

    fn on_change(&mut self) {
        self.step = 0;
    }

    fn on_unchanged(&mut self) {
        if self.step + 1 < Self::STEPS_MS.len() {
            self.step += 1;
        }
    }

    fn reset(&mut self) {
        self.step = 0;
    }
}

fn main_window_active<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(window) = app.get_webview_window(crate::shell::MAIN_WINDOW) else {
        return false;
    };
    window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
}

/// 后台监控的一轮步进：主窗口不可见或最小化时跳过轮询、重置退避并等待唤醒（带兜底重检超时）；
/// 活跃时执行一次状态核对，再按结果退避或等待下一次唤醒。
fn monitor_step(
    wake: &MonitorWake,
    wake_seq: &mut u64,
    backoff: &mut PollBackoff,
    active: bool,
    inactive_wait: std::time::Duration,
    poll: impl FnOnce() -> bool,
) {
    if !active {
        backoff.reset();
        // 主窗口关闭、隐藏或最小化时不碰全局锁，等待窗口恢复/聚焦事件即时唤醒；
        // 保留兜底超时重检窗口状态，防止平台漏发恢复事件时永久沉睡。
        let _ = wake.wait_timeout(wake_seq, inactive_wait);
        return;
    }
    if poll() {
        backoff.on_change();
    } else {
        backoff.on_unchanged();
    }
    if wake.wait_timeout(wake_seq, backoff.current()) {
        backoff.reset();
    }
}

pub(super) fn monitor<R: Runtime>(app: AppHandle<R>) {
    std::thread::Builder::new()
        .name("kinshoko-workspace-events".into())
        .spawn(move || {
            let state = app.state::<LibraryState>();
            let wake = &state.workspace_wake;
            let mut previous = None;
            let mut backoff = PollBackoff::new();
            let mut wake_seq = wake.snapshot();
            loop {
                monitor_step(
                    wake,
                    &mut wake_seq,
                    &mut backoff,
                    main_window_active(&app),
                    INACTIVE_RECHECK,
                    || poll(&app, &mut previous),
                );
            }
        })
        .expect("workspace event monitor");
}

fn poll<R: Runtime>(app: &AppHandle<R>, previous: &mut Option<String>) -> bool {
    let Ok(status) = app
        .state::<LibraryState>()
        .session
        .with_current_lens(CommandError::from, |w, d, c, safe| w.status(d, c, safe))
    else {
        return false;
    };
    if previous.as_ref() == Some(&status.revision) {
        return false;
    }
    *previous = Some(status.revision.clone());
    publish(app, AppNotice::WorkspaceChanged(status));
    true
}
#[tauri::command]
pub(super) async fn workspace_status<R: Runtime>(
    app: AppHandle<R>,
    safe_mode: bool,
) -> Result<WorkspaceStatus, CommandError> {
    verbs::lens(
        app,
        safe_mode,
        Hold::Stable,
        move |workspace, device, catalog| workspace.status(device, catalog, safe_mode),
    )
    .await
}
#[tauri::command]
pub(super) async fn workspace_browse<R: Runtime>(
    app: AppHandle<R>,
    query: WorkspaceQuery,
    safe_mode: bool,
) -> Result<WorkspacePage, CommandError> {
    blocking(move || {
        // 浏览耗时（#183、#313）：记进运行日志，分等资源锁、锁外读占位图与总耗时；core 另有锁里的
        // 分段（#288）。
        let started = std::time::Instant::now();
        // 锁里只取当页的行；占位图在锁外读，读完再按修订号复核（#313）。读盘慢时不拖住缩略图请求。
        // 不用 `Hold::Stable`：`confirm` 自己复核修订号，前后再各取一次状态只是多做几遍核对。
        let state = app.state::<LibraryState>();
        let browse = || -> Result<WorkspacePage, CommandError> {
            let lens = state.safe_mode().lens();
            let mut pending = state.session.with_lens(safe_mode, Hold::Read, |w, d, c| {
                took("浏览：等资源锁", started, None);
                w.browse_rows(d, c, &query, safe_mode)
            })?;
            let reading = std::time::Instant::now();
            pending.fill_placeholders(state.session.gate());
            took("浏览：读占位图", reading, None);
            let page = state
                .session
                .with_lens(safe_mode, Hold::Read, |w, d, c| w.confirm(d, c, pending))?;
            lens.confirm(state.safe_mode())?;
            Ok(page)
        };
        let mut page = browse();
        // Under a steady stream of import commits, a first page can expire on every attempt.
        // Let one browse finish between publications. Old cursors still expire normally.
        if query.cursor.is_none()
            && matches!(&page, Err(error) if error.kind == ErrorKind::CursorExpired)
        {
            let _visibility = state.session.visibility();
            page = browse();
        }
        match &page {
            Ok(page) => took("浏览：一页", started, Some(page.cards.len())),
            Err(_) => took("浏览：失败", started, None),
        }
        page
    })
    .await
}
#[tauri::command]
pub(super) async fn workspace_resolve<R: Runtime>(
    app: AppHandle<R>,
    input: SearchInput,
    lang: String,
    safe_mode: bool,
) -> Result<ConditionTree, CommandError> {
    crate::run_log::record(LogEvent::SearchResolved {
        terms: input.conditions.len().min(u32::MAX as usize) as u32,
    });
    let catalog = app.state::<LibraryState>().search().clone();
    verbs::lens(app, safe_mode, Hold::Stable, move |w, d, c| {
        w.resolve(d, c, &input, &lang, safe_mode, catalog.builtin_approx())
    })
    .await
}
#[tauri::command]
pub(super) async fn workspace_candidates<R: Runtime>(
    app: AppHandle<R>,
    text: String,
    lang: String,
    limit: u32,
    safe_mode: bool,
) -> Result<Vec<Candidate>, CommandError> {
    let catalog = app.state::<LibraryState>().search().clone();
    verbs::lens(app, safe_mode, Hold::Stable, move |w, d, c| {
        w.candidates(
            d,
            c,
            &text,
            &lang,
            limit as usize,
            safe_mode,
            catalog.builtin_approx(),
        )
    })
    .await
}
/// 给 `library_id` 里的图挑标签的候选（#425）。修订号变了不算失败：导入收尾时也要能挑标签。
#[tauri::command]
pub(super) async fn workspace_library_candidates<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    text: String,
    lang: String,
    limit: u32,
    safe_mode: bool,
) -> Result<Vec<Candidate>, CommandError> {
    let catalog = app.state::<LibraryState>().search().clone();
    verbs::lens(app, safe_mode, Hold::Confirmed, move |w, d, c| {
        w.library_candidates(
            d,
            c,
            &library_id,
            &text,
            &lang,
            limit as usize,
            safe_mode,
            catalog.builtin_approx(),
        )
    })
    .await
}
/// Read any registered source without activating it. Safety includes every known byte-identical copy
/// ([`kinshoko_core::WorkspaceSession::visible_source`]).
#[track_caller]
pub(super) fn read<R: Runtime>(
    app: &AppHandle<R>,
    library_id: &str,
    image_id: &str,
) -> Result<Arc<Library>, CommandError> {
    app.state::<LibraryState>()
        .session
        .visible_source(library_id, image_id)
}
/// One authorized image read for the `thumb` protocol (#123, #313). The published snapshot answers
/// without any global lock or reopened provider ([`kinshoko_core::workspace::ImageGate`]); when it
/// cannot (registry, scope or a provider revision moved), the locked path re-checks and republishes.
/// Same safety boundary as [`read`]: registration, identity, global safe-mode veto, unchanged
/// revisions and safe-mode generation. `slow` reports whether the locked path ran.
pub(super) fn read_image<R: Runtime>(
    app: &AppHandle<R>,
    library_id: &str,
    image_id: &str,
    slow: &mut bool,
) -> Result<Arc<Library>, CommandError> {
    let state = app.state::<LibraryState>();
    let lens = state.safe_mode().lens();
    let authorize = || {
        let mode = saved_mode(app);
        state
            .session
            .gate()
            .authorize(library_id, image_id, mode.on, mode.scope)
    };
    let library = match authorize() {
        Some(result) => result?,
        None => {
            let _refresh = lock(&state.image_gate_refresh);
            if let Some(result) = authorize() {
                result?
            } else {
                *slow = true;
                let safe = saved_safe_mode(app);
                state
                    .session
                    .with_lens(safe, Hold::Read, |workspace, device, catalog| {
                        workspace.image_reader(device, catalog, library_id, image_id, safe)
                    })?
            }
        }
    };
    lens.confirm(state.safe_mode())?;
    Ok(library)
}
/// 一张图的详情。详情、标签、文件夹的可见性复核与安全模式封印都在 core（#424）。
#[tauri::command]
pub(super) async fn image<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    image_id: String,
) -> Result<ImageDetail, CommandError> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        state.session.with_resources(|w, d, c| {
            w.image_detail(d, c, state.safe_mode(), &library_id, &image_id)
        })
    })
    .await
}

/// 一张图的标签与统一标签身份，名称按界面语言 `lang`。
#[tauri::command]
pub(super) async fn catalog_image_tags<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    image_id: String,
    lang: String,
) -> Result<CatalogImageTags, CommandError> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        state.session.with_resources(|w, d, c| {
            w.image_tags(d, c, state.safe_mode(), &library_id, &image_id, &lang)
        })
    })
    .await
}

/// 一张图的卡片，与图片墙同样构成（钉图“在 Kinshoko 中打开”用）：查看器里的整理按它核对来源。
#[tauri::command]
pub(super) async fn workspace_card<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    image_id: String,
    safe_mode: bool,
) -> Result<WorkspaceCard, CommandError> {
    verbs::lens(
        app,
        safe_mode,
        Hold::Stable,
        move |workspace, device, catalog| {
            workspace.card(device, catalog, &library_id, &image_id, safe_mode)
        },
    )
    .await
}

#[tauri::command]
pub(super) async fn workspace_tag_groups<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    lang: String,
    safe_mode: bool,
) -> Result<Vec<TagGroupView>, CommandError> {
    verbs::lens(
        app,
        safe_mode,
        Hold::Stable,
        move |workspace, device, catalog| {
            workspace.tag_groups(device, catalog, &library_id, &lang, safe_mode)
        },
    )
    .await
}
#[tauri::command]
pub(super) async fn workspace_sidebar<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    safe_mode: bool,
) -> Result<Sidebar, CommandError> {
    verbs::lens(
        app,
        safe_mode,
        Hold::Stable,
        move |workspace, device, catalog| {
            workspace.sidebar(device, catalog, &library_id, safe_mode)
        },
    )
    .await
}
#[tauri::command]
pub(super) async fn workspace_directories<R: Runtime>(
    app: AppHandle<R>,
    safe_mode: bool,
) -> Result<WorkspaceDirectories, CommandError> {
    verbs::lens(
        app,
        safe_mode,
        Hold::Stable,
        move |workspace, device, catalog| workspace.directories(device, catalog, safe_mode),
    )
    .await
}

#[cfg(test)]
mod tests;
