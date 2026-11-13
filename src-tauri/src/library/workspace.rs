//! Workspace adapter: detached provider reads, revisions and global safe-mode boundaries.

use super::*;
use kinshoko_core::CommandError;
use kinshoko_core::diagnostics::took;
use kinshoko_core::workspace::{
    Workspace, WorkspaceCard, WorkspaceDirectories, WorkspacePage, WorkspaceQuery, WorkspaceStatus,
};

pub(super) const EVENT: &str = "workspace-changed";
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
            loop {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                let safe = saved_safe_mode(&app);
                if let Ok(status) =
                    with_lens(&app, safe, Hold::Read, |w, d, c| w.status(d, c, safe))
                    && status.revision != previous
                {
                    previous = status.revision.clone();
                    let _ = app.emit(EVENT, status);
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
        let lens = state.safe_mode.lens();
        let pending = with_lens(&app, safe_mode, Hold::Read, |w, d, c| {
            took("浏览：等资源锁", started, None);
            w.browse_rows(d, c, &query, safe_mode)
        });
        let page = pending.and_then(|mut pending| {
            let reading = std::time::Instant::now();
            pending.fill_placeholders(&state.gate);
            took("浏览：读占位图", reading, None);
            let page = with_lens(&app, safe_mode, Hold::Read, |w, d, c| {
                w.confirm(d, c, pending)
            })?;
            lens.confirm(&state.safe_mode)?;
            Ok(page)
        });
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
    let mode = saved_mode(app);
    let library = match state
        .gate
        .authorize(library_id, image_id, mode.on, mode.scope)
    {
        Some(result) => result.map_err(CommandError::from)?,
        None => {
            *slow = true;
            with_lens(app, mode.on, Hold::Read, |workspace, device, catalog| {
                workspace.image_reader(device, catalog, library_id, image_id, mode.on)
            })?
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
