//! Decode outside resource locks; validate and publish only within the shared revocation permit.
use super::*;
use kinshoko_core::workspace::{ImportPreviewSession, Workspace};

fn action<R: Runtime, T>(
    app: &AppHandle<R>,
    f: impl FnOnce(&mut Workspace, &mut DeviceLibraries, &mut TagCatalog) -> Result<T, CatalogError>,
) -> Result<T, String> {
    let state = app.state::<LibraryState>();
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
// Caller holds the visibility permit, except for the window-destruction dispatch fence.
pub(super) fn revoke<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<LibraryState>();
    state
        .import_preview_generation
        .fetch_add(1, Ordering::SeqCst);
    if let Some(device) = lock(&state.libraries).as_mut() {
        device.close_import_preview(None);
    }
}
#[tauri::command]
pub(super) async fn open_import_preview<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    task_id: String,
) -> Result<ImportPreviewSession, String> {
    let generation = with_visibility_commit(&app, |_| {
        app.state::<LibraryState>()
            .import_preview_generation
            .fetch_add(1, Ordering::SeqCst)
            + 1
    });
    let mode_generation = workspace::generation(&app);
    blocking(move || {
        with_visibility_commit(&app, |_| {
            workspace::current(&app, true, mode_generation)?;
            if app
                .state::<LibraryState>()
                .import_preview_generation
                .load(Ordering::SeqCst)
                != generation
            {
                return Err(kinshoko_core::library::Error::LensChanged.to_string());
            }
            let session = action(&app, |w, d, c| {
                w.open_import_preview(d, c, &library_id, &task_id, true)
            })?;
            if app
                .state::<LibraryState>()
                .import_preview_generation
                .load(Ordering::SeqCst)
                != generation
                || workspace::current(&app, true, mode_generation).is_err()
            {
                let state = app.state::<LibraryState>();
                if let Some(device) = lock(&state.libraries).as_mut() {
                    device.close_import_preview(Some(&session.id));
                }
                return Err(kinshoko_core::library::Error::LensChanged.to_string());
            }
            Ok(session)
        })
    })
    .await
}
#[tauri::command]
pub(super) async fn close_import_preview<R: Runtime>(
    app: AppHandle<R>,
    session_id: Option<String>,
) -> Result<(), String> {
    blocking(move || {
        with_visibility_commit(&app, |_| {
            let state = app.state::<LibraryState>();
            // A late close for an older session must not revoke newer explicit consent.
            let revoked = lock(&state.libraries)
                .as_mut()
                .is_some_and(|device| device.close_import_preview(session_id.as_deref()));
            if revoked || session_id.is_none() {
                state
                    .import_preview_generation
                    .fetch_add(1, Ordering::SeqCst);
            }
            Ok(())
        })
    })
    .await
}
#[tauri::command]
pub(super) async fn read_import_preview<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    item_id: String,
    target_px: u32,
    on_chunk: tauri::ipc::Channel<tauri::ipc::Response>,
) -> Result<(), String> {
    let generation = app
        .state::<LibraryState>()
        .import_preview_generation
        .load(Ordering::SeqCst);
    let mode_generation = workspace::generation(&app);
    blocking(move || {
        workspace::current(&app, true, mode_generation)?;
        let request = action(&app, |w, d, c| {
            w.prepare_import_preview(d, c, &session_id, &item_id, true, target_px)
        })?;
        let resolved = request.resolve().map_err(|error| error.to_string())?;
        let content = with_visibility_commit(&app, |current_mode_generation| {
            if current_mode_generation != mode_generation {
                return Err(kinshoko_core::library::Error::LensChanged.to_string());
            }
            workspace::current(&app, true, mode_generation)?;
            action(&app, |w, d, c| {
                w.complete_import_preview(d, c, resolved, true)
            })
        })?;
        let mut offset = 0;
        loop {
            let is_end = offset == content.bytes().len();
            offset = with_visibility_commit(&app, |current_mode_generation| {
                if current_mode_generation != mode_generation
                    || app
                        .state::<LibraryState>()
                        .import_preview_generation
                        .load(Ordering::SeqCst)
                        != generation
                {
                    return Err(kinshoko_core::library::Error::LensChanged.to_string());
                }
                workspace::current(&app, true, mode_generation)?;
                let state = app.state::<LibraryState>();
                with_libraries(&state.device_dir, &state.libraries, |device| {
                    Ok(
                        device.commit_import_preview_chunk(&content, offset, 1023, true, |chunk| {
                            on_chunk
                                .send(tauri::ipc::Response::new(chunk.to_vec()))
                                .map_err(|error| {
                                    CatalogError::Io(std::io::Error::other(error.to_string()))
                                })
                        }),
                    )
                })?
                .map_err(|error| error.to_string())
            })?;
            if is_end {
                return Ok(());
            }
            // The permit and all resource locks end after each bounded publication.
            // Let a waiting close/context/mode command revoke before the next chunk.
            std::thread::yield_now();
        }
    })
    .await
}
pub(super) fn receipts<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<kinshoko_core::ImportTaskSnapshot>, String> {
    let safe = saved_safe_mode(app);
    let expected = workspace::generation(app);
    let receipts = action(app, |w, d, c| w.import_receipts(d, c, safe))?;
    workspace::current(app, safe, expected)?;
    Ok(receipts)
}
