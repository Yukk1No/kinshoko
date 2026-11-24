//! Workspace adapter: detached provider reads, revisions and global safe-mode boundaries.

use super::*;
use kinshoko_core::CommandError;
use kinshoko_core::diagnostics::took;
use kinshoko_core::workspace::{
    Workspace, WorkspaceCard, WorkspaceDirectories, WorkspacePage, WorkspaceQuery, WorkspaceStatus,
};

pub(super) const EVENT: &str = "workspace-changed";

static MONITOR_WAKE: (std::sync::Mutex<u64>, std::sync::Condvar) =
    (std::sync::Mutex::new(0), std::sync::Condvar::new());

/// 唤醒后台工作区监控线程（例如主窗口重新打开或显示时）。
pub(crate) fn wake_monitor() {
    let (lock, condvar) = &MONITOR_WAKE;
    let mut seq = lock.lock().unwrap_or_else(|e| e.into_inner());
    *seq = seq.wrapping_add(1);
    condvar.notify_all();
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

fn wait_for_wake(seen: &mut u64, timeout: std::time::Duration) -> bool {
    let (lock, condvar) = &MONITOR_WAKE;
    let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let (guard, _) = condvar
        .wait_timeout_while(guard, timeout, |seq| *seq == *seen)
        .unwrap_or_else(|e| e.into_inner());
    if *guard != *seen {
        *seen = *guard;
        true
    } else {
        false
    }
}
/// Acquire device, catalog, then workspace. Callers retain their lens and visibility guards.
#[track_caller]
pub(super) fn with_resources<T>(
    state: &LibraryState,
    f: impl FnOnce(&mut Workspace, &mut DeviceLibraries, &mut TagCatalog) -> Result<T, CatalogError>,
) -> Result<T, CommandError> {
    // 三把锁都记在调用方的位置上（#337）：日志里看得出是哪个命令占着它们。
    let site = std::panic::Location::caller();
    with_libraries_at(state, site, |device| {
        Ok(state
            .search
            .with_catalog_at(site, |catalog| {
                let waiting = std::time::Instant::now();
                let mut slot = lock(&state.workspace);
                let _held = kinshoko_core::diagnostics::HeldLock::acquired("工作区", site, waiting);
                if slot.is_none() {
                    *slot = Some(Workspace::open_with_gate(
                        &state.device_dir,
                        state.gate.clone(),
                    )?);
                }
                f(slot.as_mut().expect("workspace opened"), device, catalog)
            })
            .map_err(CommandError::from))
    })?
}

pub(super) fn monitor<R: Runtime>(app: AppHandle<R>) {
    std::thread::Builder::new()
        .name("kinshoko-workspace-events".into())
        .spawn(move || {
            let mut previous = String::new();
            let mut backoff = PollBackoff::new();
            let mut wake_seq = *MONITOR_WAKE.0.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if !main_window_active(&app) {
                    backoff.reset();
                    let _ = wait_for_wake(&mut wake_seq, std::time::Duration::from_secs(10));
                    continue;
                }
                let safe = saved_safe_mode(&app);
                let mut changed = false;
                if let Ok(status) =
                    with_lens(&app, safe, Hold::Read, |w, d, c| w.status(d, c, safe))
                    && status.revision != previous
                {
                    previous = status.revision.clone();
                    let _ = app.emit(EVENT, status);
                    changed = true;
                }
                if changed {
                    backoff.on_change();
                } else {
                    backoff.on_unchanged();
                }
                if wait_for_wake(&mut wake_seq, backoff.current()) {
                    backoff.reset();
                }
            }
        })
        .expect("workspace event monitor");
}
#[tauri::command]
pub(super) async fn workspace_status<R: Runtime>(
    app: AppHandle<R>,
    safe_mode: bool,
) -> Result<WorkspaceStatus, CommandError> {
    blocking(move || {
        with_lens(&app, safe_mode, Hold::Stable, |w, d, c| {
            w.status(d, c, safe_mode)
        })
    })
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
            let lens = state.safe_mode.lens();
            let mut pending = with_lens(&app, safe_mode, Hold::Read, |w, d, c| {
                took("浏览：等资源锁", started, None);
                w.browse_rows(d, c, &query, safe_mode)
            })?;
            let reading = std::time::Instant::now();
            pending.fill_placeholders(&state.gate);
            took("浏览：读占位图", reading, None);
            let page = with_lens(&app, safe_mode, Hold::Read, |w, d, c| {
                w.confirm(d, c, pending)
            })?;
            lens.confirm(&state.safe_mode)?;
            Ok(page)
        };
        let mut page = browse();
        // Under a steady stream of import commits, a first page can expire on every attempt.
        // Let one browse finish between publications. Old cursors still expire normally.
        if query.cursor.is_none()
            && matches!(&page, Err(error) if error.kind == ErrorKind::CursorExpired)
        {
            let _visibility = lock(&state.visibility_commit);
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
    blocking(move || {
        let catalog = app.state::<LibraryState>().search.clone();
        with_lens(&app, safe_mode, Hold::Stable, |w, d, c| {
            w.resolve(d, c, &input, &lang, safe_mode, catalog.builtin_approx())
        })
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
    blocking(move || {
        let catalog = app.state::<LibraryState>().search.clone();
        with_lens(&app, safe_mode, Hold::Stable, |w, d, c| {
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
    blocking(move || {
        let catalog = app.state::<LibraryState>().search.clone();
        with_lens(&app, safe_mode, Hold::Confirmed, |w, d, c| {
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
    })
    .await
}
/// Read any registered source without activating it. Safety includes every known byte-identical copy.
pub(super) fn read<R: Runtime>(
    app: &AppHandle<R>,
    library_id: &str,
    image_id: &str,
) -> Result<Arc<Library>, CommandError> {
    let safe = saved_safe_mode(app);
    with_lens(app, safe, Hold::Stable, |workspace, device, catalog| {
        if !workspace.contains(device, catalog, library_id, image_id, safe)? {
            return Err(kinshoko_core::library::Error::UnknownImage.into());
        }
        let library = device
            .read(library_id)
            .map_err(|e| CatalogError::Command(Box::new(e.into())))?;
        library.set_safe_mode(safe);
        Ok(library)
    })
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
    let lens = state.safe_mode.lens();
    let authorize = || {
        let mode = saved_mode(app);
        state
            .gate
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
                with_lens(app, safe, Hold::Read, |workspace, device, catalog| {
                    workspace.image_reader(device, catalog, library_id, image_id, safe)
                })?
            }
        }
    };
    lens.confirm(&state.safe_mode)?;
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
        with_resources(&state, |w, d, c| {
            w.image_detail(d, c, &state.safe_mode, &library_id, &image_id)
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
        with_resources(&state, |w, d, c| {
            w.image_tags(d, c, &state.safe_mode, &library_id, &image_id, &lang)
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
    blocking(move || {
        with_lens(&app, safe_mode, Hold::Stable, |w, d, c| {
            w.card(d, c, &library_id, &image_id, safe_mode)
        })
    })
    .await
}

#[tauri::command]
pub(super) async fn workspace_tag_groups<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    lang: String,
    safe_mode: bool,
) -> Result<Vec<TagGroupView>, CommandError> {
    blocking(move || {
        with_lens(&app, safe_mode, Hold::Stable, |w, d, c| {
            w.tag_groups(d, c, &library_id, &lang, safe_mode)
        })
    })
    .await
}
#[tauri::command]
pub(super) async fn workspace_sidebar<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    safe_mode: bool,
) -> Result<Sidebar, CommandError> {
    blocking(move || {
        with_lens(&app, safe_mode, Hold::Stable, |w, d, c| {
            w.sidebar(d, c, &library_id, safe_mode)
        })
    })
    .await
}
#[tauri::command]
pub(super) async fn workspace_directories<R: Runtime>(
    app: AppHandle<R>,
    safe_mode: bool,
) -> Result<WorkspaceDirectories, CommandError> {
    blocking(move || {
        with_lens(&app, safe_mode, Hold::Stable, |w, d, c| {
            w.directories(d, c, safe_mode)
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::PollBackoff;
    use std::time::Duration;

    #[test]
    fn poll_backoff_ramps_to_cap_and_resets_on_change_or_wake() {
        let mut backoff = PollBackoff::new();
        assert_eq!(backoff.current(), Duration::from_millis(1500));

        backoff.on_unchanged();
        assert_eq!(backoff.current(), Duration::from_millis(3000));
        backoff.on_unchanged();
        assert_eq!(backoff.current(), Duration::from_millis(5000));
        backoff.on_unchanged();
        assert_eq!(backoff.current(), Duration::from_millis(10_000));
        backoff.on_unchanged();
        assert_eq!(backoff.current(), Duration::from_millis(10_000));

        backoff.on_change();
        assert_eq!(backoff.current(), Duration::from_millis(1500));

        backoff.on_unchanged();
        backoff.on_unchanged();
        assert_eq!(backoff.current(), Duration::from_millis(5000));
        backoff.reset();
        assert_eq!(backoff.current(), Duration::from_millis(1500));
    }
}
