//! 订阅收进来的作品页（#368）：原图走普通导入的写入顺序，来源层按 `<订阅来源>:<作品 id>` 写入。
//!
//! - 来源链接指向作品页；作者与作品标签是来源名称（ADR-0012 的思路，来源名称记为 [`PIXIV`]），
//!   作者在「作者」命名空间。作者只来自来源与人工，不从文字推测。
//! - 来源标为成人的作品记为 explicit 分级事实。
//! - 不碰人工整理；同一页再次收进来只刷新这一层。

use rusqlite::{Transaction, params};

use super::Error;
use super::rating::ContentRating;
use super::tags::{self, FactSource, SourceTag, TagNamespace, TagRef};

/// pixiv 带来的来源名称。
pub(super) const PIXIV: &str = "pixiv";

/// 订阅收进来的一页作品。多页作品每页一张参考图，各自一份。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriptionPage {
    /// 订阅来源，例如 `pixiv`。
    pub source: String,
    /// 作品在来源里的 id。
    pub work_id: String,
    /// 第几页，从 0 开始。
    pub page: u32,
    /// 原文件名，例如 `12345_p0.png`。
    pub original_name: String,
    /// 作品页链接。
    pub page_url: String,
    /// 作者名；来源没给时为空。
    pub author: Option<String>,
    /// 来源上的作品标签原文。
    pub tags: Vec<String>,
    /// 来源把作品标为成人内容（pixiv 的 R-18 / R-18G）。
    pub explicit: bool,
    /// 收集时间（Unix 毫秒）：来源上的发布时间。
    pub collected_at: i64,
}

impl SubscriptionPage {
    pub(super) fn fact_source(&self) -> FactSource {
        FactSource::subscription(&self.source, &self.work_id)
    }

    /// 来源记录的位置：作品页加页码，同一作品的各页各占一条。
    pub(super) fn location(&self) -> String {
        format!("{}#p{}", self.page_url, self.page)
    }
}

/// 写入（或刷新）这一页的来源层，仍处在原图的提交事务中；返回新的词表修订号。
pub(super) fn commit(
    tx: &Transaction,
    translations: &tags::TranslationIndex,
    page: &SubscriptionPage,
    image_id: &str,
    now: i64,
) -> Result<i64, Error> {
    let source = page.fact_source();
    tx.execute(
        "INSERT INTO image_source (image_id, source, location, recorded_at, url)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (image_id, source, location) DO UPDATE SET url = excluded.url",
        params![
            image_id,
            source.as_str(),
            page.location(),
            now,
            page.page_url
        ],
    )?;
    let mut source_tags = Vec::new();
    let named = page
        .author
        .iter()
        .map(|a| (TagNamespace::Artist, a))
        .chain(page.tags.iter().map(|t| (TagNamespace::General, t)));
    for (namespace, name) in named {
        match tags::resolve_source_named(tx, namespace, name, PIXIV) {
            Ok(id) => source_tags.push(SourceTag {
                tag: TagRef::Id { id },
                score: None,
            }),
            // 空白或不合规的原文跳过，不拦整页。
            Err(Error::InvalidTagName) => {}
            Err(e) => return Err(e),
        }
    }
    tags::replace_source_tags_in(tx, translations, &source, image_id, &source_tags)?;
    tx.execute(
        "DELETE FROM rating_fact WHERE image_id = ?1 AND source = ?2",
        params![image_id, source.as_str()],
    )?;
    if page.explicit {
        tx.execute(
            "INSERT INTO rating_fact (image_id, source, rating, score) VALUES (?1, ?2, ?3, NULL)",
            params![image_id, source.as_str(), ContentRating::Explicit.as_str()],
        )?;
    }
    tags::bump_revision(tx)
}
