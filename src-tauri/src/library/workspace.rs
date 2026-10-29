//! Workspace adapter: detached provider reads, revisions and global safe-mode boundaries.
use super::*;
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
) -> Result<T, String> {
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
            .map_err(|e| e.to_string()))
    })?
}

#[track_caller]
pub(super) fn action<R: Runtime, T>(
    app: &AppHandle<R>,
    safe: bool,
    f: impl FnOnce(&mut Workspace, &DeviceLibraries, &mut TagCatalog) -> Result<T, CatalogError>,
) -> Result<T, String> {
    let state = app.state::<LibraryState>();
    if saved_safe_mode(app) != safe {
        return Err(kinshoko_core::library::Error::LensChanged.to_string());
    }
    with_resources(&state, |workspace, device, catalog| {
        f(workspace, device, catalog)
    })
}
pub(super) fn generation<R: Runtime>(app: &AppHandle<R>) -> SafeModeSnapshot {
    app.state::<LibraryState>().safe_mode.snapshot()
}
pub(super) fn current<R: Runtime>(
    app: &AppHandle<R>,
    safe: bool,
    expected: SafeModeSnapshot,
) -> Result<(), String> {
    if !app.state::<LibraryState>().safe_mode.still(&expected) || saved_safe_mode(app) != safe {
        Err(kinshoko_core::library::Error::LensChanged.to_string())
    } else {
        Ok(())
    }
}
/// [`action`] 加上代次复核：做完时安全模式变过就丢弃结果。
#[track_caller]
pub(super) fn guarded<R: Runtime, T>(
    app: &AppHandle<R>,
    safe: bool,
    f: impl FnOnce(&mut Workspace, &DeviceLibraries, &mut TagCatalog) -> Result<T, CatalogError>,
) -> Result<T, String> {
    let expected = generation(app);
    let value = action(app, safe, f)?;
    current(app, safe, expected)?;
    Ok(value)
}
/// [`guarded`] 再加上前后修订号复核，给自己不复核修订号的读取用。
#[track_caller]
pub(super) fn stable<R: Runtime, T>(
    app: &AppHandle<R>,
    safe: bool,
    f: impl FnOnce(&mut Workspace, &DeviceLibraries, &mut TagCatalog) -> Result<T, CatalogError>,
) -> Result<T, String> {
    guarded(app, safe, |workspace, device, catalog| {
        let before = workspace.status(device, catalog, safe)?;
        let value = f(workspace, device, catalog)?;
        let after = workspace.status(device, catalog, safe)?;
        if before.revision != after.revision {
            return Err(kinshoko_core::library::Error::CursorExpired.into());
        }
        Ok(value)
    })
}
pub(super) fn monitor<R: Runtime>(app: AppHandle<R>) {
    std::thread::Builder::new()
        .name("kinshoko-workspace-events".into())
        .spawn(move || {
            let mut previous = String::new();
            loop {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                let safe = saved_safe_mode(&app);
                if let Ok(status) = action(&app, safe, |w, d, c| w.status(d, c, safe))
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
) -> Result<WorkspaceStatus, String> {
    blocking(move || stable(&app, safe_mode, |w, d, c| w.status(d, c, safe_mode))).await
}
#[tauri::command]
pub(super) async fn workspace_browse<R: Runtime>(
    app: AppHandle<R>,
    query: WorkspaceQuery,
    safe_mode: bool,
) -> Result<WorkspacePage, String> {
    blocking(move || {
        // 浏览耗时（#183、#313）：记进运行日志，分等资源锁、锁外读占位图与总耗时；core 另有锁里的
        // 分段（#288）。
        let started = std::time::Instant::now();
        // 锁里只取当页的行；占位图在锁外读，读完再按修订号复核（#313）。读盘慢时不拖住缩略图请求。
        // 不用 `stable`：`confirm` 自己复核修订号，前后再各取一次状态只是多做几遍核对。
        let expected = generation(&app);
        let pending = action(&app, safe_mode, |w, d, c| {
            took("浏览：等资源锁", started, None);
            w.browse_rows(d, c, &query, safe_mode)
        });
        let page = pending.and_then(|mut pending| {
            let reading = std::time::Instant::now();
            pending.fill_placeholders(&app.state::<LibraryState>().gate);
            took("浏览：读占位图", reading, None);
            let page = action(&app, safe_mode, |w, d, c| w.confirm(d, c, pending))?;
            current(&app, safe_mode, expected)?;
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
) -> Result<ConditionTree, String> {
    blocking(move || {
        let catalog = app.state::<LibraryState>().search.clone();
        stable(&app, safe_mode, |w, d, c| {
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
) -> Result<Vec<Candidate>, String> {
    blocking(move || {
        let catalog = app.state::<LibraryState>().search.clone();
        stable(&app, safe_mode, |w, d, c| {
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
/// Read any registered source without activating it. Safety includes every known byte-identical copy.
pub(super) fn read<R: Runtime>(
    app: &AppHandle<R>,
    library_id: &str,
    image_id: &str,
) -> Result<Arc<Library>, String> {
    let safe = saved_safe_mode(app);
    stable(app, safe, |workspace, device, catalog| {
        if !workspace.contains(device, catalog, library_id, image_id, safe)? {
            return Err(kinshoko_core::library::Error::UnknownImage.into());
        }
        let library = device
            .read(library_id)
            .map_err(|e| CatalogError::Io(std::io::Error::other(e.to_string())))?;
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
) -> Result<Arc<Library>, String> {
    let state = app.state::<LibraryState>();
    let expected = generation(app);
    let mode = saved_mode(app);
    let library = match state
        .gate
        .authorize(library_id, image_id, mode.on, mode.scope)
    {
        Some(result) => result.map_err(|e| e.to_string())?,
        None => {
            *slow = true;
            action(app, mode.on, |workspace, device, catalog| {
                workspace.image_reader(device, catalog, library_id, image_id, mode.on)
            })?
        }
    };
    current(app, mode.on, expected)?;
    Ok(library)
}
#[tauri::command]
pub(super) async fn workspace_image<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    image_id: String,
) -> Result<ImageDetail, String> {
    blocking(move || {
        let safe = saved_safe_mode(&app);
        let expected = generation(&app);
        let library = read(&app, &library_id, &image_id)?;
        let image = library.image(&image_id).map_err(|e| e.to_string())?;
        current(&app, safe, expected)?;
        // A rating/provider change during the detail read cannot release a stale image.
        read(&app, &library_id, &image_id)?;
        Ok(image)
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
) -> Result<WorkspaceCard, String> {
    blocking(move || {
        stable(&app, safe_mode, |w, d, c| {
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
) -> Result<Vec<TagGroupView>, String> {
    blocking(move || {
        stable(&app, safe_mode, |w, d, c| {
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
) -> Result<Sidebar, String> {
    blocking(move || {
        stable(&app, safe_mode, |w, d, c| {
            w.sidebar(d, c, &library_id, safe_mode)
        })
    })
    .await
}
#[tauri::command]
pub(super) async fn workspace_local_tags<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    ids: Vec<String>,
    safe_mode: bool,
) -> Result<Vec<String>, String> {
    blocking(move || {
        stable(&app, safe_mode, |w, d, c| {
            w.local_tags(d, c, &library_id, &ids, safe_mode)
        })
    })
    .await
}

#[tauri::command]
pub(super) async fn workspace_directories<R: Runtime>(
    app: AppHandle<R>,
    safe_mode: bool,
) -> Result<WorkspaceDirectories, String> {
    blocking(move || stable(&app, safe_mode, |w, d, c| w.directories(d, c, safe_mode))).await
}
