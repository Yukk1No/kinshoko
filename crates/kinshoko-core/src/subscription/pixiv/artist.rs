//! pixiv 画师（#369）：认出画师主页链接或 ID，翻画师的作品，读画师资料与登录账号的关注。
//! 接口请求由调用方给（`get`），这里只管翻页与读回应，测试用假回应。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::parse::work_from_illust;
use crate::subscription::{SourceError, Work};

/// GET 一个客户端接口（`/v1/...` 或接口给的 `next_url`）。
pub(super) type Get<'a> = dyn FnMut(&str) -> Result<Value, SourceError> + 'a;

/// 一位 pixiv 画师。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Artist {
    pub user_id: String,
    pub name: String,
}

/// 从画师主页链接或数字 ID 认出画师 ID：`https://www.pixiv.net/users/123`（含 `/en/` 等语言前缀
/// 与 `/illustrations` 等后缀）、旧式的 `member.php?id=123` 与 `member_illust.php?id=123`、`123`。
/// 认不出时为空。
pub fn artist_id(input: &str) -> Option<String> {
    let input = input.trim();
    let digits = |s: &str| -> Option<String> {
        let id: String = s.chars().take_while(char::is_ascii_digit).collect();
        (!id.is_empty() && id.len() <= 20).then_some(id)
    };
    if input.chars().all(|c| c.is_ascii_digit()) {
        return digits(input);
    }
    let rest = input
        .strip_prefix("https://")
        .or_else(|| input.strip_prefix("http://"))
        .unwrap_or(input);
    let (host, path) = rest.split_once('/')?;
    if !matches!(host, "www.pixiv.net" | "pixiv.net") {
        return None;
    }
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if let Some(at) = segments.iter().position(|s| *s == "users") {
        let id = segments.get(at + 1)?;
        return digits(id).filter(|d| d == id);
    }
    if matches!(
        segments.last(),
        Some(&"member.php") | Some(&"member_illust.php")
    ) {
        let id = query.split('&').find_map(|pair| pair.strip_prefix("id="))?;
        return digits(id).filter(|d| d == id);
    }
    None
}

/// 画师的作品，从新到旧：插画（含动图）一条流，打开漫画时再翻漫画一条流，合起来按发布时间排。
/// 每条流在 `enough` 回真的作品处停下。
pub(super) fn works(
    get: &mut Get<'_>,
    user_id: &str,
    include_manga: bool,
    enough: &mut dyn FnMut(&Work) -> bool,
) -> Result<Vec<Work>, SourceError> {
    let mut out = Vec::new();
    let feeds: &[&str] = if include_manga {
        &["illust", "manga"]
    } else {
        &["illust"]
    };
    for feed in feeds {
        let mut next = Some(format!(
            "/v1/user/illusts?user_id={user_id}&type={feed}&filter=for_ios"
        ));
        'pages: while let Some(path) = next.take() {
            let page = get(&path)?;
            let illusts = page["illusts"].as_array().ok_or(SourceError::Unreadable)?;
            for illust in illusts {
                let Some(work) = work_from_illust(illust) else {
                    continue;
                };
                let stop = enough(&work);
                out.push(work);
                if stop {
                    break 'pages;
                }
            }
            next = next_url(&page);
        }
    }
    // 稳定排序：发布时间相同的保持接口给的先后。
    out.sort_by_key(|w| std::cmp::Reverse(w.posted_at));
    Ok(out)
}

/// 画师资料。没有这位画师（或已退会）时为空。
pub(super) fn artist(get: &mut Get<'_>, user_id: &str) -> Result<Option<Artist>, SourceError> {
    match get(&format!("/v1/user/detail?user_id={user_id}&filter=for_ios")) {
        Ok(v) => Ok(user(&v["user"])),
        Err(SourceError::Status { status: 404 }) => Ok(None),
        Err(e) => Err(e),
    }
}

/// 登录账号关注的画师：公开与非公开的关注都读，去掉重复，按 pixiv 给的先后（最近关注的在前）。
pub(super) fn following(get: &mut Get<'_>, self_id: &str) -> Result<Vec<Artist>, SourceError> {
    let mut out: Vec<Artist> = Vec::new();
    for restrict in ["public", "private"] {
        let mut next = Some(format!(
            "/v1/user/following?user_id={self_id}&restrict={restrict}"
        ));
        while let Some(path) = next.take() {
            let page = get(&path)?;
            let previews = page["user_previews"]
                .as_array()
                .ok_or(SourceError::Unreadable)?;
            for artist in previews.iter().filter_map(|p| user(&p["user"])) {
                if !out.iter().any(|a| a.user_id == artist.user_id) {
                    out.push(artist);
                }
            }
            next = next_url(&page);
        }
    }
    Ok(out)
}

fn user(v: &Value) -> Option<Artist> {
    let user_id = match &v["id"] {
        Value::Number(n) => n.to_string(),
        Value::String(s) if !s.is_empty() => s.clone(),
        _ => return None,
    };
    let name = v["name"].as_str().map(str::trim).unwrap_or_default();
    Some(Artist {
        name: if name.is_empty() {
            user_id.clone()
        } else {
            name.to_owned()
        },
        user_id,
    })
}

pub(super) fn next_url(page: &Value) -> Option<String> {
    page["next_url"]
        .as_str()
        .filter(|u| u.starts_with("https://app-api.pixiv.net/"))
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn artist_links_and_ids_are_recognised() {
        for (input, id) in [
            ("123456", Some("123456")),
            (" 123456 ", Some("123456")),
            ("https://www.pixiv.net/users/123456", Some("123456")),
            (
                "https://www.pixiv.net/en/users/123456/illustrations",
                Some("123456"),
            ),
            ("www.pixiv.net/users/123456", Some("123456")),
            ("https://www.pixiv.net/member.php?id=123456", Some("123456")),
            (
                "https://www.pixiv.net/member_illust.php?mode=medium&id=77",
                Some("77"),
            ),
            ("https://www.pixiv.net/artworks/123456", None),
            ("https://example.com/users/123456", None),
            ("https://www.pixiv.net/users/12ab", None),
            ("pixiv", None),
            ("", None),
        ] {
            assert_eq!(artist_id(input).as_deref(), id, "{input}");
        }
    }

    fn illust(id: u64, kind: &str, date: &str) -> Value {
        json!({
            "id": id, "type": kind, "x_restrict": 0, "create_date": date,
            "user": { "name": "画师" }, "tags": [], "meta_pages": [],
            "meta_single_page": { "original_image_url": format!("https://i.pximg.net/{id}_p0.png") }
        })
    }

    /// 按路径回假回应，记下请求过哪些路径。
    fn fake(
        pages: HashMap<String, Value>,
        asked: &mut Vec<String>,
    ) -> impl FnMut(&str) -> Result<Value, SourceError> + '_ {
        move |path| {
            asked.push(path.to_owned());
            pages
                .get(path)
                .cloned()
                .ok_or(SourceError::Status { status: 404 })
        }
    }

    #[test]
    fn works_page_through_feeds_and_stop_where_told() {
        let next = "https://app-api.pixiv.net/v1/user/illusts?user_id=9&type=illust&offset=30";
        let pages = HashMap::from([
            (
                "/v1/user/illusts?user_id=9&type=illust&filter=for_ios".to_owned(),
                json!({
                    "illusts": [illust(5, "illust", "2024-03-05T00:00:00+09:00"), illust(4, "ugoira", "2024-03-04T00:00:00+09:00")],
                    "next_url": next
                }),
            ),
            (
                next.to_owned(),
                json!({
                    "illusts": [illust(2, "illust", "2024-03-02T00:00:00+09:00"), illust(1, "illust", "2024-03-01T00:00:00+09:00")],
                    "next_url": null
                }),
            ),
            (
                "/v1/user/illusts?user_id=9&type=manga&filter=for_ios".to_owned(),
                json!({
                    "illusts": [illust(3, "manga", "2024-03-03T00:00:00+09:00")], "next_url": null
                }),
            ),
        ]);
        let mut asked = Vec::new();
        let mut get = fake(pages.clone(), &mut asked);
        let all = works(&mut get, "9", true, &mut |_| false).unwrap();
        let ids: Vec<_> = all.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["5", "4", "3", "2", "1"]);

        // 在作品 4 处停下：不翻第二页；漫画没打开时不翻漫画。
        let mut asked = Vec::new();
        let mut get = fake(pages, &mut asked);
        let some = works(&mut get, "9", false, &mut |w| w.id == "4").unwrap();
        assert_eq!(some.len(), 2);
        drop(get);
        assert_eq!(
            asked,
            ["/v1/user/illusts?user_id=9&type=illust&filter=for_ios"]
        );
    }

    #[test]
    fn missing_artist_and_following_are_read() {
        let pages = HashMap::from([
            (
                "/v1/user/detail?user_id=9&filter=for_ios".to_owned(),
                json!({ "user": { "id": 9, "name": " 画师 " } }),
            ),
            (
                "/v1/user/following?user_id=1&restrict=public".to_owned(),
                json!({
                    "user_previews": [{ "user": { "id": 9, "name": "画师" } }, { "user": { "id": 8, "name": "" } }],
                    "next_url": null
                }),
            ),
            (
                "/v1/user/following?user_id=1&restrict=private".to_owned(),
                json!({
                    "user_previews": [{ "user": { "id": 9, "name": "画师" } }, { "user": { "id": 7, "name": "另一位" } }]
                }),
            ),
        ]);
        let mut asked = Vec::new();
        let mut get = fake(pages, &mut asked);
        assert_eq!(
            artist(&mut get, "9").unwrap(),
            Some(Artist {
                user_id: "9".into(),
                name: "画师".into()
            })
        );
        assert_eq!(artist(&mut get, "10").unwrap(), None);
        let follows = following(&mut get, "1").unwrap();
        let names: Vec<_> = follows
            .iter()
            .map(|a| (a.user_id.as_str(), a.name.as_str()))
            .collect();
        assert_eq!(names, [("9", "画师"), ("8", "8"), ("7", "另一位")]);
    }
}
