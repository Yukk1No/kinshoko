//! 什么时候检查（#366、#368）。
//!
//! 只在 Kinshoko 运行时（含托盘）检查，所以按“上次检查到现在隔了多久”判断：退出期间错过的检查，
//! 重新打开后立即补上，不会一次补多轮。遇到频率限制时，整个订阅来源退避到约定时间。

use super::{SourceId, Subscription};

/// 第一次退避 15 分钟，连续再遇到时翻倍，最多 24 小时。
const FIRST_BACKOFF_MS: i64 = 15 * 60 * 1000;
const MAX_BACKOFF_MS: i64 = 24 * 60 * 60 * 1000;

/// `now` 时到期的订阅，按上次检查从早到晚（从没检查过的最先）。`backed_off` 返回某个来源
/// 此刻是否在退避中；退避中的来源一条都不查。
pub fn due<'a>(
    subscriptions: &'a [Subscription],
    now: i64,
    backed_off: impl Fn(SourceId) -> bool,
) -> Vec<&'a Subscription> {
    let mut due: Vec<&Subscription> = subscriptions
        .iter()
        .filter(|s| !backed_off(s.target.source()))
        .filter(|s| match s.last_checked_at {
            None => true,
            Some(at) => now - at >= s.target.check_interval_ms() || at > now,
        })
        .collect();
    due.sort_by_key(|s| s.last_checked_at.unwrap_or(i64::MIN));
    due
}

/// 第 `level` 次连续遇到频率限制（从 0 起）后要退避多久。
pub fn backoff_ms(level: u32) -> i64 {
    FIRST_BACKOFF_MS
        .saturating_mul(1i64 << level.min(16))
        .min(MAX_BACKOFF_MS)
}

/// 下次最早什么时候有订阅到期；没有订阅时为空。应用壳据此决定睡多久。
pub fn next_due(subscriptions: &[Subscription], now: i64) -> Option<i64> {
    subscriptions
        .iter()
        .map(|s| match s.last_checked_at {
            None => now,
            Some(at) if at > now => now,
            Some(at) => at + s.target.check_interval_ms(),
        })
        .min()
}
