//! Thin adapter for application-wide approximate judgments.

use super::*;
use kinshoko_core::CommandError;
use kinshoko_core::tag_catalog::{CatalogApproxEdit, CatalogApproxView};
#[tauri::command]
pub(super) async fn shared_personal_approx<R: Runtime>(
    app: AppHandle<R>,
    lang: String,
    safe_mode: bool,
) -> Result<CatalogApproxView, CommandError> {
    blocking(move || {
        with_lens(&app, safe_mode, Hold::Stable, |w, d, c| {
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
) -> Result<(), CommandError> {
    blocking(move || {
        let lens = app
            .state::<LibraryState>()
            .safe_mode
            .lens_expecting(safe_mode)?;
        with_lens(&app, safe_mode, Hold::Read, |w, d, c| {
            w.edit_approx(d, c, &edit, safe_mode)
        })?;
        lens.confirm(&app.state::<LibraryState>().safe_mode)?;
        let status = with_lens(&app, safe_mode, Hold::Read, |w, d, c| {
            w.status(d, c, safe_mode)
        })?;
        let _ = app.emit(workspace::EVENT, status);
        Ok(())
    })
    .await
}
