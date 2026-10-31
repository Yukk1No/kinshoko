//! 读 pixiv 客户端接口回的作品（`illusts[]` 或 `illust`）。

use serde_json::Value;

use crate::subscription::{Work, WorkKind};

/// pixiv 客户端接口里的一个作品。字段缺失（接口变了）时为空。
pub fn work_from_illust(v: &Value) -> Option<Work> {
    let id = match &v["id"] {
        Value::Number(n) => n.to_string(),
        Value::String(s) if !s.is_empty() => s.clone(),
        _ => return None,
    };
    let kind = match v["type"].as_str()? {
        "illust" => WorkKind::Illustration,
        "manga" => WorkKind::Manga,
        "ugoira" => WorkKind::Animation,
        _ => return None,
    };
    let multi: Vec<String> = v["meta_pages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["image_urls"]["original"].as_str().map(str::to_owned))
        .collect();
    let pages = if multi.is_empty() {
        v["meta_single_page"]["original_image_url"]
            .as_str()
            .map(str::to_owned)
            .into_iter()
            .collect()
    } else {
        multi
    };
    // 动图没有可收的页，照样返回，由检查记为“已跳过”。
    if pages.is_empty() && kind != WorkKind::Animation {
        return None;
    }
    Some(Work {
        page_url: format!("https://www.pixiv.net/artworks/{id}"),
        id,
        kind,
        explicit: v["x_restrict"].as_i64().unwrap_or(0) > 0,
        author: v["user"]["name"]
            .as_str()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_owned),
        tags: v["tags"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| t["name"].as_str().map(str::to_owned))
            .collect(),
        pages,
        posted_at: v["create_date"]
            .as_str()
            .and_then(parse_rfc3339)
            .unwrap_or(0),
    })
}

/// `2024-01-02T03:04:05+09:00` → Unix 毫秒。
pub(super) fn parse_rfc3339(s: &str) -> Option<i64> {
    let num = |range: std::ops::Range<usize>| -> Option<i64> { s.get(range)?.parse().ok() };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let rest = s.get(19..)?;
    let rest = rest
        .strip_prefix('.')
        .map(|r| r.trim_start_matches(|c: char| c.is_ascii_digit()))
        .unwrap_or(rest);
    let offset = match rest {
        "Z" | "z" => 0,
        _ => {
            let sign = match rest.get(0..1)? {
                "+" => 1,
                "-" => -1,
                _ => return None,
            };
            let oh: i64 = rest.get(1..3)?.parse().ok()?;
            let om: i64 = rest.get(4..6)?.parse().ok()?;
            sign * (oh * 3600 + om * 60)
        }
    };
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + sec - offset;
    Some(secs * 1000)
}

/// Unix 秒 → `2024-01-02T03:04:05+00:00`（pixiv 登录要的 `X-Client-Time`）。
pub(super) fn format_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}+00:00",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

// Howard Hinnant 的公历日期算法。
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + if m <= 2 { 1 } else { 0 }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dates_round_trip_through_utc() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00+00:00"), Some(0));
        assert_eq!(
            parse_rfc3339("2024-03-01T09:00:00+09:00"),
            Some(1_709_251_200_000)
        );
        assert_eq!(format_utc(1_709_251_200), "2024-03-01T00:00:00+00:00");
        assert_eq!(parse_rfc3339("2024-03-01"), None);
    }

    #[test]
    fn multi_page_illust_lists_every_original() {
        let v = json!({
            "id": 123, "type": "illust", "x_restrict": 1, "create_date": "2024-03-01T09:00:00+09:00",
            "user": { "name": " 画师 " }, "tags": [{ "name": "オリジナル" }, { "name": "女の子" }],
            "meta_single_page": {},
            "meta_pages": [
                { "image_urls": { "original": "https://i.pximg.net/img-original/123_p0.png" } },
                { "image_urls": { "original": "https://i.pximg.net/img-original/123_p1.png" } }
            ]
        });
        let work = work_from_illust(&v).unwrap();
        assert_eq!(work.id, "123");
        assert_eq!(work.kind, WorkKind::Illustration);
        assert!(work.explicit);
        assert_eq!(work.author.as_deref(), Some("画师"));
        assert_eq!(work.tags, ["オリジナル", "女の子"]);
        assert_eq!(work.pages.len(), 2);
        assert_eq!(work.page_url, "https://www.pixiv.net/artworks/123");
        assert_eq!(work.posted_at, 1_709_251_200_000);
    }

    #[test]
    fn single_page_and_animation() {
        let single = json!({
            "id": 5, "type": "manga", "x_restrict": 0, "meta_pages": [],
            "meta_single_page": { "original_image_url": "https://i.pximg.net/5_p0.jpg" }
        });
        let work = work_from_illust(&single).unwrap();
        assert_eq!(work.kind, WorkKind::Manga);
        assert!(!work.explicit);
        assert_eq!(work.pages, ["https://i.pximg.net/5_p0.jpg"]);

        let ugoira = json!({ "id": 6, "type": "ugoira", "meta_pages": [], "meta_single_page": {} });
        assert_eq!(work_from_illust(&ugoira).unwrap().kind, WorkKind::Animation);
        assert!(work_from_illust(&json!({ "id": 7, "type": "novel" })).is_none());
    }
}
