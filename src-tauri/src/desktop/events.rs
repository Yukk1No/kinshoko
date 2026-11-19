//! 资料库事件、截图协议的响应，以及要主窗口打开图或收藏截图的请求。

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

/// 截图历史变了：推送给所有窗口（主窗口的截图历史、钉图的收藏状态）。
pub(super) fn history_changed(app: &AppHandle) {
    let entries = lock(&state(app).history).entries();
    let _ = app.emit(HISTORY_EVENT, entries);
}

/// 钉图菜单“在 Kinshoko 中打开”（#106）：打开主窗口，请它显示参考图（查看器）或截图历史。
/// 主窗口可能还没建好，请求先留着，由它用 `take_open_request` 取走。
pub(super) fn request_open(app: &AppHandle, request: OpenInKinshoko) {
    *lock(&state(app).pending_open) = Some(request);
    shell::open_main_window(app);
    let _ = app.emit("open-in-kinshoko", ());
}

/// Native pin menus request a visible destination in the main window before saving.
pub(super) fn request_collection(app: &AppHandle, id: &str) {
    *lock(&state(app).pending_collection) = Some(id.into());
    shell::open_main_window(app);
    let _ = app.emit("capture-collection-request", ());
}
