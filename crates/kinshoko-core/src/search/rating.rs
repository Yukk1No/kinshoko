//! 按文字查内容分级。

use super::*;

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

/// 名称或其他叫法含 `needle`（已 [`fold`]）的分级，带排序用的名次与经由的叫法，规则同标签候选。
/// 安全模式开启时不含成人内容的分级不在其中。
pub(super) fn matching_ratings(needle: &str, safe_mode: bool) -> Vec<(u8, RatingCandidate)> {
    RATINGS
        .iter()
        .filter(|(ratings, _, _)| !(safe_mode && ratings.iter().any(|r| r.is_adult())))
        .filter_map(|&(ratings, name, others)| {
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
                        ratings: ratings.to_vec(),
                        name: name.to_owned(),
                    },
                    via,
                },
            ))
        })
        .collect()
}

/// 打字时的分级候选：名称或其他叫法含 `text` 的分级，排序同标签候选。安全模式开启时不列出
/// 含成人内容的分级（安全模式优先）。
pub fn rating_candidates(text: &str, safe_mode: bool) -> Vec<RatingCandidate> {
    let needle = fold(text.trim());
    if needle.is_empty() {
        return Vec::new();
    }
    let mut found = matching_ratings(&needle, safe_mode);
    found.sort_by_key(|(rank, _)| *rank);
    found.into_iter().map(|(_, c)| c).collect()
}

/// 一组分级的显示名称：是可以查找的分级之一时用它的名称，否则依次列出各档的名称。
pub(super) fn rating_label(ratings: &[ContentRating]) -> RatingLabel {
    let mut ratings = ratings.to_vec();
    ratings.sort();
    ratings.dedup();
    let name_of = |set: &[ContentRating]| {
        RATINGS
            .iter()
            .find(|(r, _, _)| *r == set)
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
