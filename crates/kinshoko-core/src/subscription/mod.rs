//! 订阅（#366、#368）：画师订阅喜欢的画师、pixiv 收藏夹和榜单，新作品自动收进资料库。
//!
//! - **订阅**是 Kinshoko 自己维护的一条名单项：从哪个**订阅来源**（目前只有 pixiv）的什么对象
//!   收图、收进哪个资料库、收不收成人作品与漫画。
//! - **已收作品**按资料库记下：收过的作品（包括后来被画师删掉的）不再下载；动图跳过，也记下。
//! - 检查只在 Kinshoko 运行时进行（[`schedule`]）；请求放慢，遇到频率限制整体退避（[`pace`]）。
//! - 下载的图走资料库的普通导入（[`crate::library::Library::import_from_subscription`]）。
//!
//! 这一块不依赖 Tauri；登录窗口、定时线程和托盘在应用壳里。

mod check;
pub mod pace;
pub mod pixiv;
pub mod schedule;
mod store;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use check::{CheckReport, Destination, Source, SourceError, Work, WorkKind, check};
pub use store::{ReceivedImage, Store, StoreError};

/// 订阅来源。以后加来源时在这里加一项，入口与开关不变。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SourceId {
    Pixiv,
}

impl SourceId {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceId::Pixiv => "pixiv",
        }
    }

    fn parse(s: &str) -> Option<SourceId> {
        match s {
            "pixiv" => Some(SourceId::Pixiv),
            _ => None,
        }
    }
}

/// pixiv 榜单的周期。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RankingPeriod {
    Day,
    Week,
    Month,
}

/// 订阅的对象：订阅来源里的一位画师、一个榜单或画师自己的收藏夹。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum Target {
    /// pixiv 画师（#369）。
    #[serde(rename_all = "camelCase")]
    PixivArtist { user_id: String },
    /// pixiv 日榜、周榜或月榜的前若干名（#370）。
    #[serde(rename_all = "camelCase")]
    PixivRanking { period: RankingPeriod, top: u32 },
    /// 登录账号的 pixiv 收藏夹，公开与非公开都收（#371）。不是 GLOSSARY 里的“收藏”。
    PixivBookmarks,
}

const HOUR_MS: i64 = 60 * 60 * 1000;

impl Target {
    pub fn source(&self) -> SourceId {
        match self {
            Target::PixivArtist { .. } | Target::PixivRanking { .. } | Target::PixivBookmarks => {
                SourceId::Pixiv
            }
        }
    }

    /// 两次检查之间至少隔多久（#366）：画师与收藏夹每 6 小时，榜单每天一次。
    pub fn check_interval_ms(&self) -> i64 {
        match self {
            Target::PixivArtist { .. } | Target::PixivBookmarks => 6 * HOUR_MS,
            Target::PixivRanking { .. } => 24 * HOUR_MS,
        }
    }
}

/// 一条订阅。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Subscription {
    pub id: String,
    pub target: Target,
    /// 名单上显示的名字，例如画师名或“日榜前 50”。
    pub name: String,
    /// 收进哪个资料库。
    pub library_id: String,
    /// 收不收来源标为成人的作品（#366 默认收）。
    pub include_explicit: bool,
    /// 收不收漫画类型（#366 默认不收）。
    pub include_manga: bool,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number | null")]
    pub last_checked_at: Option<i64>,
    /// 上次检查没完成的原因；成功后清空。
    pub last_error: Option<SourceError>,
}

/// 新建订阅时由画师决定的部分。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NewSubscription {
    pub target: Target,
    pub name: String,
    pub library_id: String,
    pub include_explicit: bool,
    pub include_manga: bool,
}

/// 订阅入口与托盘要显示的状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SubscriptionStatus {
    /// 设置里的订阅开关；关掉后不显示入口、不检查、不联网。
    pub enabled: bool,
    pub login: pixiv::LoginState,
    /// 正在检查。
    pub checking: bool,
    /// 新图数量（按页计）。安全模式开着时不计成人作品。
    pub new_count: u32,
    /// 遇到频率限制后，到这个时间（Unix 毫秒）之前不检查。
    #[ts(type = "number | null")]
    pub backoff_until: Option<i64>,
}
