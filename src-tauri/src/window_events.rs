//! Compatibility adapter for the event names, targets and payloads used by WebViews.

use kinshoko_core::desktop::PinMenuOpen;
use kinshoko_core::library::LibraryEvent;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::app_notice::{AppNotice, VocabularyRevision};

const LIBRARY_EVENT: &str = "library-event";
#[cfg(windows)]
pub(crate) const FILE_DROP_EVENT: &str = "kinshoko-file-drop";

pub(crate) fn on_notice<R: Runtime>(app: &AppHandle<R>, notice: &AppNotice) {
    let _ = match notice {
        AppNotice::Library(event) => app.emit(LIBRARY_EVENT, event),
        AppNotice::WritableLibraryChanged(info) => app.emit("writable-library", info),
        AppNotice::OrganizeWaiting(notice) => app.emit("organize-waiting", notice),
        // Existing label consumers refresh from this library-scoped payload.
        AppNotice::CatalogLabelsChanged(Some(VocabularyRevision {
            library_id,
            revision,
        })) => app.emit(
            LIBRARY_EVENT,
            LibraryEvent::VocabularyChanged {
                library_id: library_id.clone(),
                revision: *revision,
            },
        ),
        AppNotice::WorkspaceChanged(status) => app.emit("workspace-changed", status),
        AppNotice::SafeModeCommitted(mode) => app.emit("safe-mode-setting", mode.on),
        AppNotice::ApplicationSettingsRestored(mode) => {
            let _ = app.emit("application-settings-restored", ());
            app.emit("safe-mode-setting", mode.on)
        }
        AppNotice::ReferenceGroupsChanged => app.emit("reference-groups", ()),
        AppNotice::DeskChanged => app.emit("desktop://desk-changed", ()),
        AppNotice::DeskGroupStarted {
            group_id,
            previous_id,
        } => app.emit(
            "desk-group-started",
            DeskGroupStarted {
                group_id,
                previous_id,
            },
        ),
        AppNotice::CaptureHistoryChanged(entries) => app.emit("capture-history", entries),
        AppNotice::OpenInKinshokoRequested => app.emit("open-in-kinshoko", ()),
        AppNotice::CaptureCollectionRequested => app.emit("capture-collection-request", ()),
        AppNotice::InterfaceLanguageChanged(lang) => app.emit("interface-language", lang),
        AppNotice::BackupStatus(status) => app.emit("backup-status", status),
        AppNotice::SubscriptionStatus(status) => app.emit("subscription-status", status),
        AppNotice::TaggingStatus(status) => app.emit("tagging-status", status),
        AppNotice::UpdateChannelChanged => app.emit("update-channel-changed", ()),
        AppNotice::UpdateProgress(progress) => app.emit("update-progress", progress),
        AppNotice::RegistryChanged
        | AppNotice::LibraryWriteCommitted
        | AppNotice::TagGroupsChanged
        | AppNotice::PersonalApproxChanged
        | AppNotice::CatalogLabelsChanged(None)
        | AppNotice::MainWindowActivated => return,
    };
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeskGroupStarted<'a> {
    group_id: &'a str,
    previous_id: &'a str,
}

/// One-window requests can return a delivery error to their caller.
pub(crate) enum WindowRequest<'a> {
    CaptureSession,
    CaptureReference {
        request: &'a str,
    },
    DesktopMenu(&'a PinMenuOpen),
    #[cfg(windows)]
    FileDrop(Vec<String>),
}

pub(crate) fn send<R: Runtime>(
    app: &AppHandle<R>,
    request: WindowRequest<'_>,
) -> tauri::Result<()> {
    match request {
        WindowRequest::CaptureSession => {
            app.emit_to(crate::desktop::CAPTURE_WINDOW, "capture-session", ())
        }
        WindowRequest::CaptureReference { request } => app.emit_to(
            crate::shell::MAIN_WINDOW,
            "capture-reference-request",
            CaptureReference { request },
        ),
        WindowRequest::DesktopMenu(menu) => {
            app.emit_to(crate::desktop::MENU_WINDOW, "desktop-menu", menu)
        }
        #[cfg(windows)]
        WindowRequest::FileDrop(paths) => {
            app.emit_to(crate::shell::MAIN_WINDOW, FILE_DROP_EVENT, paths)
        }
    }
}

#[derive(Clone, Serialize)]
struct CaptureReference<'a> {
    request: &'a str,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_notice::{AppNotices, publish};
    use kinshoko_core::library::SafeMode;
    use kinshoko_core::workspace::WorkspaceStatus;
    use serde_json::{Value, json};
    use std::sync::mpsc;
    use tauri::Listener;
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

    #[test]
    fn window_subscribers_keep_their_event_names_and_payloads() {
        let app = mock_builder()
            .manage(AppNotices::<MockRuntime>::new(vec![on_notice]))
            .build(mock_context(noop_assets()))
            .unwrap();
        let app = app.handle();
        let (sender, receiver) = mpsc::channel();
        for name in [
            "safe-mode-setting",
            "library-event",
            "workspace-changed",
            "reference-groups",
            "application-settings-restored",
            "desk-group-started",
        ] {
            let sender = sender.clone();
            app.listen(name, move |event| {
                let value = serde_json::from_str::<Value>(event.payload()).unwrap();
                sender.send((name, value)).unwrap();
            });
        }
        publish(
            app,
            AppNotice::SafeModeCommitted(SafeMode::new(true, Default::default())),
        );
        publish(
            app,
            AppNotice::Library(LibraryEvent::ListStale {
                library_id: "library".into(),
            }),
        );
        publish(
            app,
            AppNotice::CatalogLabelsChanged(Some(VocabularyRevision {
                library_id: "library".into(),
                revision: 3,
            })),
        );
        publish(
            app,
            AppNotice::WorkspaceChanged(WorkspaceStatus {
                revision: "r1".into(),
                libraries: vec![],
            }),
        );
        publish(app, AppNotice::ReferenceGroupsChanged);
        publish(
            app,
            AppNotice::ApplicationSettingsRestored(SafeMode::new(false, Default::default())),
        );
        publish(
            app,
            AppNotice::DeskGroupStarted {
                group_id: "group".into(),
                previous_id: "previous".into(),
            },
        );

        assert_eq!(
            receiver.try_iter().collect::<Vec<_>>(),
            [
                ("safe-mode-setting", json!(true)),
                (
                    "library-event",
                    json!({"kind": "listStale", "libraryId": "library"})
                ),
                (
                    "library-event",
                    json!({"kind": "vocabularyChanged", "libraryId": "library", "revision": 3})
                ),
                (
                    "workspace-changed",
                    json!({"revision": "r1", "libraries": []})
                ),
                ("reference-groups", Value::Null),
                ("application-settings-restored", Value::Null),
                ("safe-mode-setting", json!(false)),
                (
                    "desk-group-started",
                    json!({"groupId": "group", "previousId": "previous"})
                ),
            ],
        );
    }
}
