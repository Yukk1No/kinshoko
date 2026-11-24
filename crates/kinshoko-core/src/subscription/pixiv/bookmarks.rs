//! 登录账号的 pixiv 收藏夹（#371）：公开与非公开收藏各一条流，按收藏先后从近到远翻页。
//! 接口请求由调用方给（`get`），这里只管翻页与读回应，测试用假回应。

use super::artist::{Get, next_url};
use super::parse::work_from_illust;
use crate::subscription::{SourceError, Work};

/// 两条收藏流，[`crate::subscription::Source::bookmarks`] 按这个顺序给。
const RESTRICTS: [&str; 2] = ["public", "private"];

/// 每条流读到的作品，按收藏先后从近到远。每读一页问一次 `enough`（流的序号与这一页读得懂的作品），
/// 回真时这条流不再往下翻；这一页照样整页列出。已删除或看不到的作品读不懂，不列出。
pub(super) fn works(
    get: &mut Get<'_>,
    self_id: &str,
    enough: &mut dyn FnMut(usize, &[Work]) -> bool,
) -> Result<Vec<Vec<Work>>, SourceError> {
    let mut feeds = Vec::new();
    for (feed, restrict) in RESTRICTS.iter().enumerate() {
        let mut out = Vec::new();
        let mut next = Some(format!(
            "/v1/user/bookmarks/illust?user_id={self_id}&restrict={restrict}&filter=for_ios"
        ));
        while let Some(path) = next.take() {
            let page = get(&path)?;
            let illusts = page["illusts"].as_array().ok_or(SourceError::Unreadable)?;
            let works: Vec<Work> = illusts.iter().filter_map(work_from_illust).collect();
            let stop = enough(feed, &works);
            out.extend(works);
            if !stop {
                next = next_url(&page);
            }
        }
        feeds.push(out);
    }
    Ok(feeds)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::collections::HashMap;

    fn illust(id: u64) -> Value {
        json!({
            "id": id, "type": "illust", "x_restrict": 0, "create_date": "2020-03-01T00:00:00+09:00",
            "user": { "name": "画师" }, "tags": [], "meta_pages": [],
            "meta_single_page": { "original_image_url": format!("https://i.pximg.net/{id}_p0.png") }
        })
    }

    fn page(ids: std::ops::RangeInclusive<u64>, next: Option<&str>) -> Value {
        json!({ "illusts": ids.map(illust).collect::<Vec<_>>(), "next_url": next })
    }

    #[test]
    fn public_and_private_bookmarks_page_until_enough() {
        let public = "/v1/user/bookmarks/illust?user_id=11&restrict=public&filter=for_ios";
        let public_2 = "https://app-api.pixiv.net/v1/user/bookmarks/illust?user_id=11&restrict=public&max_bookmark_id=9";
        let private = "/v1/user/bookmarks/illust?user_id=11&restrict=private&filter=for_ios";
        let mut deleted = page(5..=6, None);
        // pixiv 把删掉的作品留在收藏夹里，只剩空壳。
        deleted["illusts"][1] =
            json!({ "id": 6, "type": "illust", "meta_pages": [], "meta_single_page": {} });
        let pages = HashMap::from([
            (public, page(1..=3, Some(public_2))),
            (
                public_2,
                page(4..=4, Some("https://app-api.pixiv.net/never")),
            ),
            (private, deleted),
        ]);
        let mut asked = Vec::new();
        let mut get = |path: &str| {
            asked.push(path.to_owned());
            pages
                .get(path)
                .cloned()
                .ok_or(SourceError::Status { status: 404 })
        };
        let mut seen = Vec::new();
        let feeds = works(&mut get, "11", &mut |feed, works| {
            seen.push((feed, works.len()));
            works.iter().any(|w| w.id == "4")
        })
        .unwrap();
        let ids: Vec<Vec<&str>> = feeds
            .iter()
            .map(|f| f.iter().map(|w| w.id.as_str()).collect())
            .collect();
        assert_eq!(ids, [vec!["1", "2", "3", "4"], vec!["5"]]);
        assert_eq!(seen, [(0, 3), (0, 1), (1, 1)]);
        assert_eq!(asked, [public, public_2, private]);
    }
}
