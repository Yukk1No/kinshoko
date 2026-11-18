//! 应用内浏览（#461）：读 pixiv 上的作品流、按名字找画师、`pximg` 协议转发 pixiv 图片，
//! 以及把挑中的作品收进资料库。界面还没接上，现有订阅页不变。

use std::sync::atomic::Ordering;

use kinshoko_core::command_error::CommandError;
use kinshoko_core::library::{SaveDestination, SubscriptionPage};
use kinshoko_core::subscription::pixiv::{ArtistsPage, Feed, IMAGE_HOST, PixivWork, WorksPage};
use kinshoko_core::subscription::{
    CollectedWork, Destination, HandReport, SourceError, SourceId, collect_by_hand,
};
use tauri::http::{Response, StatusCode, header};
use tauri::{AppHandle, Manager};

use super::roster::ask_pixiv;
use super::{SubscriptionState, enabled, now_ms, require};

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

/// 把一个作品收进资料库（#461 第 3 步）：`pages` 为空时收全部页；`again` 为真时已收的页也再收一次。
/// 原图经图片转发取，看全图时已经下载过的不再联网。
#[tauri::command]
pub async fn subscription_collect(
    app: AppHandle,
    work: PixivWork,
    pages: Option<Vec<u32>>,
    again: bool,
    destination: SaveDestination,
) -> Result<HandReport, CommandError> {
    let handle = app.clone();
    ask_pixiv(&app, move |_| {
        let state = handle.state::<SubscriptionState>();
        let work = work.to_work();
        let picked = Picked(handle.clone(), destination);
        collect_by_hand(
            &state.store,
            SourceId::Pixiv,
            &picked.1.library_id,
            &work,
            pages.as_deref(),
            again,
            &mut |url| {
                let path = url
                    .strip_prefix(IMAGE_HOST)
                    .ok_or(SourceError::Unsupported)?;
                Ok(state.images.get(path, &state.images_cancel)?.bytes)
            },
            &picked,
            &now_ms,
            &state.images_cancel,
        )
    })
    .await
}

/// 这些作品里已收进资料库的页（“已收”标记）。不联网。
#[tauri::command]
pub async fn subscription_collected(
    app: AppHandle,
    work_ids: Vec<String>,
) -> Result<Vec<CollectedWork>, CommandError> {
    let store = require(&app)?.store.clone();
    tauri::async_runtime::spawn_blocking(move || store.collected(SourceId::Pixiv, &work_ids))
        .await
        .map_err(CommandError::system)?
        .map_err(CommandError::from)
}

/// 收进画师选的资料库与文件夹。
struct Picked(AppHandle, SaveDestination);

impl Destination for Picked {
    fn import(
        &self,
        _library_id: &str,
        page: SubscriptionPage,
        bytes: &[u8],
    ) -> Result<String, String> {
        crate::library::with_destination(&self.0, &self.1, |library| {
            Ok(library.import_from_subscription(page, bytes)?)
        })
        .map_err(|e| e.to_string())
    }
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
