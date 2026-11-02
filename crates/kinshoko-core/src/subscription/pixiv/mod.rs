//! pixiv 订阅来源：登录、客户端接口与原图下载。都是非官方接口（#366），请求一律放慢。

mod account;
mod api;
mod artist;
mod auth;
mod bookmarks;
mod parse;
mod ranking;

pub use account::{LoginState, PixivAccount};
pub use api::PixivSource;
pub use artist::{Artist, artist_id};
pub use auth::{Account, AuthError, LoginRequest, Session, callback_code};
pub use parse::work_from_illust;
