//! 订阅名单（#369、#370）：添加、改设置、退订，以及添加前向 pixiv 查画师、读关注。

use std::sync::atomic::Ordering;

use kinshoko_core::command_error::{CommandError, ErrorKind};
use kinshoko_core::subscription::pixiv::{Artist, LoginState, PixivSource, artist_id};
use kinshoko_core::subscription::{
    NewSubscription, RANKING_TOPS, SourceError, SourceId, Subscription, Target, schedule,
};
use tauri::AppHandle;

use super::{enabled, now_ms, publish, require, switched_off};

/// 订阅来源的请求没成。
fn source_failed(reason: SourceError) -> CommandError {
    CommandError::new(
        ErrorKind::SubscriptionSource {
            reason: reason.clone(),
        },
        format!("pixiv request failed: {reason:?}"),
    )
}

/// 界面里向 pixiv 要东西（查找画师、读关注）：要开着订阅、登录着，并且不在退避中。
/// 和检查线程排同一个节拍；遇到频率限制时整个来源退避，与检查一样。
async fn ask_pixiv<T: Send + 'static>(
    app: &AppHandle,
    ask: impl FnOnce(&mut PixivSource) -> Result<T, SourceError> + Send + 'static,
) -> Result<T, CommandError> {
    let state = require(app)?;
    if !enabled(app) {
        return Err(switched_off());
    }
    match state.account.state() {
        LoginState::LoggedIn { .. } => {}
        LoginState::LoggedOut => return Err(source_failed(SourceError::LoginRequired)),
        LoginState::Expired { .. } => return Err(source_failed(SourceError::LoginExpired)),
    }
    let backoff = state.store.backoff(SourceId::Pixiv).ok().flatten();
    if backoff.is_some_and(|(until, _)| until > now_ms()) {
        return Err(source_failed(SourceError::RateLimited));
    }
    state.foreground_cancel.store(false, Ordering::SeqCst);
    let mut source = PixivSource::new(
        state.account.clone(),
        state.pacers.clone(),
        state.foreground_cancel.clone(),
    );
    let store = state.store.clone();
    let result = tauri::async_runtime::spawn_blocking(move || ask(&mut source))
        .await
        .map_err(CommandError::system)?;
    match result {
        Ok(value) => Ok(value),
        Err(SourceError::RateLimited) => {
            let level = backoff.map_or(0, |(_, level)| level);
            let _ = store.set_backoff(
                SourceId::Pixiv,
                now_ms() + schedule::backoff_ms(level),
                level + 1,
            );
            // 正在进行的检查在下一个请求前停下，不在退避期间接着请求。
            state.cancel.store(true, Ordering::SeqCst);
            publish(app);
            Err(source_failed(SourceError::RateLimited))
        }
        Err(e @ SourceError::LoginExpired) => {
            publish(app);
            Err(source_failed(e))
        }
        Err(e) => Err(source_failed(e)),
    }
}

/// 订阅画师（#369）：从画师主页链接或 ID 找到画师。
#[tauri::command]
pub async fn subscription_find_artist(
    app: AppHandle,
    input: String,
) -> Result<Artist, CommandError> {
    let Some(user_id) = artist_id(&input) else {
        return Err(CommandError::new(
            ErrorKind::ArtistUnrecognized,
            "not a pixiv artist link or id",
        ));
    };
    ask_pixiv(&app, move |source| source.artist(&user_id))
        .await?
        .ok_or_else(|| CommandError::new(ErrorKind::ArtistNotFound, "no such pixiv artist"))
}

/// 登录账号在 pixiv 上关注的画师（#369 从 pixiv 关注导入）。
#[tauri::command]
pub async fn subscription_following(app: AppHandle) -> Result<Vec<Artist>, CommandError> {
    ask_pixiv(&app, |source| source.following()).await
}

/// 添加订阅（可以一次几条，例如从关注导入）。已订阅过的对象报错，一条都不加；加好后马上检查。
#[tauri::command]
pub async fn subscription_add(
    app: AppHandle,
    subscriptions: Vec<NewSubscription>,
) -> Result<Vec<Subscription>, CommandError> {
    let state = require(&app)?;
    if !enabled(&app) {
        return Err(switched_off());
    }
    let existing = state.store.list().map_err(CommandError::system)?;
    let taken = |target: &Target| existing.iter().any(|s| same_target(&s.target, target));
    let mut seen: Vec<&Target> = Vec::new();
    for new in &subscriptions {
        if !new.target.is_valid() {
            // 界面只给可选的几档，走到这里是界面有错。
            return Err(CommandError::system(format!(
                "unsupported subscription target: {:?}",
                new.target
            )));
        }
        if taken(&new.target) || seen.iter().any(|t| same_target(t, &new.target)) {
            return Err(CommandError::new(
                ErrorKind::AlreadySubscribed,
                "already subscribed",
            ));
        }
        seen.push(&new.target);
    }
    let now = now_ms();
    let added = subscriptions
        .into_iter()
        .map(|new| state.store.add(new, now))
        .collect::<Result<Vec<_>, _>>()
        .map_err(CommandError::system)?;
    state.poke(false);
    publish(&app);
    Ok(added)
}

/// 画师订阅按画师判断是不是同一个，榜单按哪个榜（名次不同也算同一个）；其余按整个对象。
fn same_target(a: &Target, b: &Target) -> bool {
    match (a, b) {
        (Target::PixivArtist { user_id: x }, Target::PixivArtist { user_id: y }) => x == y,
        (
            Target::PixivRanking {
                period: p,
                explicit: e,
                ..
            },
            Target::PixivRanking {
                period: q,
                explicit: f,
                ..
            },
        ) => p == q && e == f,
        _ => a == b,
    }
}

/// 改一条订阅收不收漫画与成人作品；榜单还可以改名次（`top`）。
#[tauri::command]
pub async fn subscription_set_options(
    app: AppHandle,
    id: String,
    include_explicit: bool,
    include_manga: bool,
    top: Option<u32>,
) -> Result<Subscription, CommandError> {
    if top.is_some_and(|top| !RANKING_TOPS.contains(&top)) {
        return Err(CommandError::system(format!(
            "unsupported ranking top: {top:?}"
        )));
    }
    require(&app)?
        .store
        .set_options(&id, include_explicit, include_manga, top)
        .map_err(CommandError::system)
}

/// 退订：删掉这条订阅，已收进图库的图留着。
#[tauri::command]
pub async fn subscription_remove(app: AppHandle, id: String) -> Result<(), CommandError> {
    require(&app)?
        .store
        .remove(&id)
        .map_err(CommandError::system)?;
    publish(&app);
    Ok(())
}
