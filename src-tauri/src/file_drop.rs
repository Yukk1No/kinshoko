//! WebView2 file paths for HTML5 drops in the main window.

use tauri::{AppHandle, Manager, Url, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs,
    ICoreWebView2WebMessageReceivedEventArgs2,
};
use webview2_com::{WebMessageReceivedEventHandler, take_pwstr};
use windows::core::{Interface, PWSTR};

use crate::window_events::{self, FILE_DROP_EVENT, WindowRequest};

fn accepts(message: &str, source: &str, origin: &Url, invoke_key: &str) -> bool {
    let Ok(source) = Url::parse(source) else {
        return false;
    };
    source.origin() == origin.origin()
        && source.username().is_empty()
        && source.password().is_none()
        && serde_json::from_str::<serde_json::Value>(message).is_ok_and(|value| {
            value["cmd"] == "file_drop_ack"
                && value["__TAURI_INVOKE_KEY__"] == invoke_key
                && value["payload"] == serde_json::json!({ "kind": FILE_DROP_EVENT, "version": 1 })
        })
}

#[allow(unsafe_code)]
unsafe fn paths(
    args: &ICoreWebView2WebMessageReceivedEventArgs,
    origin: &Url,
    invoke_key: &str,
) -> windows::core::Result<Vec<String>> {
    // SAFETY: Called on WebView2's UI (STA) thread with COM args valid for the callback.
    // Successful PWSTR getters transfer ownership to take_pwstr (CoTaskMemFree).
    unsafe {
        let mut source = PWSTR::null();
        args.Source(&mut source)?;
        let source = take_pwstr(source);
        let mut message = PWSTR::null();
        args.TryGetWebMessageAsString(&mut message)?;
        if !accepts(&take_pwstr(message), &source, origin, invoke_key) {
            return Ok(Vec::new());
        }
        let args: ICoreWebView2WebMessageReceivedEventArgs2 = args.cast()?;
        let objects = args.AdditionalObjects()?;
        let mut count = 0;
        objects.Count(&mut count)?;
        let mut paths = Vec::new();
        for index in 0..count {
            let file: ICoreWebView2File = objects.GetValueAtIndex(index)?.cast()?;
            let mut path = PWSTR::null();
            file.Path(&mut path)?;
            let path = take_pwstr(path);
            if !path.is_empty() {
                paths.push(path);
            }
        }
        Ok(paths)
    }
}

fn app_origin(config: &tauri::utils::config::Config) -> Url {
    let main = config
        .app
        .windows
        .iter()
        .find(|window| window.label == "main");
    let scheme = if main.is_some_and(|window| window.use_https_scheme) {
        "https"
    } else {
        "http"
    };
    if tauri::is_dev() {
        config.build.dev_url.clone()
    } else {
        None
    }
    .unwrap_or_else(|| Url::parse(&format!("{scheme}://tauri.localhost")).expect("app origin"))
}

pub fn initialization_script(app: &AppHandle) -> String {
    include_str!("file_drop.js")
        .replace(
            "\"__KINSHOKO_APP_ORIGIN__\"",
            &serde_json::to_string(&app_origin(app.config()).origin().ascii_serialization())
                .expect("app origin JSON"),
        )
        .replace(
            "\"__KINSHOKO_INVOKE_KEY__\"",
            &serde_json::to_string(app.invoke_key()).expect("invoke key JSON"),
        )
}

// Wry requires a string; a valid invoke envelope also keeps Tauri's parser quiet.
#[tauri::command]
pub fn file_drop_ack() {}

pub fn install(window: &WebviewWindow) -> tauri::Result<()> {
    if window.label() != "main" {
        return Ok(());
    }
    let origin = app_origin(window.config());
    let invoke_key = window.app_handle().invoke_key().to_owned();
    let target = window.clone();
    window.with_webview(move |webview| {
        let register = || -> windows::core::Result<()> {
            // SAFETY: Wry's with_webview runs on WebView2's UI (STA) thread;
            // its event callback runs there too, with COM args valid for the callback duration.
            #[allow(unsafe_code)]
            unsafe {
                let core = webview.controller().CoreWebView2()?;
                let mut token = 0;
                core.add_WebMessageReceived(
                    &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            match paths(&args, &origin, &invoke_key) {
                                Ok(paths) if !paths.is_empty() => {
                                    if let Err(error) = window_events::send(
                                        target.app_handle(),
                                        WindowRequest::FileDrop(paths),
                                    ) {
                                        crate::run_log::error("file drop event", error);
                                    }
                                }
                                Ok(_) => {}
                                Err(error) => crate::run_log::error("file drop paths", error),
                            }
                        }
                        Ok(())
                    })),
                    &mut token,
                )?;
            }
            Ok(())
        };
        if let Err(error) = register() {
            crate::run_log::error("file drop registration", error);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_and_origin_are_required() {
        let envelope = |payload: serde_json::Value| {
            serde_json::json!({
                "cmd": "file_drop_ack",
                "__TAURI_INVOKE_KEY__": "test-key",
                "payload": payload,
            })
            .to_string()
        };
        let marker = envelope(serde_json::json!({ "kind": FILE_DROP_EVENT, "version": 1 }));
        for app in ["http://tauri.localhost", "http://127.0.0.1:1420"] {
            let origin = Url::parse(app).unwrap();
            assert!(accepts(
                &marker,
                &format!("{app}/index.html?view=main"),
                &origin,
                "test-key"
            ));
            for message in [
                "",
                "null",
                "[]",
                "{",
                r#""kinshoko-file-drop""#,
                r#"{"kind":"other","version":1}"#,
                r#"{"kind":"kinshoko-file-drop","version":2}"#,
                r#"{"kind":"kinshoko-file-drop"}"#,
                r#"{"kind":"kinshoko-file-drop","version":1,"extra":true}"#,
            ] {
                assert!(!accepts(message, app, &origin, "test-key"));
                if let Ok(payload) = serde_json::from_str(message) {
                    assert!(!accepts(&envelope(payload), app, &origin, "test-key"));
                }
            }
            for source in [
                "not a url",
                "https://tauri.localhost",
                "http://tauri.localhost.evil",
                "http://127.0.0.1:1421",
                "http://user@tauri.localhost",
                "file:///index.html",
                "about:blank",
            ] {
                assert!(!accepts(&marker, source, &origin, "test-key"));
            }
            assert!(!accepts(&marker, app, &origin, "wrong-key"));
            assert!(!accepts(
                &marker.replace("file_drop_ack", "other"),
                app,
                &origin,
                "test-key"
            ));
        }
    }
}
