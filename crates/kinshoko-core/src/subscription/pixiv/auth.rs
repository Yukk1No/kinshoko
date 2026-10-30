//! pixiv 登录（#367 原型的结论）：PKCE。登录窗口打开 [`LoginRequest::url`]，画师照常登录，
//! 应用壳在跳到回调地址时截住 code（[`callback_code`]），再换成 refresh token。
//!
//! 走的是仿 pixiv 客户端的非官方接口；client id 与 secret 是 pixiv 客户端公开内置的值，
//! 与 gallery-dl、pixivpy 相同。日志与错误里从不出现 code、token 或账号。

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use md5::Md5;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use ts_rs::TS;

const CLIENT_ID: &str = "MOBrBDS8blbauoSck0ZfDbtuzpyT";
const CLIENT_SECRET: &str = "lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj";
const HASH_SECRET: &str = "28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c";
const REDIRECT_URI: &str = "https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback";
const TOKEN_URL: &str = "https://oauth.secure.pixiv.net/auth/token";
const AUTH_UA: &str = "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)";

/// 登录的 pixiv 账号。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Account {
    /// 显示名。
    pub name: String,
    /// 账号打开了 R-18 显示（`user.x_restrict` 大于 0）；没打开时不出现成人内容的选项。
    pub explicit_allowed: bool,
}

/// 一次登录的会话：access token 一小时过期，过期前用 refresh token 换新的。
#[derive(Clone)]
pub struct Session {
    pub(super) access_token: String,
    pub(super) expires_at: SystemTime,
    pub refresh_token: String,
    pub account: Account,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("account", &self.account)
            .finish_non_exhaustive()
    }
}

impl Session {
    /// 还剩不到一分钟就算过期，提前换。
    pub(super) fn expired(&self) -> bool {
        SystemTime::now() + Duration::from_secs(60) >= self.expires_at
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    /// pixiv 不认这个 refresh token 或 code：要重新登录。
    Rejected,
    /// 频率限制。
    RateLimited,
    Network,
    Status(u16),
    Unreadable,
}

/// 一次登录：随机的 code verifier 与对应的登录页地址。
pub struct LoginRequest {
    verifier: String,
}

impl Default for LoginRequest {
    fn default() -> Self {
        Self::new()
    }
}

impl LoginRequest {
    pub fn new() -> LoginRequest {
        let mut raw = [0u8; 32];
        raw[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        raw[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        LoginRequest {
            verifier: URL_SAFE_NO_PAD.encode(raw),
        }
    }

    /// 登录窗口要打开的地址。
    pub fn url(&self) -> String {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(self.verifier.as_bytes()));
        format!(
            "https://app-api.pixiv.net/web/v1/login?code_challenge={challenge}&code_challenge_method=S256&client=pixiv-android"
        )
    }

    /// 用截到的 code 换登录会话。
    pub fn finish(&self, code: &str) -> Result<Session, AuthError> {
        token(&[
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
            ("code", code),
            ("code_verifier", &self.verifier),
            ("grant_type", "authorization_code"),
            ("include_policy", "true"),
            ("redirect_uri", REDIRECT_URI),
        ])
    }
}

/// 登录窗口将要跳去的地址是回调时，取出其中的 code。不是回调时为空。
pub fn callback_code(url: &str) -> Option<String> {
    let is_callback = url.starts_with(REDIRECT_URI) || url.starts_with("pixiv://");
    if !is_callback {
        return None;
    }
    let query = url.split_once('?')?.1;
    query.split(['&', '#']).find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == "code" && !v.is_empty()).then(|| v.to_owned())
    })
}

/// 用 refresh token 换新的会话。
pub fn refresh(refresh_token: &str) -> Result<Session, AuthError> {
    token(&[
        ("client_id", CLIENT_ID),
        ("client_secret", CLIENT_SECRET),
        ("grant_type", "refresh_token"),
        ("include_policy", "true"),
        ("refresh_token", refresh_token),
    ])
}

fn client_time() -> (String, String) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let time = super::parse::format_utc(secs);
    let hash = Md5::digest(format!("{time}{HASH_SECRET}").as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    (time, hash)
}

fn token(form: &[(&str, &str)]) -> Result<Session, AuthError> {
    let (time, hash) = client_time();
    let response = super::api::agent()
        .post(TOKEN_URL)
        .set("User-Agent", AUTH_UA)
        .set("App-OS", "android")
        .set("X-Client-Time", &time)
        .set("X-Client-Hash", &hash)
        .send_form(form);
    match response {
        Ok(r) => session(&super::api::json(r).ok_or(AuthError::Unreadable)?),
        // pixiv 对作废的 refresh token 与 code 回 400（invalid_grant）。
        Err(ureq::Error::Status(400, _)) => Err(AuthError::Rejected),
        Err(ureq::Error::Status(429, _)) => Err(AuthError::RateLimited),
        Err(ureq::Error::Status(code, _)) => Err(AuthError::Status(code)),
        Err(ureq::Error::Transport(_)) => Err(AuthError::Network),
    }
}

fn session(v: &Value) -> Result<Session, AuthError> {
    let access_token = v["access_token"].as_str().ok_or(AuthError::Unreadable)?;
    let refresh_token = v["refresh_token"].as_str().ok_or(AuthError::Unreadable)?;
    let expires_in = v["expires_in"].as_u64().unwrap_or(3600);
    let user = &v["user"];
    Ok(Session {
        access_token: access_token.to_owned(),
        expires_at: SystemTime::now() + Duration::from_secs(expires_in),
        refresh_token: refresh_token.to_owned(),
        account: Account {
            name: user["name"].as_str().unwrap_or_default().to_owned(),
            explicit_allowed: user["x_restrict"].as_i64().unwrap_or(0) > 0,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_is_taken_only_from_the_callback() {
        assert_eq!(
            callback_code(&format!("{REDIRECT_URI}?state=x&code=abc-123")).as_deref(),
            Some("abc-123")
        );
        assert_eq!(
            callback_code("pixiv://account/login?code=xyz&via=login").as_deref(),
            Some("xyz")
        );
        assert_eq!(
            callback_code("https://accounts.pixiv.net/login?code=nope"),
            None
        );
        assert_eq!(callback_code(&format!("{REDIRECT_URI}?code=")), None);
    }

    #[test]
    fn login_url_carries_an_s256_challenge_of_the_verifier() {
        let request = LoginRequest::new();
        let url = request.url();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(request.verifier.as_bytes()));
        assert!(url.contains(&format!("code_challenge={challenge}&")));
        assert_ne!(request.verifier, LoginRequest::new().verifier);
    }

    #[test]
    fn session_reads_the_account_and_r18_permission() {
        let v = serde_json::json!({
            "access_token": "a", "refresh_token": "r", "expires_in": 3600,
            "user": { "name": "画师", "x_restrict": 1 }
        });
        let s = session(&v).unwrap();
        assert_eq!(s.account.name, "画师");
        assert!(s.account.explicit_allowed);
        assert!(!s.expired());
        assert!(!format!("{s:?}").contains("\"r\""));
    }
}
