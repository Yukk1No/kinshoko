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
    s.parse::<jiff::Timestamp>()
        .ok()
        .map(|t| t.as_millisecond())
}

/// Unix 秒 → `2024-01-02T03:04:05+00:00`（pixiv 登录要的 `X-Client-Time`）。
pub(super) fn format_utc(secs: i64) -> String {
    let at = jiff::Timestamp::from_second(secs).unwrap_or(jiff::Timestamp::UNIX_EPOCH);
    at.strftime("%Y-%m-%dT%H:%M:%S+00:00").to_string()
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
