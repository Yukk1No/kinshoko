//! Decode outside resource locks; validate and publish only within the shared revocation permit.

use super::*;
use kinshoko_core::CommandError;
use kinshoko_core::workspace::ImportPreviewSession;

// Caller holds the visibility permit, except for the window-destruction dispatch fence.
pub(super) fn revoke<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<LibraryState>();
    state
        .import_preview_generation
        .fetch_add(1, Ordering::SeqCst);
    if let Some(device) = lock_libraries(&state).as_mut() {
        device.close_import_preview(None);
    }
}
#[tauri::command]
pub(super) async fn open_import_preview<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    task_id: String,
) -> Result<ImportPreviewSession, CommandError> {
    let generation = with_visibility_commit(&app, |_| {
        app.state::<LibraryState>()
            .import_preview_generation
            .fetch_add(1, Ordering::SeqCst)
            + 1
    });
    let lens = app.state::<LibraryState>().safe_mode.lens_expecting(true);
    blocking(move || {
        with_visibility_commit(&app, |_| {
            let state = app.state::<LibraryState>();
            let lens = lens?;
            lens.confirm(&state.safe_mode)?;
            if state.import_preview_generation.load(Ordering::SeqCst) != generation {
                return Err(kinshoko_core::library::Error::LensChanged.into());
            }
            let session = workspace::with_resources(&state, |w, d, c| {
                w.open_import_preview(d, c, &library_id, &task_id, true)
            })?;
            if state.import_preview_generation.load(Ordering::SeqCst) != generation
                || lens.confirm(&state.safe_mode).is_err()
            {
                if let Some(device) = lock_libraries(&state).as_mut() {
                    device.close_import_preview(Some(&session.id));
                }
                return Err(kinshoko_core::library::Error::LensChanged.into());
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
) -> Result<(), CommandError> {
    blocking(move || {
        with_visibility_commit(&app, |_| {
            let state = app.state::<LibraryState>();
            // A late close for an older session must not revoke newer explicit consent.
            let revoked = lock_libraries(&state)
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
) -> Result<(), CommandError> {
    let generation = app
        .state::<LibraryState>()
        .import_preview_generation
        .load(Ordering::SeqCst);
    let lens = app.state::<LibraryState>().safe_mode.lens_expecting(true);
    blocking(move || {
        let state = app.state::<LibraryState>();
        let lens = lens?;
        lens.confirm(&state.safe_mode)?;
        let request = workspace::with_resources(&state, |w, d, c| {
            w.prepare_import_preview(d, c, &session_id, &item_id, true, target_px)
        })?;
        let resolved = request.resolve().map_err(CommandError::from)?;
        let content = with_visibility_commit(&app, |_| {
            lens.confirm(&state.safe_mode)?;
            workspace::with_resources(&state, |w, d, c| {
                w.complete_import_preview(d, c, resolved, true)
            })
        })?;
        let mut offset = 0;
        loop {
            let is_end = offset == content.bytes().len();
            offset = with_visibility_commit(&app, |_| {
                if state.import_preview_generation.load(Ordering::SeqCst) != generation {
                    return Err(kinshoko_core::library::Error::LensChanged.into());
                }
                lens.confirm(&state.safe_mode)?;
                with_libraries(&state, |device| {
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
                .map_err(CommandError::from)
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
) -> Result<Vec<kinshoko_core::ImportTaskSnapshot>, CommandError> {
    let state = app.state::<LibraryState>();
    let lens = state.safe_mode.lens();
    let receipts = workspace::with_resources(&state, |w, d, c| w.import_receipts(d, c, lens.on()))?;
    lens.confirm(&state.safe_mode)?;
    Ok(receipts)
}
