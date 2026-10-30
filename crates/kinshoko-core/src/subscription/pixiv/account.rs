//! 本机保存的 pixiv 登录：只存 refresh token 与账号显示信息，放在本设备数据目录，
//! 不进程序设置备份。退出登录时删掉。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::auth::{self, Account, AuthError, Session};

const FILE: &str = "pixiv-account.json";

/// 订阅页显示的登录状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
#[ts(export)]
pub enum LoginState {
    LoggedOut,
    LoggedIn {
        account: Account,
    },
    /// 登录失效（例如在 pixiv 改了密码）：检查暂停，重新登录后继续。
    Expired {
        account: Account,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    refresh_token: String,
    account: Account,
    #[serde(default)]
    expired: bool,
}

struct State {
    saved: Option<Saved>,
    /// 本次运行中换到的会话；access token 过期前复用。
    session: Option<Session>,
}

/// pixiv 登录。线程安全：订阅检查线程与界面命令共用一份。
pub struct PixivAccount {
    path: PathBuf,
    state: Mutex<State>,
}

impl PixivAccount {
    /// 读 `dir/pixiv-account.json`；没有或读不懂时为未登录。
    pub fn open(dir: &Path) -> PixivAccount {
        let path = dir.join(FILE);
        let saved = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        PixivAccount {
            path,
            state: Mutex::new(State {
                saved,
                session: None,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn state(&self) -> LoginState {
        match &self.lock().saved {
            None => LoginState::LoggedOut,
            Some(s) if s.expired => LoginState::Expired {
                account: s.account.clone(),
            },
            Some(s) => LoginState::LoggedIn {
                account: s.account.clone(),
            },
        }
    }

    /// 登录窗口换到会话后记下它。
    pub fn logged_in(&self, session: Session) -> io::Result<()> {
        let mut state = self.lock();
        let saved = Saved {
            refresh_token: session.refresh_token.clone(),
            account: session.account.clone(),
            expired: false,
        };
        write(&self.path, &saved)?;
        state.saved = Some(saved);
        state.session = Some(session);
        Ok(())
    }

    /// 退出登录：删掉本机保存的登录。
    pub fn log_out(&self) -> io::Result<()> {
        let mut state = self.lock();
        state.saved = None;
        state.session = None;
        match fs::remove_file(&self.path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    /// 可用的会话：access token 快过期时用 refresh token 换新的；pixiv 不认时标为登录失效。
    /// 没登录或已失效时不联网。
    pub fn session(&self) -> Result<Session, AuthError> {
        let mut state = self.lock();
        if let Some(session) = &state.session
            && !session.expired()
        {
            return Ok(session.clone());
        }
        let refresh_token = match &state.saved {
            Some(saved) if !saved.expired => saved.refresh_token.clone(),
            _ => return Err(AuthError::Rejected),
        };
        match auth::refresh(&refresh_token) {
            Ok(session) => {
                let saved = Saved {
                    refresh_token: session.refresh_token.clone(),
                    account: session.account.clone(),
                    expired: false,
                };
                // 写不进去时本次运行照样可用，下次启动用旧的 refresh token 再换。
                let _ = write(&self.path, &saved);
                state.saved = Some(saved);
                state.session = Some(session.clone());
                Ok(session)
            }
            Err(AuthError::Rejected) => {
                Self::expire(&self.path, &mut state);
                Err(AuthError::Rejected)
            }
            Err(e) => Err(e),
        }
    }

    /// 接口说 access token 不能用了：丢掉本次的会话，下次先换新的。
    pub fn drop_session(&self) {
        self.lock().session = None;
    }

    fn expire(path: &Path, state: &mut State) {
        state.session = None;
        if let Some(saved) = &mut state.saved {
            saved.expired = true;
            let _ = write(path, saved);
        }
    }
}

fn write(path: &Path, saved: &Saved) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(saved).map_err(io::Error::other)?)?;
    fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_login_survives_reopen_and_log_out_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let account = PixivAccount::open(dir.path());
        assert_eq!(account.state(), LoginState::LoggedOut);
        assert_eq!(account.session().unwrap_err(), AuthError::Rejected);

        let session = Session {
            access_token: "a".into(),
            expires_at: std::time::SystemTime::now() + std::time::Duration::from_secs(3600),
            refresh_token: "r".into(),
            account: Account {
                name: "画师".into(),
                explicit_allowed: false,
            },
        };
        account.logged_in(session).unwrap();
        assert!(matches!(account.state(), LoginState::LoggedIn { .. }));
        // 会话没过期时不联网就能拿到。
        assert_eq!(account.session().unwrap().access_token, "a");

        let reopened = PixivAccount::open(dir.path());
        assert!(
            matches!(reopened.state(), LoginState::LoggedIn { account } if account.name == "画师")
        );

        reopened.log_out().unwrap();
        assert_eq!(reopened.state(), LoginState::LoggedOut);
        assert!(!dir.path().join(FILE).exists());
    }

    #[test]
    fn expired_login_does_not_touch_the_network() {
        let dir = tempfile::tempdir().unwrap();
        let saved = Saved {
            refresh_token: "r".into(),
            account: Account {
                name: "画师".into(),
                explicit_allowed: true,
            },
            expired: true,
        };
        write(&dir.path().join(FILE), &saved).unwrap();
        let account = PixivAccount::open(dir.path());
        assert!(matches!(account.state(), LoginState::Expired { .. }));
        assert_eq!(account.session().unwrap_err(), AuthError::Rejected);
    }
}
