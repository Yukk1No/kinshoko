//! 认出图集（#418）：同一来源作品的多张参考图。只看来源记录与原文件名，浏览时现算，不建表。
//!
//! - 订阅：来源层 `pixiv:<作品 id>`，位置 `作品页#p<页码>`。
//! - Eagle 迁入、参考组包：来源链接是 pixiv 作品页或 X 推文时，同一作品就是同一图集；
//!   页序取原文件名里的 `_p<n>`（X 的图片链接带 `/photo/<n>` 时取它）。泛链接不认。

use serde::{Deserialize, Serialize};

/// 一张参考图在图集里的位置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ImageSetPage {
    /// 图集键，例如 `pixiv:123`、`x:456`。同一作品经不同途径收进来，键相同。
    pub key: String,
    /// 第几页，从 0 开始；认不出页序时为空，排在认出页序的后面。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
}

/// 一条来源记录：来源层、位置与来源链接。
pub(crate) struct SourceRecord<'a> {
    pub source: &'a str,
    pub location: &'a str,
    pub url: Option<&'a str>,
}

/// 从一张图的全部来源记录认出它所在的图集。订阅的来源层优先，其次按链接排序取第一个认得的。
pub(crate) fn recognize(records: &[SourceRecord], original_name: &str) -> Option<ImageSetPage> {
    for record in records {
        if let Some(found) = subscription(record) {
            return Some(found);
        }
    }
    let mut urls: Vec<&str> = records.iter().filter_map(|r| r.url).collect();
    urls.sort_unstable();
    urls.into_iter().find_map(|url| {
        let (key, page) = work_link(url)?;
        Some(ImageSetPage {
            key,
            page: page.or_else(|| file_page(original_name)),
        })
    })
}

/// 订阅的来源层：`pixiv:<作品 id>`，位置末尾 `#p<页码>`。
fn subscription(record: &SourceRecord) -> Option<ImageSetPage> {
    let id = record.source.strip_prefix("pixiv:")?;
    digits(id)?;
    let page = record
        .location
        .rsplit_once("#p")
        .and_then(|(_, n)| n.parse().ok());
    Some(ImageSetPage {
        key: format!("pixiv:{id}"),
        page,
    })
}

/// 作品页链接认出的图集键，以及链接本身带的页码。
fn work_link(url: &str) -> Option<(String, Option<u32>)> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = host.to_ascii_lowercase();
    let host = host
        .strip_prefix("www.")
        .or_else(|| host.strip_prefix("mobile."))
        .unwrap_or(&host);
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    let path = path.split('#').next().unwrap_or("");
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    match host {
        "pixiv.net" => {
            let id = match segments[..] {
                ["artworks", id] | [_, "artworks", id] | ["i", id] => id,
                ["member_illust.php"] => query
                    .split('&')
                    .find_map(|pair| pair.strip_prefix("illust_id="))?,
                _ => return None,
            };
            Some((format!("pixiv:{}", digits(id)?), None))
        }
        "x.com" | "twitter.com" => {
            let (id, photo) = match segments[..] {
                [_, "status", id] => (id, None),
                [_, "status", id, "photo", n] => (id, n.parse::<u32>().ok()),
                _ => return None,
            };
            Some((
                format!("x:{}", digits(id)?),
                photo.and_then(|n| n.checked_sub(1)),
            ))
        }
        _ => None,
    }
}

/// 原文件名里的页码：`12345_p3.png` → 3。
fn file_page(name: &str) -> Option<u32> {
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    let (_, n) = stem.rsplit_once("_p")?;
    digits(n)?.parse().ok()
}

fn digits(text: &str) -> Option<&str> {
    (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record<'a>(source: &'a str, location: &'a str, url: Option<&'a str>) -> SourceRecord<'a> {
        SourceRecord {
            source,
            location,
            url,
        }
    }

    fn page(key: &str, page: Option<u32>) -> Option<ImageSetPage> {
        Some(ImageSetPage {
            key: key.into(),
            page,
        })
    }

    #[test]
    fn subscription_pages_use_the_work_id_and_page_number() {
        let url = "https://www.pixiv.net/artworks/123";
        let records = [record(
            "pixiv:123",
            "https://www.pixiv.net/artworks/123#p2",
            Some(url),
        )];
        assert_eq!(
            recognize(&records, "123_p2.png"),
            page("pixiv:123", Some(2))
        );
    }

    #[test]
    fn eagle_and_package_links_to_a_pixiv_work_take_the_page_from_the_file_name() {
        for url in [
            "https://www.pixiv.net/artworks/123",
            "https://www.pixiv.net/en/artworks/123",
            "http://pixiv.net/artworks/123/",
            "https://www.pixiv.net/member_illust.php?mode=medium&illust_id=123",
            "https://pixiv.net/i/123",
        ] {
            let records = [record("eagle", "D:/a.library/images/X.info", Some(url))];
            assert_eq!(
                recognize(&records, "123_p4.jpg"),
                page("pixiv:123", Some(4)),
                "{url}"
            );
        }
        let records = [record(
            "eagle",
            "x",
            Some("https://www.pixiv.net/artworks/123"),
        )];
        assert_eq!(recognize(&records, "cover.jpg"), page("pixiv:123", None));
    }

    #[test]
    fn tweets_are_recognized_with_the_photo_number_when_given() {
        let records = [record(
            "eagle",
            "x",
            Some("https://x.com/someone/status/456/photo/2"),
        )];
        assert_eq!(recognize(&records, "a.jpg"), page("x:456", Some(1)));
        let records = [record(
            "eagle",
            "x",
            Some("https://twitter.com/someone/status/456"),
        )];
        assert_eq!(recognize(&records, "a_p3.jpg"), page("x:456", Some(3)));
    }

    #[test]
    fn other_links_and_plain_imports_are_not_recognized() {
        for url in [
            "https://www.pixiv.net/users/9",
            "https://www.pixiv.net/artworks/abc",
            "https://x.com/someone",
            "https://example.com/artworks/123",
            "pixiv.net/artworks/123",
        ] {
            let records = [record("eagle", "x", Some(url))];
            assert_eq!(recognize(&records, "123_p0.png"), None, "{url}");
        }
        assert_eq!(
            recognize(&[record("import", "C:/a.png", None)], "a_p0.png"),
            None
        );
        assert_eq!(recognize(&[], "a_p0.png"), None);
    }

    #[test]
    fn subscription_records_win_over_links() {
        let records = [
            record("eagle", "x", Some("https://x.com/a/status/1")),
            record("pixiv:7", "https://www.pixiv.net/artworks/7#p1", None),
        ];
        assert_eq!(recognize(&records, "z.png"), page("pixiv:7", Some(1)));
    }
}
