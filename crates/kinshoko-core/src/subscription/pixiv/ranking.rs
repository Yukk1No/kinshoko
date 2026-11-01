//! pixiv 榜单（#370）：日榜、周榜、月榜，以及 R-18 日榜与周榜的前若干名。
//! 接口请求由调用方给（`get`），这里只管翻页与读回应，测试用假回应。

use super::artist::{Get, next_url};
use super::parse::work_from_illust;
use crate::subscription::{RankingPeriod, SourceError, Work};

/// 客户端接口的榜单 mode。pixiv 没有 R-18 月榜，这时为空。
fn mode(period: RankingPeriod, explicit: bool) -> Option<&'static str> {
    match (period, explicit) {
        (RankingPeriod::Day, false) => Some("day"),
        (RankingPeriod::Week, false) => Some("week"),
        (RankingPeriod::Month, false) => Some("month"),
        (RankingPeriod::Day, true) => Some("day_r18"),
        (RankingPeriod::Week, true) => Some("week_r18"),
        (RankingPeriod::Month, true) => None,
    }
}

/// 当前榜单上第 1 到第 `top` 名的作品，按名次。名次按 pixiv 列出的先后数，读不懂的作品也占一个名次，
/// 所以返回的可能少于 `top` 个；榜上不够 `top` 名时有多少给多少。
pub(super) fn works(
    get: &mut Get<'_>,
    period: RankingPeriod,
    explicit: bool,
    top: u32,
) -> Result<Vec<Work>, SourceError> {
    let mode = mode(period, explicit).ok_or(SourceError::Unsupported)?;
    let mut out = Vec::new();
    let mut ranked = 0;
    let mut next = Some(format!("/v1/illust/ranking?mode={mode}&filter=for_ios"));
    while let Some(path) = next.take() {
        let page = get(&path)?;
        let illusts = page["illusts"].as_array().ok_or(SourceError::Unreadable)?;
        for illust in illusts {
            if ranked == top {
                return Ok(out);
            }
            ranked += 1;
            out.extend(work_from_illust(illust));
        }
        if ranked == top {
            break;
        }
        next = next_url(&page);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::collections::HashMap;

    fn illust(id: u64) -> Value {
        json!({
            "id": id, "type": "illust", "x_restrict": 0, "create_date": "2024-03-01T00:00:00+09:00",
            "user": { "name": "画师" }, "tags": [], "meta_pages": [],
            "meta_single_page": { "original_image_url": format!("https://i.pximg.net/{id}_p0.png") }
        })
    }

    fn page(ids: std::ops::RangeInclusive<u64>, next: Option<&str>) -> Value {
        json!({ "illusts": ids.map(illust).collect::<Vec<_>>(), "next_url": next })
    }

    #[test]
    fn ranking_pages_until_top_is_reached() {
        let first = "/v1/illust/ranking?mode=week&filter=for_ios";
        let second = "https://app-api.pixiv.net/v1/illust/ranking?mode=week&offset=30";
        let third = "https://app-api.pixiv.net/v1/illust/ranking?mode=week&offset=60";
        let pages = HashMap::from([
            (first, page(1..=30, Some(second))),
            (second, page(31..=60, Some(third))),
            (third, page(61..=90, None)),
        ]);
        let mut asked = Vec::new();
        let mut get = |path: &str| {
            asked.push(path.to_owned());
            pages
                .get(path)
                .cloned()
                .ok_or(SourceError::Status { status: 404 })
        };
        let works = works(&mut get, RankingPeriod::Week, false, 50).unwrap();
        let ids: Vec<_> = works.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids.len(), 50);
        assert_eq!((ids[0], ids[49]), ("1", "50"));
        // 够了就不再翻第三页。
        assert_eq!(asked, [first, second]);
    }

    #[test]
    fn short_rankings_and_unreadable_entries() {
        let path = "/v1/illust/ranking?mode=day_r18&filter=for_ios";
        let mut broken = page(1..=3, None);
        broken["illusts"][1] = json!({ "id": 2, "type": "novel" });
        let pages = HashMap::from([(path, broken)]);
        let mut get = |p: &str| {
            pages
                .get(p)
                .cloned()
                .ok_or(SourceError::Status { status: 404 })
        };
        // 读不懂的第 2 名占一个名次：前 2 名只收到第 1 名；榜上只有 3 名时前 10 名给 2 个作品。
        let ids = |works: Vec<Work>| works.into_iter().map(|w| w.id).collect::<Vec<_>>();
        assert_eq!(
            ids(works(&mut get, RankingPeriod::Day, true, 2).unwrap()),
            ["1"]
        );
        assert_eq!(
            ids(works(&mut get, RankingPeriod::Day, true, 10).unwrap()),
            ["1", "3"]
        );
    }

    #[test]
    fn modes_match_pixiv_rankings() {
        assert_eq!(mode(RankingPeriod::Day, false), Some("day"));
        assert_eq!(mode(RankingPeriod::Month, false), Some("month"));
        assert_eq!(mode(RankingPeriod::Week, true), Some("week_r18"));
        assert_eq!(mode(RankingPeriod::Month, true), None);
        let mut get = |_: &str| -> Result<Value, SourceError> { unreachable!() };
        assert_eq!(
            works(&mut get, RankingPeriod::Month, true, 10),
            Err(SourceError::Unsupported)
        );
    }
}
