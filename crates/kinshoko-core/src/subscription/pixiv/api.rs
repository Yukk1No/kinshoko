//! pixiv 客户端接口与原图下载。每个请求前按节拍等待；频率限制与登录失效交给检查停下。

use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use serde_json::Value;

use super::account::PixivAccount;
use super::auth::AuthError;
use crate::subscription::pace::{API_GAP, DOWNLOAD_GAP, Pacer};
use crate::subscription::{Source, SourceError, SourceId, Subscription, Work};

const API: &str = "https://app-api.pixiv.net";
const APP_UA: &str = "PixivIOSApp/7.13.3 (iOS 14.6; iPhone13,2)";
/// `i.pximg.net` 的原图不带 pixiv 的 Referer 时回 403（#367 实测）。
const IMAGE_REFERER: &str = "https://app-api.pixiv.net/";
/// 单张原图的上限：pixiv 原图最大约 50 MB，超过的多半不是图。
const MAX_IMAGE_BYTES: u64 = 200 * 1024 * 1024;

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
    api_pacer: Pacer,
    download_pacer: Pacer,
    cancel: Arc<AtomicBool>,
}

impl PixivSource {
    pub fn new(account: Arc<PixivAccount>, cancel: Arc<AtomicBool>) -> PixivSource {
        PixivSource {
            account,
            agent: agent(),
            api_pacer: Pacer::new(API_GAP),
            download_pacer: Pacer::new(DOWNLOAD_GAP),
            cancel,
        }
    }

    /// GET 一个客户端接口（`/v1/...` 或接口给的 `next_url`）。access token 被拒时换一次再试。
    pub fn get(&mut self, path: &str) -> Result<Value, SourceError> {
        let url = if path.starts_with("https://") {
            path.to_owned()
        } else {
            format!("{API}{path}")
        };
        for retry in [false, true] {
            if !self.api_pacer.wait(&self.cancel) {
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
        _subscription: &Subscription,
        _known: &mut dyn FnMut(&str) -> bool,
    ) -> Result<Vec<Work>, SourceError> {
        // 画师、榜单与收藏夹分别在 #369、#370、#371 接上。
        Err(SourceError::Unsupported)
    }

    fn download(&mut self, url: &str) -> Result<Vec<u8>, SourceError> {
        if !self.download_pacer.wait(&self.cancel) {
            return Err(SourceError::Cancelled);
        }
        let response = self
            .agent
            .get(url)
            .set("Referer", IMAGE_REFERER)
            .set("User-Agent", APP_UA)
            .call();
        match response {
            Ok(r) => {
                let mut bytes = Vec::new();
                r.into_reader()
                    .take(MAX_IMAGE_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| SourceError::Network)?;
                if bytes.len() as u64 > MAX_IMAGE_BYTES {
                    return Err(SourceError::Unreadable);
                }
                Ok(bytes)
            }
            Err(ureq::Error::Status(429, _)) => Err(SourceError::RateLimited),
            Err(ureq::Error::Status(status, _)) => Err(SourceError::Status { status }),
            Err(ureq::Error::Transport(_)) => Err(SourceError::Network),
        }
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
