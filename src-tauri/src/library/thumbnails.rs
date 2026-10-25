//! 缩略图协议 `thumb` 与原图的内容类型。

use super::*;

pub(super) fn thumbnail_response<R: Runtime>(app: &AppHandle<R>, path: &str) -> Response<Vec<u8>> {
    let not_found = || {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new())
            .expect("响应合法")
    };
    let mut parts = path.split('/');
    let (Some(library_id), Some(image_id), Some(px), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return not_found();
    };
    // Registered detached provider. The workspace safety veto includes nonmatching/offline sources.
    let state = app.state::<LibraryState>();
    let generation = state.safe_mode.snapshot();
    let safe = saved_safe_mode(app);
    // 核对与读文件前后各一次，共用这次请求里打开的提供方（#123）：不在同一请求里反复重开资料库，
    // 渲染与读文件不占用全局锁。
    let mut opened = kinshoko_core::workspace::ProviderReaders::default();
    let Ok(library) = workspace::read_image(app, &mut opened, library_id, image_id) else {
        return not_found();
    };
    // `full`：1:1 与放大时显示的文件（Library::display，ADR-0005）。看图界面只用这条路，
    // 不直接读原文件——动图、HDR、Chromium 不能精确表示的 ICC 与 CMYK 要换成 sdr 派生图。
    // `fit-<像素>`：查看器缩小显示（适应窗口等）的精确尺寸派生图（Library::display_scaled，#47）。
    let found = if px == "full" {
        library.display(image_id).map(|d| d.path)
    } else if let Some(fit) = px.strip_prefix("fit-") {
        let Ok(fit) = fit.parse::<u32>() else {
            return not_found();
        };
        library.display_scaled(image_id, fit).map(|d| d.path)
    } else {
        let Ok(px) = px.parse::<u32>() else {
            return not_found();
        };
        library.thumbnail(image_id, px)
    };
    let Ok(path) = found else {
        return not_found();
    };
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return not_found(),
    };
    if !state.safe_mode.still(&generation)
        || saved_safe_mode(app) != safe
        || workspace::read_image(app, &mut opened, library_id, image_id).is_err()
    {
        return not_found();
    }
    match Ok::<_, std::io::Error>(bytes) {
        Ok(bytes) => Response::builder()
            .header(header::CONTENT_TYPE, image_content_type(&path))
            .body(bytes)
            .expect("响应合法"),
        Err(_) => not_found(),
    }
}

/// 派生图按来源分档存为无损 WebP 或 16 位 PNG（#45）。
pub fn image_content_type(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        _ => "image/webp",
    }
}
