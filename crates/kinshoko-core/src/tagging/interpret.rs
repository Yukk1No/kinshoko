//! 把模型的原始结果变成标签建议与分级建议：按类别阈值取标签，分级取分级类别中最高分的一项。
//! 标签按外部名称写入（ADR-0003），首次进库时由翻译表给出各语言的初始名称。

use crate::library::{ContentRating, RatingFact, SourceTag, TagNamespace, TagRef};

use super::models::ModelSpec;
use super::port::RawTag;

/// Danbooru 词表的类别对应的标签命名空间；不是标签的类别（如分级）返回 `None`。
fn namespace(category: u8) -> Option<TagNamespace> {
    match category {
        0 | 5 => Some(TagNamespace::General),
        1 => Some(TagNamespace::Artist),
        3 => Some(TagNamespace::Work),
        4 => Some(TagNamespace::Character),
        _ => None,
    }
}

pub(super) struct Suggestions {
    pub tags: Vec<SourceTag>,
    pub rating: Option<RatingFact>,
}

pub(super) fn interpret(spec: &ModelSpec, raw: &[RawTag]) -> Suggestions {
    let tags = raw
        .iter()
        .filter(|t| Some(t.category) != spec.rating_category)
        .filter(|t| spec.threshold(t.category).is_some_and(|thr| t.score >= thr))
        .filter_map(|t| {
            Some(SourceTag {
                tag: TagRef::External {
                    namespace: namespace(t.category)?,
                    name: t.name.clone(),
                },
                score: Some(t.score),
            })
        })
        .collect();
    let rating = spec.rating_category.and_then(|cat| {
        raw.iter()
            .filter(|t| t.category == cat)
            .filter_map(|t| Some((ContentRating::parse(&t.name)?, t.score)))
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(rating, score)| RatingFact {
                rating,
                score: Some(score),
            })
    });
    Suggestions { tags, rating }
}
