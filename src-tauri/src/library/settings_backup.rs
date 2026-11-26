//! Settings package adapter: live shell, catalog invalidation and OS registrations.

use super::*;
use crate::ui_text::{Text, text};
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
            .add_filter(text(Text::FilterSettingsBackup), &["kinshoko-settings"]);
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
        let _transition = state.session.transition();
        with_catalog(state.search(), |catalog| {
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
) -> Result<ApplicationSettingsPreview, CommandError> {
    blocking(move || ApplicationSettingsBackup::inspect(&path)).await
}
#[tauri::command]
pub(super) async fn restore_application_settings<R: Runtime>(
    app: AppHandle<R>,
    path: PathBuf,
    fingerprint: String,
) -> Result<ApplicationSettingsRestored, CommandError> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        let _transition = state.session.transition();
        with_visibility_commit(&app, |permit| {
            // Invalidate before waiting for catalog readers; keep final sends/copies excluded
            // through the replacement and desktop reset, even when the mode stays the same.
            permit.revoke();
            let (view, safe, device, mut problems) = with_catalog(state.search(), |catalog| {
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
                permit.replace_safe_mode(SafeMode::new(
                    shell.settings.safe_mode(),
                    shell.settings.safe_mode_scope(),
                ));
                let crate::shell::Shell {
                    settings,
                    shortcuts,
                    ..
                } = &mut *shell;
                shortcuts.reload(&previous, settings);
                let mut problems = Vec::new();
                if let Err(error) = crate::shell::sync_autostart(&app, settings.autostart()) {
                    problems.push(CommandError::caused_by(
                        error,
                        |cause| ErrorKind::AutostartNotSynced { cause },
                        |error| format!("开机自启未同步：{error}"),
                    ));
                }
                Ok(Ok((
                    shell.view(),
                    shell.settings.safe_mode(),
                    shell.settings.tagging_device(),
                    problems,
                )))
            })??;
            state.search().invalidate();
            state.session.reset_workspace();
            *lock(&state.external_vocabulary) = None;
            state.release_readers();
            let scope = view.safe_mode_scope;
            state.detached.set_safe_mode_scope(scope);
            if let Some(libraries) = lock_libraries(&state).as_mut() {
                libraries.set_safe_mode(safe);
                if let Err(error) = libraries.set_safe_mode_scope(scope) {
                    problems.push(CommandError::caused_by(
                        error,
                        |cause| ErrorKind::SafeModeScopeIncomplete { cause },
                        |error| format!("安全模式范围未完全生效：{error}"),
                    ));
                }
            }
            if let Some(log) = crate::run_log::log() {
                log.set_enabled(view.run_log);
            }
            crate::tagging::apply_device_setting(&app, device);
            publish(
                &app,
                AppNotice::ApplicationSettingsRestored(SafeMode::new(safe, scope)),
            );
            // 恢复的设置可能带来另一个更新通道（#204）。
            crate::updater::channel_changed(&app);
            if let Err(error) = names::refresh_labels(&app, &state) {
                problems.push(CommandError::caused_by(
                    error,
                    |cause| ErrorKind::LibraryNamesNotRefreshed { cause },
                    |error| format!("资料库名称未刷新：{error}"),
                ));
            }
            // Keep the restore receipt's diagnostic. Only the monitor publishes revisions.
            if let Err(error) = with_lens(&app, safe, Hold::Read, |w, d, c| w.status(d, c, safe)) {
                problems.push(CommandError::caused_by(
                    error,
                    |cause| ErrorKind::LibraryListNotRefreshed { cause },
                    |error| format!("资料库列表未刷新：{error}"),
                ));
            }
            Ok(ApplicationSettingsRestored {
                settings: view,
                safe_mode: safe,
                problems,
            })
        })
    })
    .await
}
