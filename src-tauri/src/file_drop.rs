//! WebView2 file paths for HTML5 drops in the main window.
#![allow(unsafe_code)]

use tauri::{Emitter, Manager, Url, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs,
    ICoreWebView2WebMessageReceivedEventArgs2,
};
use webview2_com::{WebMessageReceivedEventHandler, take_pwstr};
use windows::core::{Interface, PWSTR};

const EVENT: &str = "kinshoko-file-drop";

fn accepts(message: &str, source: &str, origin: &Url) -> bool {
    let Ok(source) = Url::parse(source) else {
        return false;
    };
    source.origin() == origin.origin()
        && source.username().is_empty()
        && source.password().is_none()
        && serde_json::from_str::<serde_json::Value>(message)
            .is_ok_and(|value| value == serde_json::json!({ "kind": EVENT, "version": 1 }))
}

unsafe fn paths(
    args: &ICoreWebView2WebMessageReceivedEventArgs,
    origin: &Url,
) -> windows::core::Result<Vec<String>> {
    unsafe {
        let mut source = PWSTR::null();
        args.Source(&mut source)?;
        let source = take_pwstr(source);
        let mut message = PWSTR::null();
        args.WebMessageAsJson(&mut message)?;
        if !accepts(&take_pwstr(message), &source, origin) {
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

pub fn install(window: &WebviewWindow) -> tauri::Result<()> {
    if window.label() != "main" {
        return Ok(());
    }
    let config = window.config();
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
    let origin = if tauri::is_dev() {
        config.build.dev_url.clone()
    } else {
        None
    }
    .unwrap_or_else(|| Url::parse(&format!("{scheme}://tauri.localhost")).expect("app origin"));
    let target = window.clone();
    window.with_webview(move |webview| {
        let register = || -> windows::core::Result<()> {
            unsafe {
                let core = webview.controller().CoreWebView2()?;
                let mut token = 0;
                core.add_WebMessageReceived(
                    &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            match paths(&args, &origin) {
                                Ok(paths) if !paths.is_empty() => {
                                    if let Err(error) = target.emit_to("main", EVENT, paths) {
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
        let marker = r#"{"kind":"kinshoko-file-drop","version":1}"#;
        for app in ["http://tauri.localhost", "http://127.0.0.1:1420"] {
            let origin = Url::parse(app).unwrap();
            assert!(accepts(
                marker,
                &format!("{app}/index.html?view=main"),
                &origin
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
                assert!(!accepts(message, app, &origin));
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
                assert!(!accepts(marker, source, &origin));
            }
        }
    }
}
