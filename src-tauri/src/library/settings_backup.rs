//! Settings package adapter: live shell, catalog invalidation and OS registrations.
use super::*;
use kinshoko_core::application_settings_backup::{
    ApplicationSettingsBackup, ApplicationSettingsPreview, ApplicationSettingsRestored,
};
#[tauri::command]
pub(super) async fn pick_application_settings<R: Runtime>(
    app: AppHandle<R>,
    save: bool,
) -> Result<Option<PathBuf>, String> {
    blocking(move || {
        let picker = app
            .dialog()
            .file()
            .add_filter("程序设置备份", &["kinshoko-settings"]);
        Ok(if save {
            picker
                .set_file_name("Kinshoko.kinshoko-settings")
                .blocking_save_file()
        } else {
            picker.blocking_pick_file()
        }
        .and_then(|file| file.into_path().ok()))
    })
    .await
}
#[tauri::command]
pub(super) async fn export_application_settings<R: Runtime>(
    app: AppHandle<R>,
    path: PathBuf,
) -> Result<(), String> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        let _transition = lock(&state.transition);
        with_catalog(&state.device_dir, &state.catalog, |catalog| {
            let shell_state = app.state::<ShellState>();
            let shell = lock(&shell_state.0);
            Ok(ApplicationSettingsBackup::export(
                &shell.settings,
                catalog,
                &path,
            ))
        })?
    })
    .await
}
#[tauri::command]
pub(super) async fn preview_application_settings(
    path: PathBuf,
) -> Result<ApplicationSettingsPreview, String> {
    blocking(move || ApplicationSettingsBackup::inspect(&path)).await
}
#[tauri::command]
pub(super) async fn restore_application_settings<R: Runtime>(
    app: AppHandle<R>,
    path: PathBuf,
    fingerprint: String,
) -> Result<ApplicationSettingsRestored, String> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        let _transition = lock(&state.transition);
        let _visibility = lock(&state.visibility_commit);
        // Invalidate before waiting for catalog readers; keep final sends/copies excluded
        // through the replacement and desktop reset, even when the mode stays the same.
        state.safe_mode_generation.fetch_add(1, Ordering::SeqCst);
        let (view, safe, model, mut problems) =
            with_catalog(&state.device_dir, &state.catalog, |catalog| {
                let shell_state = app.state::<ShellState>();
                let mut shell = lock(&shell_state.0);
                let previous = shell.settings.clone();
                let result = ApplicationSettingsBackup::restore_checked(
                    &mut shell.settings,
                    catalog,
                    &path,
                    &fingerprint,
                );
                if let Err(error) = result {
                    return Ok(Err(error));
                }
                state.safe_mode_generation.fetch_add(1, Ordering::SeqCst);
                let crate::shell::Shell {
                    settings,
                    shortcuts,
                } = &mut *shell;
                shortcuts.reload(&previous, settings);
                let mut problems = Vec::new();
                if let Err(error) = crate::shell::apply_autostart(&app, settings.autostart()) {
                    problems.push(format!("开机自启未同步：{error}"));
                }
                Ok(Ok((
                    shortcuts.settings_view(settings),
                    settings.safe_mode(),
                    settings.tagging_model().map(str::to_owned),
                    problems,
                )))
            })??;
        state.search.invalidate();
        state.search_catalog_revision.store(-1, Ordering::SeqCst);
        *lock(&state.workspace) = None;
        *lock(&state.external_vocabulary) = None;
        state.detached.clear();
        if let Ok(library) = state.active() {
            library.set_safe_mode(safe);
        }
        app.state::<crate::diagnostics::UsageState>()
            .0
            .set_enabled(view.usage_log);
        crate::tagging::apply_model_setting(&app, model);
        crate::desktop::settings_restored(&app, safe);
        if let Err(error) = names::refresh_labels(&app, &state) {
            problems.push(format!("资料库名称未刷新：{error}"));
        }
        let _ = app.emit(SAFE_MODE_EVENT, safe);
        match workspace::action(&app, safe, |w, d, c| w.status(d, c, safe)) {
            Ok(status) => {
                let _ = app.emit(workspace::EVENT, status);
            }
            Err(error) => problems.push(format!("资料库列表未刷新：{error}")),
        }
        Ok(ApplicationSettingsRestored {
            settings: view,
            safe_mode: safe,
            problems,
        })
    })
    .await
}
