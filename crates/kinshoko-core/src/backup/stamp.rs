//! 时间点：Unix 毫秒加上当时的本地时区偏移。“每天”“每周”都按画师的本地日期算，
//! 偏移由应用壳取得后传进来，核心不读系统时区。

use jiff::Timestamp;
use jiff::civil::DateTime;
use jiff::tz::Offset;
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

    /// 本地日期与时间。超出 jiff 范围（约 ±9999 年）的时间点按 1970-01-01 UTC 算。
    pub fn local_datetime(self) -> DateTime {
        let at = Timestamp::from_millisecond(self.unix_ms).unwrap_or(Timestamp::UNIX_EPOCH);
        let offset =
            Offset::from_seconds(self.offset_minutes.saturating_mul(60)).unwrap_or(Offset::UTC);
        offset.to_datetime(at)
    }

    /// `YYYY-MM-DD`。
    pub fn local_date(self) -> String {
        self.local_datetime().date().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2024-02-29T16:30:00Z
    const AT: i64 = 1_709_224_200_000;

    #[test]
    fn the_local_date_and_time_follow_the_offset() {
        let east = Stamp::new(AT, 480);
        assert_eq!(east.local_date(), "2024-03-01");
        assert_eq!(
            east.local_datetime().strftime("%Y%m%d-%H%M%S").to_string(),
            "20240301-003000"
        );
        assert_eq!(Stamp::new(AT, -300).local_date(), "2024-02-29");
    }
}
