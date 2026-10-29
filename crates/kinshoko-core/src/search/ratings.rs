//! 查找里的内容分级（#161）：可以查找的分级、打字时的分级候选与条件里的分级名称。
//! “R18”代表安全模式范围内的各档（#223）。从 search.rs 搬出，并按范围改写。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::fold;
use crate::library::{ContentRating, SafeMode, SafeModeScope};

/// 条件或候选中的内容分级，带显示用的名称。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RatingLabel {
    /// 代表的分级，从宽到严。
    pub ratings: Vec<ContentRating>,
    pub name: String,
}

/// 搜索框下拉中的一个分级候选。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RatingCandidate {
    pub rating: RatingLabel,
    /// 经由其他叫法（英文名、R-18 等）命中时，是那个叫法；按显示名命中时为空。
    pub via: Option<String>,
}

/// 可以查找的四档内容分级。中文名与人工分级界面相同。
const RATINGS: [(ContentRating, &str, &[&str]); 4] = [
    (ContentRating::General, "全年龄", &["general"]),
    (ContentRating::Sensitive, "轻度", &["sensitive"]),
    (ContentRating::Questionable, "敏感", &["questionable"]),
    (ContentRating::Explicit, "成人", &["explicit"]),
];

/// 代表安全模式范围内各档的“R18”（#223）及其他叫法。
const R18: (&str, &[&str]) = ("R18", &["R-18", "成人"]);

/// 可以查找的分级：四档各一个，另有代表安全模式范围内各档的“R18”，按 `scope` 定。
fn searchable_ratings(
    scope: SafeModeScope,
) -> Vec<(Vec<ContentRating>, &'static str, &'static [&'static str])> {
    RATINGS
        .iter()
        .map(|&(rating, name, others)| (vec![rating], name, others))
        .chain(std::iter::once((scope.ratings(), R18.0, R18.1)))
        .collect()
}

/// 名称或其他叫法含 `needle`（已 [`fold`]）的分级，带排序用的名次与经由的叫法，规则同标签候选。
/// 安全模式开启时，含安全模式范围内分级的候选（包括 R18）不在其中。
pub(super) fn matching_ratings(needle: &str, safe: SafeMode) -> Vec<(u8, RatingCandidate)> {
    searchable_ratings(safe.scope)
        .into_iter()
        .filter(|(ratings, _, _)| !ratings.iter().any(|r| safe.seals(Some(*r))))
        .filter_map(|(ratings, name, others)| {
            let (rank, via) = std::iter::once(name)
                .chain(others.iter().copied())
                .filter_map(|word| {
                    let folded = fold(word);
                    let place = if folded == needle {
                        0
                    } else if folded.starts_with(needle) {
                        1
                    } else if folded.contains(needle) {
                        2
                    } else {
                        return None;
                    };
                    let via = (word != name).then(|| word.to_owned());
                    Some((place * 2 + u8::from(via.is_some()), via))
                })
                .min_by_key(|(rank, _)| *rank)?;
            Some((
                rank,
                RatingCandidate {
                    rating: RatingLabel {
                        ratings,
                        name: name.to_owned(),
                    },
                    via,
                },
            ))
        })
        .collect()
}

/// 打字时的分级候选：名称或其他叫法含 `text` 的分级，排序同标签候选。安全模式开启时不列出
/// 安全模式范围内的分级（安全模式优先）。只给开关时按默认范围（见 [`SafeMode`] 的 `From<bool>`）。
pub fn rating_candidates(text: &str, safe: impl Into<SafeMode>) -> Vec<RatingCandidate> {
    let needle = fold(text.trim());
    if needle.is_empty() {
        return Vec::new();
    }
    let mut found = matching_ratings(&needle, safe.into());
    found.sort_by_key(|(rank, _)| *rank);
    found.into_iter().map(|(_, c)| c).collect()
}

/// 一组分级的显示名称：是可以查找的分级之一时用它的名称（“R18”按安全模式范围 `scope`），
/// 否则依次列出各档的名称。
pub(super) fn rating_label(ratings: &[ContentRating], scope: SafeModeScope) -> RatingLabel {
    let mut ratings = ratings.to_vec();
    ratings.sort();
    ratings.dedup();
    let searchable = searchable_ratings(scope);
    let name_of = |set: &[ContentRating]| {
        searchable
            .iter()
            .find(|(r, _, _)| r == set)
            .map(|(_, name, _)| *name)
    };
    let name = name_of(&ratings).map(str::to_owned).unwrap_or_else(|| {
        ratings
            .iter()
            .filter_map(|r| name_of(std::slice::from_ref(r)))
            .collect::<Vec<_>>()
            .join("、")
    });
    RatingLabel { ratings, name }
}
