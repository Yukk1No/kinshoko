//! Workspace adapter: detached provider reads, revisions and global safe-mode boundaries.
use super::*;
use kinshoko_core::workspace::{
    Workspace, WorkspaceDirectories, WorkspacePage, WorkspaceQuery, WorkspaceStatus,
};

pub(super) const EVENT: &str = "workspace-changed";
pub(super) fn action<R: Runtime, T>(
    app: &AppHandle<R>,
    safe: bool,
    f: impl FnOnce(&mut Workspace, &DeviceLibraries, &mut TagCatalog) -> Result<T, CatalogError>,
) -> Result<T, String> {
    let state = app.state::<LibraryState>();
    if saved_safe_mode(app) != safe {
        return Err(kinshoko_core::library::Error::LensChanged.to_string());
    }
    with_libraries(&state.device_dir, &state.libraries, |device| {
        Ok(with_catalog(&state.device_dir, &state.catalog, |catalog| {
            let mut slot = lock(&state.workspace);
            if slot.is_none() {
                *slot = Some(Workspace::open(&state.device_dir)?);
            }
            f(slot.as_mut().expect("workspace opened"), device, catalog)
        }))
    })?
}
pub(super) fn generation<R: Runtime>(app: &AppHandle<R>) -> u64 {
    app.state::<LibraryState>()
        .safe_mode_generation
        .load(Ordering::SeqCst)
}
pub(super) fn current<R: Runtime>(
    app: &AppHandle<R>,
    safe: bool,
    expected: u64,
) -> Result<(), String> {
    if generation(app) != expected || saved_safe_mode(app) != safe {
        Err(kinshoko_core::library::Error::LensChanged.to_string())
    } else {
        Ok(())
    }
}
pub(super) fn stable<R: Runtime, T>(
    app: &AppHandle<R>,
    safe: bool,
    f: impl FnOnce(&mut Workspace, &DeviceLibraries, &mut TagCatalog) -> Result<T, CatalogError>,
) -> Result<T, String> {
    let expected = generation(app);
    let value = action(app, safe, |workspace, device, catalog| {
        let before = workspace.status(device, catalog, safe)?;
        let value = f(workspace, device, catalog)?;
        let after = workspace.status(device, catalog, safe)?;
        if before.revision != after.revision {
            return Err(kinshoko_core::library::Error::CursorExpired.into());
        }
        Ok(value)
    })?;
    current(app, safe, expected)?;
    Ok(value)
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
    blocking(move || stable(&app, safe_mode, |w, d, c| w.browse(d, c, &query, safe_mode))).await
}
#[tauri::command]
pub(super) async fn workspace_resolve<R: Runtime>(
    app: AppHandle<R>,
    input: SearchInput,
    lang: String,
    safe_mode: bool,
) -> Result<ConditionTree, String> {
    blocking(move || {
        let builtin = app.state::<LibraryState>().builtin_approx.clone();
        stable(&app, safe_mode, |w, d, c| {
            w.resolve(d, c, &input, &lang, safe_mode, &builtin)
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
        let builtin = app.state::<LibraryState>().builtin_approx.clone();
        stable(&app, safe_mode, |w, d, c| {
            w.candidates(d, c, &text, &lang, limit as usize, safe_mode, &builtin)
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
