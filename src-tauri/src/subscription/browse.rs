//! 应用内浏览（#461）：读 pixiv 上的作品流、按名字找画师，以及 `pximg` 协议转发 pixiv 图片。
//! 界面还没接上（#461 分 PR 的第 1 步），现有订阅页不变。

use std::sync::atomic::Ordering;

use kinshoko_core::command_error::CommandError;
use kinshoko_core::subscription::pixiv::{ArtistsPage, Feed, WorksPage};
use tauri::http::{Response, StatusCode, header};
use tauri::{AppHandle, Manager};

use super::roster::ask_pixiv;
use super::{SubscriptionState, enabled};

/// 作品流的一页。`next` 为空时读第一页，否则原样交回上一页给的 `next`。
#[tauri::command]
pub async fn subscription_browse(
    app: AppHandle,
    feed: Feed,
    next: Option<String>,
) -> Result<WorksPage, CommandError> {
    ask_pixiv(&app, move |source| source.browse(&feed, next.as_deref())).await
}

/// 按名字找画师的一页。
#[tauri::command]
pub async fn subscription_search_artists(
    app: AppHandle,
    word: String,
    next: Option<String>,
) -> Result<ArtistsPage, CommandError> {
    ask_pixiv(&app, move |source| {
        source.search_artists(&word, next.as_deref())
    })
    .await
}

/// `pximg` 协议：路径是 `i.pximg.net` 后面的部分。关掉订阅功能后一律不给，也不联网。
pub fn image_response(app: &AppHandle, path: &str) -> Response<Vec<u8>> {
    let status = |code: StatusCode| {
        Response::builder()
            .status(code)
            .body(Vec::new())
            .expect("响应合法")
    };
    let Some(state) = app.try_state::<SubscriptionState>() else {
        return status(StatusCode::NOT_FOUND);
    };
    if !enabled(app) || state.images_cancel.load(Ordering::SeqCst) {
        return status(StatusCode::FORBIDDEN);
    }
    match state.images.get(path, &state.images_cancel) {
        Ok(image) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, image.mime)
            // 同一地址的图不会变。
            .header(header::CACHE_CONTROL, "private, max-age=604800, immutable")
            .body(image.bytes)
            .expect("响应合法"),
        Err(e) => {
            use kinshoko_core::subscription::SourceError as E;
            status(match e {
                E::Unsupported => StatusCode::NOT_FOUND,
                E::RateLimited => StatusCode::TOO_MANY_REQUESTS,
                E::Status { status: 404 } => StatusCode::NOT_FOUND,
                E::Cancelled => StatusCode::FORBIDDEN,
                _ => StatusCode::BAD_GATEWAY,
            })
        }
    }
}
