//! 资料库事件、截图协议的响应，以及要主窗口打开图或收藏截图的请求。

use super::*;
use kinshoko_core::library::LibraryEvent;

#[derive(Debug, PartialEq, Eq)]
enum PinRefresh {
    References,
    All,
}

/// Mode and settings commits arrive while visibility_commit is held. Update reveal
/// authority immediately so rapid off/on transitions cannot preserve a stale reveal.
fn pin_refresh(veils: &Mutex<PinVeils>, notice: &AppNotice) -> Option<PinRefresh> {
    match notice {
        AppNotice::SafeModeCommitted(mode) => {
            let mut veils = lock(veils);
            veils.set_safe_mode(mode.on);
            veils.set_scope(mode.scope);
            Some(PinRefresh::References)
        }
        AppNotice::ApplicationSettingsRestored(mode) => {
            let mut restored = PinVeils::new(mode.on);
            restored.set_scope(mode.scope);
            *lock(veils) = restored;
            Some(PinRefresh::All)
        }
        AppNotice::Library(
            LibraryEvent::SafeModeChanged { .. }
            | LibraryEvent::ListStale { .. }
            | LibraryEvent::ImagesChanged { .. },
        ) => Some(PinRefresh::References),
        _ => None,
    }
}

pub(crate) fn on_notice(app: &AppHandle, notice: &AppNotice) {
    let Some(state) = app.try_state::<DesktopState>() else {
        return;
    };
    if matches!(notice, AppNotice::DeskChanged) {
        let app = app.clone();
        std::thread::spawn(move || desk_commands::apply(&app, None));
    }
    if let Some(refresh) = pin_refresh(&state.veils, notice) {
        if refresh == PinRefresh::All {
            clear_viewer_reference(app);
            *lock(&state.capture) = capture::Session::Idle;
            if let Some(window) = app.get_webview_window(capture::CAPTURE_WINDOW) {
                let _ = window.destroy();
            }
        }
        let app = app.clone();
        std::thread::spawn(move || match refresh {
            PinRefresh::References => pins::references_changed(&app),
            PinRefresh::All => pins::refresh_all(&app),
        });
    }
}

/// 冻结屏幕现场编码；历史中的截图与参考组自带的截图直接读文件，都是内嵌显示器配置文件的 PNG。
pub(super) fn capture_response(app: &AppHandle, path: &str) -> Response<Vec<u8>> {
    let body = if let Some(token) = path.strip_prefix("screen/") {
        timing("png.begin");
        let png = capture::frozen_png(app, token);
        timing(&format!(
            "png.end bytes={}",
            png.as_ref().map_or(0, Vec::len)
        ));
        png
    } else if let Some((group, member)) =
        path.strip_prefix("group/").and_then(|p| p.split_once('/'))
    {
        // 参考组自带的截图（#270），参考组面板的缩略图用。
        let file = lock(&state(app).groups).capture_path(group, member);
        file.and_then(|f| std::fs::read(f).ok())
    } else {
        let file = lock(&state(app).history).file(path);
        file.and_then(|f| std::fs::read(f).ok())
    };
    match body {
        Some(bytes) => Response::builder()
            .header(header::CONTENT_TYPE, "image/png")
            .header(header::CACHE_CONTROL, "no-store")
            .body(bytes),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new()),
    }
    .expect("响应合法")
}

/// 截图历史变了：推送给所有窗口（主窗口的截图历史、钉图的收藏状态）。
pub(super) fn history_changed(app: &AppHandle) {
    let entries = lock(&state(app).history).entries();
    publish(app, AppNotice::CaptureHistoryChanged(entries));
}

/// 钉图菜单“在 Kinshoko 中打开”（#106）：打开主窗口，请它显示参考图（查看器）或截图历史。
/// 主窗口可能还没建好，请求先留着，由它用 `take_open_request` 取走。
pub(super) fn request_open(app: &AppHandle, request: OpenInKinshoko) {
    *lock(&state(app).pending_open) = Some(request);
    shell::open_main_window(app);
    publish(app, AppNotice::OpenInKinshokoRequested);
}

/// Native pin menus request a visible destination in the main window before saving.
pub(super) fn request_collection(app: &AppHandle, id: &str) {
    *lock(&state(app).pending_collection) = Some(id.into());
    shell::open_main_window(app);
    publish(app, AppNotice::CaptureCollectionRequested);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_notice::AppNotices;
    use kinshoko_core::desktop::{PinContent, Placement, SavedPin};
    use kinshoko_core::library::SafeMode;
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

    #[derive(Default)]
    struct Refreshes(Mutex<Vec<PinRefresh>>);

    fn record_pin_refresh(app: &AppHandle<MockRuntime>, notice: &AppNotice) {
        if let Some(refresh) = pin_refresh(&app.state::<Mutex<PinVeils>>(), notice) {
            lock(&app.state::<Refreshes>().0).push(refresh);
        }
    }

    #[test]
    fn safe_mode_commit_rechecks_pins_and_revokes_a_reveal_before_delivery_returns() {
        let mut veils = PinVeils::new(true);
        let pin = SavedPin {
            id: "pin".into(),
            content: PinContent::Reference {
                library_id: "library".into(),
                image_id: "image".into(),
                source_width: 10,
                source_height: 10,
            },
            crop: None,
            width: 10,
            height: 10,
            placement: Placement::default(),
            opacity: 1.0,
            locked: false,
            member: None,
        };
        veils.reveal(&pin.id);
        assert!(!veils.veiled(&pin, Some(true)));
        let app = mock_builder()
            .manage(Mutex::new(veils))
            .manage(Refreshes::default())
            .manage(AppNotices::<MockRuntime>::new(vec![record_pin_refresh]))
            .build(mock_context(noop_assets()))
            .unwrap();
        let app = app.handle();
        let state = app.state::<Mutex<PinVeils>>();
        let on = SafeMode::new(true, Default::default());
        publish(
            app,
            AppNotice::SafeModeCommitted(SafeMode { on: false, ..on }),
        );
        publish(app, AppNotice::SafeModeCommitted(on));
        assert!(lock(&state).veiled(&pin, Some(true)));
        assert_eq!(
            *lock(&app.state::<Refreshes>().0),
            [PinRefresh::References, PinRefresh::References]
        );

        lock(&state).reveal(&pin.id);
        publish(app, AppNotice::ApplicationSettingsRestored(on));
        assert!(lock(&state).veiled(&pin, Some(true)));
        assert_eq!(
            lock(&app.state::<Refreshes>().0).last(),
            Some(&PinRefresh::All)
        );
    }
}
