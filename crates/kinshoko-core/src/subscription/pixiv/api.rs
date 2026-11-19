//! pixiv 客户端接口与原图下载。每个请求前按节拍等待；频率限制与登录失效交给检查停下。

use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use serde_json::Value;

use super::account::PixivAccount;
use super::artist::{self, Artist};
use super::auth::AuthError;
use super::bookmarks;
use super::browse::{self, ArtistsPage, Feed, WorksPage};
use super::images;
use super::ranking;
use crate::subscription::pace::{Pacers, Priority};
use crate::subscription::{Source, SourceError, SourceId, Subscription, Target, Work};

const API: &str = "https://app-api.pixiv.net";
pub(super) const APP_UA: &str = "PixivIOSApp/7.13.3 (iOS 14.6; iPhone13,2)";

/// 读 JSON 回应；读不懂时为空。
pub(super) fn json(response: ureq::Response) -> Option<Value> {
    serde_json::from_reader(response.into_reader().take(16 * 1024 * 1024)).ok()
}

pub(super) fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .build()
}

impl From<AuthError> for SourceError {
    fn from(e: AuthError) -> Self {
        match e {
            AuthError::Rejected => SourceError::LoginExpired,
            AuthError::RateLimited => SourceError::RateLimited,
            AuthError::Network => SourceError::Network,
            AuthError::Status(status) => SourceError::Status { status },
            AuthError::Unreadable => SourceError::Unreadable,
        }
    }
}

/// pixiv 订阅来源。
pub struct PixivSource {
    account: Arc<PixivAccount>,
    agent: ureq::Agent,
    pacers: Arc<Pacers>,
    cancel: Arc<AtomicBool>,
    priority: Priority,
}

impl PixivSource {
    /// 后台检查用的来源。`pacers` 是 pixiv 共用的一份节拍。
    pub fn new(
        account: Arc<PixivAccount>,
        pacers: Arc<Pacers>,
        cancel: Arc<AtomicBool>,
    ) -> PixivSource {
        PixivSource {
            account,
            agent: agent(),
            pacers,
            cancel,
            priority: Priority::Background,
        }
    }

    /// 画师在界面里亲手发请求用的来源：和后台检查排同一个节拍，但排在它前面（#461）。
    pub fn foreground(
        account: Arc<PixivAccount>,
        pacers: Arc<Pacers>,
        cancel: Arc<AtomicBool>,
    ) -> PixivSource {
        PixivSource {
            priority: Priority::Foreground,
            ..PixivSource::new(account, pacers, cancel)
        }
    }

    /// 应用内浏览（#461）：作品流的一页。`next` 为空时读第一页，否则是上一页给的 [`WorksPage::next`]。
    pub fn browse(&mut self, feed: &Feed, next: Option<&str>) -> Result<WorksPage, SourceError> {
        let path = match next {
            Some(next) => browse::checked_next(next)?,
            None => {
                let self_id = match feed {
                    Feed::Bookmarks { .. } => self.self_id()?,
                    _ => String::new(),
                };
                browse::first_page(feed, &self_id)?
            }
        };
        browse::works_page(&mut |path| self.get(path), &path)
    }

    /// 应用内浏览（#461）：按名字找画师的一页。`next` 同 [`PixivSource::browse`]。
    pub fn search_artists(
        &mut self,
        word: &str,
        next: Option<&str>,
    ) -> Result<ArtistsPage, SourceError> {
        let path = match next {
            Some(next) => browse::checked_next(next)?,
            None => browse::first_artists_page(word)?,
        };
        browse::artists_page(&mut |path| self.get(path), &path)
    }

    /// 查一位画师。没有这位画师时为空。
    pub fn artist(&mut self, user_id: &str) -> Result<Option<Artist>, SourceError> {
        artist::artist(&mut |path| self.get(path), user_id)
    }

    /// 登录账号关注的画师（#369 从 pixiv 关注导入）。
    pub fn following(&mut self) -> Result<Vec<Artist>, SourceError> {
        let self_id = self.self_id()?;
        artist::following(&mut |path| self.get(path), &self_id)
    }

    /// 登录账号的 pixiv 用户 ID。
    fn self_id(&mut self) -> Result<String, SourceError> {
        let self_id = self.account.session()?.account.user_id;
        if self_id.is_empty() {
            return Err(SourceError::Unreadable);
        }
        Ok(self_id)
    }

    /// GET 一个客户端接口（`/v1/...` 或接口给的 `next_url`）。access token 被拒时换一次再试。
    pub fn get(&mut self, path: &str) -> Result<Value, SourceError> {
        let url = if path.starts_with("https://") {
            path.to_owned()
        } else {
            format!("{API}{path}")
        };
        for retry in [false, true] {
            if !self.pacers.api(self.priority, &self.cancel) {
                return Err(SourceError::Cancelled);
            }
            let session = self.account.session()?;
            let response = self
                .agent
                .get(&url)
                .set("Authorization", &format!("Bearer {}", session.access_token))
                .set("User-Agent", APP_UA)
                .set("App-OS", "ios")
                .set("App-OS-Version", "14.6")
                .set("Accept-Language", "ja")
                .call();
            match response {
                Ok(r) => return json(r).ok_or(SourceError::Unreadable),
                Err(ureq::Error::Status(status, r)) => {
                    let body = json(r).unwrap_or_default();
                    let message = body["error"]["message"].as_str().unwrap_or_default();
                    match classify(status, message) {
                        Some(SourceError::LoginExpired) if !retry => {
                            self.account.drop_session();
                            continue;
                        }
                        Some(error) => return Err(error),
                        None => return Err(SourceError::Status { status }),
                    }
                }
                Err(ureq::Error::Transport(_)) => return Err(SourceError::Network),
            }
        }
        Err(SourceError::LoginExpired)
    }
}

/// 客户端接口的错误：pixiv 限流时回 429，或回 403 并说明“Rate Limit”；access token 过期时
/// 回 400 并说明 OAuth 出错。
fn classify(status: u16, message: &str) -> Option<SourceError> {
    let lower = message.to_ascii_lowercase();
    match status {
        429 => Some(SourceError::RateLimited),
        403 if lower.contains("rate limit") => Some(SourceError::RateLimited),
        400 if lower.contains("oauth") || lower.contains("invalid_grant") => {
            Some(SourceError::LoginExpired)
        }
        _ => None,
    }
}

impl Source for PixivSource {
    fn id(&self) -> SourceId {
        SourceId::Pixiv
    }

    fn works(
        &mut self,
        subscription: &Subscription,
        enough: &mut dyn FnMut(&Work) -> bool,
    ) -> Result<Vec<Work>, SourceError> {
        match &subscription.target {
            Target::PixivArtist { user_id } => artist::works(
                &mut |path| self.get(path),
                user_id,
                subscription.include_manga,
                enough,
            ),
            Target::PixivRanking {
                period,
                top,
                explicit,
            } => ranking::works(&mut |path| self.get(path), *period, *explicit, *top),
            // 收藏夹不按发布时间排，走 `bookmarks`。
            Target::PixivBookmarks => Err(SourceError::Unsupported),
        }
    }

    fn bookmarks(
        &mut self,
        _: &Subscription,
        enough: &mut dyn FnMut(usize, &[Work]) -> bool,
    ) -> Result<Vec<Vec<Work>>, SourceError> {
        let self_id = self.self_id()?;
        bookmarks::works(&mut |path| self.get(path), &self_id, enough)
    }

    fn download(&mut self, url: &str) -> Result<Vec<u8>, SourceError> {
        if !self.pacers.download(self.priority, &self.cancel) {
            return Err(SourceError::Cancelled);
        }
        images::fetch(&self.agent, url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limits_and_expired_tokens_are_recognised() {
        assert_eq!(classify(429, ""), Some(SourceError::RateLimited));
        assert_eq!(classify(403, "Rate Limit"), Some(SourceError::RateLimited));
        assert_eq!(
            classify(400, "Error occurred at the OAuth process."),
            Some(SourceError::LoginExpired)
        );
        assert_eq!(classify(404, ""), None);
        assert_eq!(classify(403, "Forbidden"), None);
    }
}
