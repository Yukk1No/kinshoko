//! 时间点：Unix 毫秒加上当时的本地时区偏移。“每天”“每周”都按画师的本地日期算，
//! 偏移由应用壳取得后传进来，核心不读系统时区。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Stamp {
    #[ts(type = "number")]
    pub unix_ms: i64,
    /// 本地时间比 UTC 早多少分钟（东八区为 480）。
    pub offset_minutes: i32,
}

impl Stamp {
    pub fn new(unix_ms: i64, offset_minutes: i32) -> Stamp {
        Stamp {
            unix_ms,
            offset_minutes,
        }
    }

    fn local_ms(self) -> i64 {
        self.unix_ms + i64::from(self.offset_minutes) * 60 * 1000
    }

    /// 本地日期（自 1970-01-01 起的天数）。
    pub fn local_day(self) -> i64 {
        self.local_ms().div_euclid(DAY_MS)
    }

    /// 本地日期所在的周（周一开始）。1970-01-01 是星期四。
    pub fn local_week(self) -> i64 {
        (self.local_day() + 3).div_euclid(7)
    }

    /// 本地日期与时间：`(年, 月, 日, 时, 分, 秒)`。
    pub fn local_parts(self) -> (i64, u32, u32, u32, u32, u32) {
        let (y, m, d) = civil_from_days(self.local_day());
        let secs = self.local_ms().rem_euclid(DAY_MS) / 1000;
        (
            y,
            m,
            d,
            (secs / 3600) as u32,
            (secs / 60 % 60) as u32,
            (secs % 60) as u32,
        )
    }

    /// `YYYY-MM-DD`。
    pub fn local_date(self) -> String {
        let (y, m, d, ..) = self.local_parts();
        format!("{y:04}-{m:02}-{d:02}")
    }
}

/// 天数 → 公历日期（Howard Hinnant 的算法）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
