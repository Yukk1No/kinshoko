//! 资料库事件与截图协议的响应。

use super::*;

/// 资料库转发给窗口的事件里，影响钉图遮蔽的几种：安全模式开关、分级变化（列表过期）。
pub(super) fn on_library_event(app: &AppHandle, payload: &str) {
    let Ok(event) = serde_json::from_str::<serde_json::Value>(payload) else {
        return;
    };
    let safe_mode = match event.get("kind").and_then(|k| k.as_str()) {
        Some("safeModeChanged") => event.get("on").and_then(|on| on.as_bool()),
        Some("listStale" | "imagesChanged") => None,
        _ => return,
    };
    let app = app.clone();
    std::thread::spawn(move || match safe_mode {
        Some(on) => pins::safe_mode_changed(&app, on),
        None => pins::references_changed(&app),
    });
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
