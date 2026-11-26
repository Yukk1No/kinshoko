//! Decode outside resource locks; validate and publish only within the shared visibility permit
//! ([`VisibilityPermit::commit_with`], [`VisibilityPermit::stream`]).

use super::*;
use kinshoko_core::CommandError;
use kinshoko_core::VisibilityPermit;
use kinshoko_core::workspace::ImportPreviewSession;
use std::ops::ControlFlow;

/// 每次进门发送的预览字节数：块与块之间出门，等着的关闭、作废与安全模式提交可以先进门。
const PREVIEW_CHUNK_BYTES: usize = 1023;

#[tauri::command]
pub(super) async fn open_import_preview<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    task_id: String,
) -> Result<ImportPreviewSession, CommandError> {
    let grant = with_visibility_commit(&app, |permit| permit.begin_import_preview());
    blocking(move || {
        let state = app.state::<LibraryState>();
        let grant = grant?;
        VisibilityPermit::commit_with(
            &state.session,
            grant,
            || Ok::<_, CommandError>(()),
            |permit, ()| {
                let session = workspace::with_resources(&state, |w, d, c| {
                    w.open_import_preview(d, c, &library_id, &task_id, true)
                })?;
                // 窗口线程不进门就能作废（`revoke_import_preview_context`）：打开之后再复核一次。
                if permit.confirm(&grant).is_err() {
                    permit.close_import_preview(Some(&session.id));
                    return Err(kinshoko_core::library::Error::LensChanged.into());
                }
                Ok(session)
            },
        )
    })
    .await
}
#[tauri::command]
pub(super) async fn close_import_preview<R: Runtime>(
    app: AppHandle<R>,
    session_id: Option<String>,
) -> Result<(), CommandError> {
    blocking(move || {
        // A late close for an older session must not revoke newer explicit consent.
        with_visibility_commit(&app, |permit| {
            permit.close_import_preview(session_id.as_deref());
        });
        Ok(())
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
    let grant = app.state::<LibraryState>().session.import_preview_grant();
    blocking(move || {
        let state = app.state::<LibraryState>();
        let grant = grant?;
        grant.lens().confirm(state.safe_mode())?;
        let content = VisibilityPermit::commit_with(
            &state.session,
            grant,
            || {
                let request = workspace::with_resources(&state, |w, d, c| {
                    w.prepare_import_preview(d, c, &session_id, &item_id, true, target_px)
                })?;
                request.resolve().map_err(CommandError::from)
            },
            |_, resolved| {
                workspace::with_resources(&state, |w, d, c| {
                    w.complete_import_preview(d, c, resolved, true)
                })
            },
        )?;
        let mut offset = 0;
        VisibilityPermit::stream(&state.session, grant, |_| {
            let is_end = offset == content.bytes().len();
            offset = with_libraries(&state, |device| {
                Ok(device.commit_import_preview_chunk(
                    &content,
                    offset,
                    PREVIEW_CHUNK_BYTES,
                    true,
                    |chunk| {
                        on_chunk
                            .send(tauri::ipc::Response::new(chunk.to_vec()))
                            .map_err(|error| {
                                CatalogError::Io(std::io::Error::other(error.to_string()))
                            })
                    },
                ))
            })?
            .map_err(CommandError::from)?;
            Ok(if is_end {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            })
        })
    })
    .await
}
pub(super) fn receipts<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<kinshoko_core::ImportTaskSnapshot>, CommandError> {
    let state = app.state::<LibraryState>();
    let lens = state.safe_mode().lens();
    let receipts = workspace::with_resources(&state, |w, d, c| w.import_receipts(d, c, lens.on()))?;
    lens.confirm(state.safe_mode())?;
    Ok(receipts)
}
