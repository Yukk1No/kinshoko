//! Settings package adapter: live shell, catalog invalidation and OS registrations.

use super::*;
use kinshoko_core::CommandError;
use kinshoko_core::application_settings_backup::{
    ApplicationSettingsBackup, ApplicationSettingsPreview, ApplicationSettingsRestored,
};
#[tauri::command]
pub(super) async fn pick_application_settings<R: Runtime>(
    app: AppHandle<R>,
    save: bool,
) -> Result<Option<PathBuf>, CommandError> {
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
) -> Result<(), CommandError> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        let _transition = lock(&state.transition);
        with_catalog(&state.search, |catalog| {
            let shell_state = app.state::<ShellState>();
            let shell = lock(&shell_state.0);
            Ok(
                ApplicationSettingsBackup::export(&shell.settings, catalog, &path)
                    .map_err(CommandError::message),
            )
        })?
    })
    .await
}
#[tauri::command]
pub(super) async fn preview_application_settings(
    path: PathBuf,
) -> Result<ApplicationSettingsPreview, CommandError> {
    blocking(move || ApplicationSettingsBackup::inspect(&path).map_err(CommandError::message)).await
}
#[tauri::command]
pub(super) async fn restore_application_settings<R: Runtime>(
    app: AppHandle<R>,
    path: PathBuf,
    fingerprint: String,
) -> Result<ApplicationSettingsRestored, CommandError> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        let _transition = lock(&state.transition);
        let _visibility = lock(&state.visibility_commit);
        // Invalidate before waiting for catalog readers; keep final sends/copies excluded
        // through the replacement and desktop reset, even when the mode stays the same.
        state.safe_mode.revoke();
        import_preview::revoke(&app);
        let (view, safe, device, mut problems) = with_catalog(&state.search, |catalog| {
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
            state.safe_mode.commit(|mode| {
                *mode = SafeMode::new(shell.settings.safe_mode(), shell.settings.safe_mode_scope())
            });
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
                settings.tagging_device(),
                problems,
            )))
        })??;
        state.search.invalidate();
        *lock(&state.workspace) = None;
        *lock(&state.external_vocabulary) = None;
        state.release_readers();
        let scope = view.safe_mode_scope;
        state.detached.set_safe_mode_scope(scope);
        if let Some(libraries) = lock_libraries(&state).as_mut() {
            libraries.set_safe_mode(safe);
            if let Err(error) = libraries.set_safe_mode_scope(scope) {
                problems.push(format!("安全模式范围未完全生效：{error}"));
            }
        }
        if let Some(log) = crate::run_log::log() {
            log.set_enabled(view.run_log);
        }
        crate::tagging::apply_device_setting(&app, device);
        crate::desktop::settings_restored(&app, SafeMode::new(safe, scope));
        // 恢复的设置可能带来另一个更新通道（#204）。
        crate::updater::channel_changed(&app);
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
