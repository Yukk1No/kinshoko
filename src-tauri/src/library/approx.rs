//! Thin adapter for application-wide approximate judgments.
use super::*;
use kinshoko_core::tag_catalog::{CatalogApproxEdit, CatalogApproxView};
#[tauri::command]
pub(super) async fn shared_personal_approx<R: Runtime>(
    app: AppHandle<R>,
    lang: String,
    safe_mode: bool,
) -> Result<CatalogApproxView, String> {
    blocking(move || {
        workspace::stable(&app, safe_mode, |w, d, c| {
            w.personal_approx(d, c, &lang, safe_mode)
        })
    })
    .await
}
#[tauri::command]
pub(super) async fn edit_shared_approx<R: Runtime>(
    app: AppHandle<R>,
    edit: CatalogApproxEdit,
    safe_mode: bool,
) -> Result<(), String> {
    blocking(move || {
        let generation = workspace::generation(&app);
        workspace::current(&app, safe_mode, generation)?;
        workspace::action(&app, safe_mode, |w, d, c| {
            w.edit_approx(d, c, &edit, safe_mode)
        })?;
        workspace::current(&app, safe_mode, generation)?;
        let status = workspace::action(&app, safe_mode, |w, d, c| w.status(d, c, safe_mode))?;
        let _ = app.emit(workspace::EVENT, status);
        Ok(())
    })
    .await
}
