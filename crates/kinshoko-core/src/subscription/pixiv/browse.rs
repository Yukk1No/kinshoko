//! 应用内浏览（#461）：读 pixiv 上的作品流（关注的新作、推荐、相关作品、画师作品、按标签查找、榜单、
//! 我的 pixiv 收藏）和按名字查找画师，一次一页。这些作品不在资料库里，只给界面显示，收进资料库另走。
//! 接口请求由调用方给（`get`），这里只管拼路径与读回应，测试用假回应。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::artist::{Artist, Get, next_url, user};
use super::parse::parse_rfc3339;
use super::ranking;
use crate::subscription::{RankingPeriod, SourceError, Work, WorkKind};

/// 一条作品流。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum Feed {
    /// 关注的画师的新作，公开与非公开关注都算（pixivpy `illust_follow`）。
    Following,
    /// 给登录账号的推荐（`illust_recommended`）。
    Recommended,
    /// 和一个作品相关的作品（`illust_related`）。
    #[serde(rename_all = "camelCase")]
    Related { illust_id: String },
    /// 一位画师的插画（含动图）或漫画，从新到旧（`user_illusts`）。
    #[serde(rename_all = "camelCase")]
    Artist { user_id: String, manga: bool },
    /// 按标签找作品，部分一致，从新到旧（`search_illust`）。
    Search { word: String },
    /// 当前的日榜、周榜、月榜；`explicit` 为真时是 R-18 榜（`illust_ranking`）。
    Ranking {
        period: RankingPeriod,
        explicit: bool,
    },
    /// 登录账号的 pixiv 收藏，公开或非公开（`user_bookmarks_illust`）。
    Bookmarks { private: bool },
}

/// pixiv 上的一个作品，不在资料库里。图片地址都在 `i.pximg.net` 上，要经后端转发才能显示。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PixivWork {
    pub id: String,
    pub kind: WorkKind,
    pub title: String,
    pub artist: Artist,
    /// 作品标签原文。
    pub tags: Vec<String>,
    /// pixiv 标为 R-18 或 R-18G（`x_restrict > 0`）。安全模式开着时不显示。
    pub explicit: bool,
    /// 第一页的像素尺寸，瀑布流按它留位置。
    pub width: u32,
    pub height: u32,
    /// 各页，按页序。动图只有一页，没有原图。
    pub pages: Vec<PixivPage>,
    /// 发布时间（Unix 毫秒）。
    #[ts(type = "number")]
    pub posted_at: i64,
    /// 登录账号已经 pixiv 收藏了它。
    pub bookmarked: bool,
    /// 作品页链接。
    pub page_url: String,
}

/// 作品的一页。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PixivPage {
    /// 不裁切、长边约 540 的预览，给瀑布流。
    pub preview: String,
    /// 不裁切、较大的预览，给原地展开。
    pub large: String,
    /// 原图。动图没有。
    pub original: Option<String>,
}

impl PixivWork {
    /// 收进资料库用的作品（#461 第 3 步）：每页的原图，作者与标签同订阅收进来的图。
    /// 动图没有原图，页为空。
    pub fn to_work(&self) -> Work {
        Work {
            id: self.id.clone(),
            kind: self.kind,
            explicit: self.explicit,
            author: Some(self.artist.name.clone()).filter(|name| !name.trim().is_empty()),
            tags: self.tags.clone(),
            page_url: self.page_url.clone(),
            pages: self
                .pages
                .iter()
                .filter_map(|p| p.original.clone())
                .collect(),
            posted_at: self.posted_at,
        }
    }
}

/// 作品流的一页。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorksPage {
    pub works: Vec<PixivWork>,
    /// 下一页；原样交回 [`super::PixivSource::browse`]。到底时为空。
    pub next: Option<String>,
}

/// 按名字找到的一位画师。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PixivArtist {
    pub user_id: String,
    pub name: String,
    /// 头像。
    pub avatar: Option<String>,
    /// 登录账号已经在 pixiv 上关注了这位画师。
    pub followed: bool,
    /// pixiv 一并给的几个近作。
    pub works: Vec<PixivWork>,
}

/// 查找画师的一页。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ArtistsPage {
    pub artists: Vec<PixivArtist>,
    pub next: Option<String>,
}

/// 作品流第一页的接口路径。收藏要登录账号的 ID（`self_id`）。R-18 榜没有月榜，这时报不支持。
pub(super) fn first_page(feed: &Feed, self_id: &str) -> Result<String, SourceError> {
    Ok(match feed {
        Feed::Following => "/v2/illust/follow?restrict=all".to_owned(),
        Feed::Recommended => {
            "/v1/illust/recommended?content_type=illust&include_ranking_label=true&filter=for_ios"
                .to_owned()
        }
        Feed::Related { illust_id } => {
            format!(
                "/v2/illust/related?illust_id={}&filter=for_ios",
                id(illust_id)?
            )
        }
        Feed::Artist { user_id, manga } => format!(
            "/v1/user/illusts?user_id={}&type={}&filter=for_ios",
            id(user_id)?,
            if *manga { "manga" } else { "illust" }
        ),
        Feed::Search { word } => format!(
            "/v1/search/illust?word={}&search_target=partial_match_for_tags&sort=date_desc&filter=for_ios",
            query(word)?
        ),
        Feed::Ranking { period, explicit } => {
            let mode = ranking::mode(*period, *explicit).ok_or(SourceError::Unsupported)?;
            format!("/v1/illust/ranking?mode={mode}&filter=for_ios")
        }
        Feed::Bookmarks { private } => format!(
            "/v1/user/bookmarks/illust?user_id={}&restrict={}&filter=for_ios",
            id(self_id)?,
            if *private { "private" } else { "public" }
        ),
    })
}

/// 按名字找画师第一页的接口路径。
pub(super) fn first_artists_page(word: &str) -> Result<String, SourceError> {
    Ok(format!(
        "/v1/search/user?word={}&filter=for_ios",
        query(word)?
    ))
}

/// 界面交回的下一页：只能是接口给过的那种客户端接口地址，免得带着登录凭据请求别处。
pub(super) fn checked_next(next: &str) -> Result<String, SourceError> {
    let page = serde_json::json!({ "next_url": next });
    next_url(&page).ok_or(SourceError::Unsupported)
}

/// 读一页作品。读不懂的作品（已删除、看不到、小说）略过。
pub(super) fn works_page(get: &mut Get<'_>, path: &str) -> Result<WorksPage, SourceError> {
    let page = get(path)?;
    let illusts = page["illusts"].as_array().ok_or(SourceError::Unreadable)?;
    Ok(WorksPage {
        works: illusts.iter().filter_map(pixiv_work).collect(),
        next: next_url(&page),
    })
}

/// 读一页画师。
pub(super) fn artists_page(get: &mut Get<'_>, path: &str) -> Result<ArtistsPage, SourceError> {
    let page = get(path)?;
    let previews = page["user_previews"]
        .as_array()
        .ok_or(SourceError::Unreadable)?;
    let artists = previews
        .iter()
        .filter_map(|preview| {
            let v = &preview["user"];
            let artist = user(v)?;
            Some(PixivArtist {
                user_id: artist.user_id,
                name: artist.name,
                avatar: v["profile_image_urls"]["medium"]
                    .as_str()
                    .filter(|u| is_image(u))
                    .map(str::to_owned),
                followed: v["is_followed"].as_bool().unwrap_or(false),
                works: preview["illusts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(pixiv_work)
                    .collect(),
            })
        })
        .collect();
    Ok(ArtistsPage {
        artists,
        next: next_url(&page),
    })
}

/// pixiv 客户端接口里的一个作品（`illusts[]`）。字段缺失（接口变了）时为空。
pub(super) fn pixiv_work(v: &Value) -> Option<PixivWork> {
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
    let image = |urls: &Value, size: &str| {
        urls[size]
            .as_str()
            .filter(|u| is_image(u))
            .map(str::to_owned)
    };
    let page = |urls: &Value, original: Option<String>| {
        Some(PixivPage {
            preview: image(urls, "medium")?,
            large: image(urls, "large").or_else(|| image(urls, "medium"))?,
            original,
        })
    };
    let multi: Vec<PixivPage> = v["meta_pages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| page(&p["image_urls"], image(&p["image_urls"], "original")))
        .collect();
    let pages = if !multi.is_empty() {
        multi
    } else {
        let original = (kind != WorkKind::Animation)
            .then(|| image(&v["meta_single_page"], "original_image_url"))
            .flatten();
        vec![page(&v["image_urls"], original)?]
    };
    let size = |key: &str| v[key].as_u64().and_then(|n| u32::try_from(n).ok());
    Some(PixivWork {
        page_url: format!("https://www.pixiv.net/artworks/{id}"),
        id,
        kind,
        title: v["title"].as_str().unwrap_or_default().trim().to_owned(),
        artist: user(&v["user"])?,
        tags: v["tags"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| t["name"].as_str().map(str::to_owned))
            .collect(),
        explicit: v["x_restrict"].as_i64().unwrap_or(0) > 0,
        width: size("width").unwrap_or(0),
        height: size("height").unwrap_or(0),
        pages,
        posted_at: v["create_date"]
            .as_str()
            .and_then(parse_rfc3339)
            .unwrap_or(0),
        bookmarked: v["is_bookmarked"].as_bool().unwrap_or(false),
    })
}

/// pixiv 图片地址都在这个主机上（`super::images` 只转发这里的图）。
pub(super) fn is_image(url: &str) -> bool {
    url.starts_with(super::images::IMAGE_HOST)
}

/// pixiv 的数字 ID。
fn id(s: &str) -> Result<&str, SourceError> {
    if !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit()) {
        Ok(s)
    } else {
        Err(SourceError::Unsupported)
    }
}

/// 查找词，百分号编码。空的报不支持。
fn query(word: &str) -> Result<String, SourceError> {
    let word = word.trim();
    if word.is_empty() {
        return Err(SourceError::Unsupported);
    }
    let mut out = String::new();
    for b in word.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn urls(id: u64, page: u32) -> Value {
        json!({
            "square_medium": format!("https://i.pximg.net/c/360x360_70/img-master/{id}_p{page}_square1200.jpg"),
            "medium": format!("https://i.pximg.net/c/540x540_70/img-master/{id}_p{page}_master1200.jpg"),
            "large": format!("https://i.pximg.net/c/600x1200_90/img-master/{id}_p{page}_master1200.jpg"),
        })
    }

    fn single(id: u64) -> Value {
        json!({
            "id": id, "title": " 夏 ", "type": "illust", "x_restrict": 0, "width": 1200, "height": 1800,
            "create_date": "2024-03-01T09:00:00+09:00", "is_bookmarked": true,
            "user": { "id": 9, "name": "画师" }, "tags": [{ "name": "オリジナル" }],
            "image_urls": urls(id, 0), "meta_pages": [],
            "meta_single_page": { "original_image_url": format!("https://i.pximg.net/img-original/{id}_p0.png") }
        })
    }

    #[test]
    fn single_page_work_carries_previews_and_original() {
        let work = pixiv_work(&single(5)).unwrap();
        assert_eq!(work.id, "5");
        assert_eq!(work.title, "夏");
        assert_eq!(work.artist.user_id, "9");
        assert_eq!((work.width, work.height), (1200, 1800));
        assert!(work.bookmarked);
        assert!(!work.explicit);
        assert_eq!(work.posted_at, 1_709_251_200_000);
        assert_eq!(work.pages.len(), 1);
        let page = &work.pages[0];
        assert!(page.preview.contains("540x540"));
        assert!(page.large.contains("600x1200"));
        assert_eq!(
            page.original.as_deref(),
            Some("https://i.pximg.net/img-original/5_p0.png")
        );
    }

    #[test]
    fn multi_page_and_animation_works() {
        let mut multi = single(6);
        multi["x_restrict"] = json!(2);
        multi["meta_pages"] = json!([
            { "image_urls": { "original": "https://i.pximg.net/img-original/6_p0.png", "medium": urls(6, 0)["medium"], "large": urls(6, 0)["large"] } },
            { "image_urls": { "original": "https://i.pximg.net/img-original/6_p1.png", "medium": urls(6, 1)["medium"], "large": urls(6, 1)["large"] } },
        ]);
        let work = pixiv_work(&multi).unwrap();
        assert!(work.explicit);
        assert_eq!(work.pages.len(), 2);
        assert!(work.pages[1].preview.contains("6_p1"));

        let mut ugoira = single(7);
        ugoira["type"] = json!("ugoira");
        ugoira["meta_single_page"] = json!({});
        let work = pixiv_work(&ugoira).unwrap();
        assert_eq!(work.kind, WorkKind::Animation);
        assert_eq!(work.pages.len(), 1);
        assert_eq!(work.pages[0].original, None);

        let mut novel = single(8);
        novel["type"] = json!("novel");
        assert!(pixiv_work(&novel).is_none());
        // 图片不在 pixiv 图片主机上的不列出。
        let mut elsewhere = single(10);
        elsewhere["image_urls"]["medium"] = json!("https://example.com/a.jpg");
        assert!(pixiv_work(&elsewhere).is_none());
    }

    #[test]
    fn feeds_map_to_client_api_paths() {
        let path = |feed: Feed| first_page(&feed, "42");
        assert_eq!(
            path(Feed::Following).unwrap(),
            "/v2/illust/follow?restrict=all"
        );
        assert!(
            path(Feed::Artist {
                user_id: "9".into(),
                manga: true
            })
            .unwrap()
            .starts_with("/v1/user/illusts?user_id=9&type=manga")
        );
        assert!(
            path(Feed::Search {
                word: " 女の子 R&B ".into()
            })
            .unwrap()
            .starts_with("/v1/search/illust?word=%E5%A5%B3%E3%81%AE%E5%AD%90%20R%26B&")
        );
        assert!(
            path(Feed::Bookmarks { private: true })
                .unwrap()
                .contains("user_id=42&restrict=private")
        );
        assert!(
            path(Feed::Ranking {
                period: RankingPeriod::Week,
                explicit: true
            })
            .unwrap()
            .contains("mode=week_r18")
        );
        for bad in [
            Feed::Ranking {
                period: RankingPeriod::Month,
                explicit: true,
            },
            Feed::Related {
                illust_id: "1&x=2".into(),
            },
            Feed::Search { word: "  ".into() },
        ] {
            assert_eq!(path(bad), Err(SourceError::Unsupported));
        }
        assert_eq!(
            first_page(&Feed::Bookmarks { private: false }, ""),
            Err(SourceError::Unsupported)
        );
    }

    #[test]
    fn next_pages_stay_on_the_client_api() {
        let next = "https://app-api.pixiv.net/v2/illust/follow?restrict=all&offset=30";
        assert_eq!(checked_next(next).as_deref(), Ok(next));
        for bad in [
            "https://example.com/v1/x",
            "https://app-api.pixiv.net.example.com/v1/x",
            "/v1/illust/recommended",
        ] {
            assert_eq!(checked_next(bad), Err(SourceError::Unsupported), "{bad}");
        }
    }

    #[test]
    fn pages_read_works_artists_and_next() {
        let next = "https://app-api.pixiv.net/v1/search/user?word=a&offset=30";
        let mut get = |path: &str| -> Result<Value, SourceError> {
            Ok(match path {
                "works" => {
                    json!({ "illusts": [single(1), { "id": 2, "type": "novel" }], "next_url": null })
                }
                _ => json!({
                    "user_previews": [{
                        "user": {
                            "id": 9, "name": "画师", "is_followed": true,
                            "profile_image_urls": { "medium": "https://i.pximg.net/user-profile/9.jpg" }
                        },
                        "illusts": [single(3)]
                    }],
                    "next_url": next
                }),
            })
        };
        let works = works_page(&mut get, "works").unwrap();
        assert_eq!(works.works.len(), 1);
        assert_eq!(works.next, None);
        let artists = artists_page(&mut get, "artists").unwrap();
        assert_eq!(artists.next.as_deref(), Some(next));
        let artist = &artists.artists[0];
        assert_eq!((artist.user_id.as_str(), artist.followed), ("9", true));
        assert!(artist.avatar.is_some());
        assert_eq!(artist.works[0].id, "3");
        assert_eq!(
            works_page(&mut |_| Ok(json!({})), "x"),
            Err(SourceError::Unreadable)
        );
    }
}
