//! 导入预览的命令：参数翻译与逐块转发，流程与可见性复核在
//! [`kinshoko_core::WorkspaceSession::read_import_preview`] 等方法里。

use super::*;
use kinshoko_core::CommandError;
use kinshoko_core::workspace::ImportPreviewSession;

#[tauri::command]
pub(super) async fn open_import_preview<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    task_id: String,
) -> Result<ImportPreviewSession, CommandError> {
    let grant = app.state::<LibraryState>().session.begin_import_preview();
    blocking(move || {
        app.state::<LibraryState>()
            .session
            .open_import_preview(grant?, &library_id, &task_id)
    })
    .await
}
#[tauri::command]
pub(super) async fn close_import_preview<R: Runtime>(
    app: AppHandle<R>,
    session_id: Option<String>,
) -> Result<(), CommandError> {
    blocking(move || {
        app.state::<LibraryState>()
            .session
            .close_import_preview(session_id.as_deref());
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
        app.state::<LibraryState>().session.read_import_preview(
            grant?,
            &session_id,
            &item_id,
            target_px,
            |chunk| {
                on_chunk
                    .send(tauri::ipc::Response::new(chunk.to_vec()))
                    .map_err(|error| CatalogError::Io(std::io::Error::other(error.to_string())))
            },
        )
    })
    .await
}
pub(super) fn receipts<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<kinshoko_core::ImportTaskSnapshot>, CommandError> {
    app.state::<LibraryState>()
        .session
        .with_current_lens(CommandError::from, |w, d, c, safe| {
            w.import_receipts(d, c, safe)
        })
}
