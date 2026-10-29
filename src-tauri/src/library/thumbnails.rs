//! 缩略图协议 `thumb` 与原图的内容类型。

use std::sync::atomic::{AtomicU32, Ordering};

use kinshoko_core::diagnostics::took;

use super::*;

/// 运行日志只记本次运行的前这么多个缩略图请求：首屏够看，滚动时不刷屏。
const LOGGED_THUMBNAILS_LIMIT: u32 = 80;
static LOGGED_THUMBNAILS: AtomicU32 = AtomicU32::new(0);

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
    // 核对与读文件前后各一次（#123）。平常按发布的快照放行，不拿全局锁、不重开资料库（#313）；
    // 本次运行的前若干个请求把分段耗时记进运行日志（#313），与浏览的耗时对照。
    let started = std::time::Instant::now();
    let logged = LOGGED_THUMBNAILS.fetch_add(1, Ordering::Relaxed) < LOGGED_THUMBNAILS_LIMIT;
    let mut slow = false;
    let Ok(library) = workspace::read_image(app, library_id, image_id, &mut slow) else {
        return not_found();
    };
    if logged {
        let path = if slow {
            "缩略图：核对（加锁路径）"
        } else {
            "缩略图：核对（快路径）"
        };
        took(path, started, None);
    }
    let reading = std::time::Instant::now();
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
    if logged {
        took("缩略图：取文件（含生成）", reading, None);
    }
    if !state.safe_mode.still(&generation)
        || saved_safe_mode(app) != safe
        || workspace::read_image(app, library_id, image_id, &mut slow).is_err()
    {
        return not_found();
    }
    if logged {
        took("缩略图：一张", started, None);
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
