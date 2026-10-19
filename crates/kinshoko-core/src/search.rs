//! 查找（Search）：纯计算模块，不做 I/O（#42“模块与接口”，#54）。
//!
//! 输入是画师在搜索框里组织的条件（[`SearchInput`]）与词表快照（[`Vocabulary`]），
//! 输出是可见的条件树（[`ConditionTree`]），交给 [`crate::Library::browse`] 执行；
//! 打字时的候选下拉由 [`Search::candidates`] 给出。
//!
//! 语义：
//! - 各条件同时满足；一个条件里的各项是“任一”；条件可以“排除”。
//! - 直接输入的文字匹配名称或别名含这段文字的全部标签（不分命名空间），以及参考图自身的
//!   文字（原文件名等，由 Library 决定匹配哪些字段）。候选下拉按命名空间与别名列出候选，
//!   不选就都匹配。
//! - 内容分级（#161）不是标签，但在搜索框里用起来像标签：点选的分级项按有效分级匹配，直接
//!   输入的文字也匹配名称或其他叫法含它的分级（[`rating_candidates`]）。安全模式开启时，含成人
//!   内容的分级不出现在候选中，文字也不匹配它们。
//! - 外部对应不是叫法，不参与匹配（ADR-0003）；尚未翻译的标签按显示出来的外部名称匹配。
//! - 比较前统一做 NFKC 与小写（[`fold`]），全角半角、大小写不影响查找。
//!
//! - 近似查找（#56，ADR-0003）默认开启：标签项与文字项匹配到的标签，按个人近似对应表与
//!   内置近似对应表展开相近标签，作为可见的“任一”放进条件树（`similar`）。个人近似对应表
//!   优先：“相近”补上一对，“不相近”压过内置的同一对。相近关系不传递；没有可见的图的标签
//!   不展开。[`SearchInput::exact`] 改回精确查找；“只这次”不展开的标签记在各项的
//!   `dismissed` 里，只影响本次查找。
//!
//! 安全模式（#60）在 Library 执行条件树时过滤，Search 不参与。
//! 活动资料库的 Search 由 [`SearchCache`] 按（资料库，词表修订号，安全模式）缓存（#76）。

mod cache;

pub use cache::SearchCache;

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use unicode_normalization::UnicodeNormalization;

use crate::approx::{ApproxRelation, ApproxSource, BuiltinApproxTable, ordered};
use crate::library::{ContentRating, TagLabel, Vocabulary, display_label};

/// 搜索框里的一项：点选的标签、点选的内容分级，或直接输入的文字。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum TermInput {
    /// 从候选中点选的标签。
    Tag {
        id: String,
        /// “只这次”不展开的相近标签（`tag_id`）。
        #[serde(default)]
        dismissed: Vec<String>,
    },
    /// 直接输入的文字。
    Text {
        text: String,
        /// “只这次”不展开的相近标签（`tag_id`）。
        #[serde(default)]
        dismissed: Vec<String>,
    },
    /// 从候选中点选的内容分级（#161）：有效分级是其中任一档。内容分级不是标签，只是在搜索框里
    /// 用起来像标签。
    Rating { ratings: Vec<ContentRating> },
}

/// 搜索框里的一个条件：各项任一满足；`negate` 时排除满足的图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConditionInput {
    pub any: Vec<TermInput>,
    #[serde(default)]
    pub negate: bool,
}

/// 画师在搜索框里组织的全部条件，各条件同时满足。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchInput {
    pub conditions: Vec<ConditionInput>,
    /// 精确查找：不展开相近标签。默认展开（近似查找）。
    #[serde(default)]
    pub exact: bool,
}

/// 条件树中的一项，带显示用的标签名，界面照此显示条件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum Term {
    /// 有这个有效标签，或有任一相近标签。
    Tag {
        tag: TagLabel,
        /// 近似查找展开的相近标签，与 `tag` 一起作为任一；精确查找时为空。
        #[serde(default)]
        similar: Vec<SimilarTag>,
    },
    /// 直接输入的文字：有名称或别名含这段文字的任一标签、任一相近标签、有效分级是名称含这段
    /// 文字的分级，或参考图自身的文字含它。
    Text {
        text: String,
        /// 名称或别名含这段文字的标签，按命名空间与名称排序。
        tags: Vec<TagLabel>,
        /// 近似查找展开的这些标签的相近标签（不含 `tags` 中已有的）；精确查找时为空。
        #[serde(default)]
        similar: Vec<SimilarTag>,
        /// 名称或其他叫法含这段文字的内容分级（#161）；安全模式开启时不含成人内容的分级。
        #[serde(default)]
        ratings: Vec<RatingLabel>,
    },
    /// 有效分级是其中任一档；还没有分级的图不满足。
    Rating { rating: RatingLabel },
}

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

/// 可以查找的内容分级：四档各一个，另有代表含成人内容两档的“R18”。中文名与人工分级界面相同。
const RATINGS: [(&[ContentRating], &str, &[&str]); 5] = [
    (&[ContentRating::General], "全年龄", &["general"]),
    (&[ContentRating::Sensitive], "轻度", &["sensitive"]),
    (&[ContentRating::Questionable], "敏感", &["questionable"]),
    (&[ContentRating::Explicit], "成人", &["explicit"]),
    (
        &[ContentRating::Questionable, ContentRating::Explicit],
        "R18",
        &["R-18", "成人"],
    ),
];

/// 名称或其他叫法含 `needle`（已 [`fold`]）的分级，带排序用的名次与经由的叫法，规则同标签候选。
/// 安全模式开启时不含成人内容的分级不在其中。
fn matching_ratings(needle: &str, safe_mode: bool) -> Vec<(u8, RatingCandidate)> {
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
fn rating_label(ratings: &[ContentRating]) -> RatingLabel {
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

/// 近似查找展开出的一个相近标签。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SimilarTag {
    pub tag: TagLabel,
    /// 来自哪份近似对应表；同时有两份来源时记个人。
    pub source: ApproxSource,
    /// 这一项中与它相近的标签（`tag_id`）。“以后都不展开”把其中每一对记为“不相近”。
    pub of: Vec<String>,
}

/// 条件树中的一个条件：各项任一满足；`negate` 时排除。`any` 为空的条件谁都不满足
/// （例如点选的标签已被删除）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Condition {
    pub any: Vec<Term>,
    #[serde(default)]
    pub negate: bool,
}

/// 可见的条件树：各条件同时满足。没有条件时是全部参考图。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConditionTree {
    pub conditions: Vec<Condition>,
}

/// 查找时统一的比较形式：NFKC 后小写。Library 匹配参考图自身的文字时用同一个函数。
pub fn fold(text: &str) -> String {
    text.nfkc().flat_map(char::to_lowercase).collect()
}

/// 搜索框下拉中的一个候选标签。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Candidate {
    pub tag: TagLabel,
    /// 经由别名或其他语言的名称命中时，是那个叫法；按显示名命中时为空。
    pub via: Option<String>,
    /// 有这个标签的参考图张数。
    pub count: u32,
}

/// 词表中一个标签可被查到的叫法。
struct Entry {
    id: String,
    namespace: crate::library::TagNamespace,
    names: Vec<crate::library::LocalizedName>,
    external: Vec<String>,
    count: u32,
    /// 各语言名称（尚未翻译时是显示出来的外部名称）与别名：（[`fold`] 后，原文）。
    words: Vec<(String, String)>,
}

impl Entry {
    fn label(&self, lang: &str) -> TagLabel {
        display_label(&self.id, self.namespace, &self.names, &self.external, lang)
    }

    fn contains(&self, needle: &str) -> bool {
        self.words.iter().any(|(w, _)| w.contains(needle))
    }
}

/// 基于一份词表快照的查找。词表修订号不变时可以一直复用。
pub struct Search {
    revision: i64,
    /// 安全模式开启：含成人内容的分级查不到。
    safe_mode: bool,
    entries: Vec<Entry>,
    /// 每个标签的相近标签（`entries` 下标）及来源，已按个人近似对应表优先合并。
    neighbours: HashMap<String, Vec<(usize, ApproxSource)>>,
}

impl Search {
    /// 由词表快照（含个人近似对应表）与内置近似对应表建立。
    pub fn new(vocabulary: &Vocabulary, builtin: &BuiltinApproxTable) -> Search {
        let entries: Vec<Entry> = vocabulary
            .tags
            .iter()
            .map(|t| {
                let word = |w: &str| (fold(w), w.to_owned());
                let mut words: Vec<_> = t.names.iter().map(|n| word(&n.name)).collect();
                if t.names.is_empty() {
                    let shown = display_label(&t.id, t.namespace, &t.names, &t.external, "");
                    words.push(word(&shown.name));
                }
                words.extend(t.aliases.iter().map(|a| word(&a.name)));
                Entry {
                    id: t.id.clone(),
                    namespace: t.namespace,
                    names: t.names.clone(),
                    external: t.external.clone(),
                    count: t.count,
                    words,
                }
            })
            .collect();
        let neighbours = neighbours(&entries, vocabulary, builtin);
        Search {
            revision: vocabulary.revision,
            safe_mode: vocabulary.safe_mode,
            entries,
            neighbours,
        }
    }

    /// 所用词表快照的修订号。
    pub fn revision(&self) -> i64 {
        self.revision
    }

    /// 打字时的候选：名称或别名含 `text` 的标签，最多 `limit` 个。同一个词命中多个命名空间
    /// 或别名时各列一个，不替画师选。排序：完全相同 < 开头相同 < 包含，界面语言的名称先于
    /// 别名与其他语言的名称，再按张数从多到少、名称从短到长。没有图的标签不列出。
    pub fn candidates(&self, text: &str, lang: &str, limit: usize) -> Vec<Candidate> {
        let needle = fold(text.trim());
        if needle.is_empty() {
            return Vec::new();
        }
        let mut found: Vec<(u8, Candidate)> = self
            .entries
            .iter()
            .filter(|e| e.count > 0)
            .filter_map(|e| {
                let tag = e.label(lang);
                let (rank, via) = e
                    .words
                    .iter()
                    .filter_map(|(folded, original)| {
                        let place = if *folded == needle {
                            0
                        } else if folded.starts_with(&needle) {
                            1
                        } else if folded.contains(&needle) {
                            2
                        } else {
                            return None;
                        };
                        let via = (*original != tag.name).then(|| original.clone());
                        Some((place * 2 + u8::from(via.is_some()), via))
                    })
                    .min_by_key(|(rank, _)| *rank)?;
                Some((
                    rank,
                    Candidate {
                        tag,
                        via,
                        count: e.count,
                    },
                ))
            })
            .collect();
        found.sort_by(|(ra, a), (rb, b)| {
            ra.cmp(rb)
                .then(b.count.cmp(&a.count))
                .then(a.tag.name.chars().count().cmp(&b.tag.name.chars().count()))
                .then_with(|| by_display(&a.tag, &b.tag))
        });
        found.truncate(limit);
        found.into_iter().map(|(_, c)| c).collect()
    }

    /// 把搜索框里的条件解析成可见的条件树，标签名按界面语言 `lang`。
    pub fn resolve(&self, input: &SearchInput, lang: &str) -> ConditionTree {
        let conditions = input
            .conditions
            .iter()
            .filter_map(|c| self.condition(c, input.exact, lang))
            .collect();
        ConditionTree { conditions }
    }

    fn condition(&self, input: &ConditionInput, exact: bool, lang: &str) -> Option<Condition> {
        let mut any = Vec::new();
        // An explicitly empty group is false, and its exclusion is true.
        let mut expressed = input.any.is_empty();
        for term in &input.any {
            match term {
                TermInput::Text { text, dismissed } => {
                    let text = text.trim();
                    if text.is_empty() {
                        continue;
                    }
                    expressed = true;
                    let needle = fold(text);
                    let matched: Vec<usize> = (0..self.entries.len())
                        .filter(|&i| self.entries[i].contains(&needle))
                        .collect();
                    let mut tags: Vec<TagLabel> = matched
                        .iter()
                        .map(|&i| self.entries[i].label(lang))
                        .collect();
                    tags.sort_by(by_display);
                    any.push(Term::Text {
                        text: text.to_owned(),
                        tags,
                        similar: self.similar(&matched, dismissed, exact, lang),
                        ratings: matching_ratings(&needle, self.safe_mode)
                            .into_iter()
                            .map(|(_, c)| c.rating)
                            .collect(),
                    });
                }
                TermInput::Rating { ratings } => {
                    expressed = true;
                    any.push(Term::Rating {
                        rating: rating_label(ratings),
                    });
                }
                TermInput::Tag { id, dismissed } => {
                    expressed = true;
                    if let Some(i) = self.entries.iter().position(|e| &e.id == id) {
                        any.push(Term::Tag {
                            tag: self.entries[i].label(lang),
                            similar: self.similar(&[i], dismissed, exact, lang),
                        });
                    }
                }
            }
        }
        expressed.then_some(Condition {
            any,
            negate: input.negate,
        })
    }
}

impl Search {
    /// `primary`（`entries` 下标）各自的相近标签，去掉 `primary` 本身、“只这次”不展开的与
    /// 没有可见的图的；按张数从多到少、再按命名空间与名称排序。
    fn similar(
        &self,
        primary: &[usize],
        dismissed: &[String],
        exact: bool,
        lang: &str,
    ) -> Vec<SimilarTag> {
        if exact {
            return Vec::new();
        }
        let mut found: BTreeMap<usize, (ApproxSource, Vec<String>)> = BTreeMap::new();
        for &p in primary {
            let Some(near) = self.neighbours.get(&self.entries[p].id) else {
                continue;
            };
            for &(n, source) in near {
                let entry = &self.entries[n];
                if primary.contains(&n) || entry.count == 0 || dismissed.contains(&entry.id) {
                    continue;
                }
                let slot = found.entry(n).or_insert((source, Vec::new()));
                if source == ApproxSource::Personal {
                    slot.0 = source;
                }
                slot.1.push(self.entries[p].id.clone());
            }
        }
        let mut similar: Vec<(u32, SimilarTag)> = found
            .into_iter()
            .map(|(n, (source, of))| {
                (
                    self.entries[n].count,
                    SimilarTag {
                        tag: self.entries[n].label(lang),
                        source,
                        of,
                    },
                )
            })
            .collect();
        similar.sort_by(|(ca, a), (cb, b)| cb.cmp(ca).then_with(|| by_display(&a.tag, &b.tag)));
        similar.into_iter().map(|(_, s)| s).collect()
    }
}

/// 合并两份近似对应表：内置表经外部对应落到库内标签，个人表按标签身份覆盖同一对。
fn neighbours(
    entries: &[Entry],
    vocabulary: &Vocabulary,
    builtin: &BuiltinApproxTable,
) -> HashMap<String, Vec<(usize, ApproxSource)>> {
    let index: HashMap<&str, usize> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| (e.id.as_str(), i))
        .collect();
    let by_external: HashMap<&str, usize> = entries
        .iter()
        .enumerate()
        .flat_map(|(i, e)| e.external.iter().map(move |x| (x.as_str(), i)))
        .collect();
    let mut pairs: BTreeMap<(String, String), ApproxSource> = BTreeMap::new();
    for (a, b) in builtin.pairs() {
        if let (Some(&ia), Some(&ib)) = (by_external.get(a), by_external.get(b))
            && ia != ib
        {
            let key = ordered(entries[ia].id.clone(), entries[ib].id.clone());
            pairs.insert(key, ApproxSource::Builtin);
        }
    }
    for entry in &vocabulary.personal_approx {
        if entry.a == entry.b {
            continue;
        }
        let key = ordered(entry.a.clone(), entry.b.clone());
        match entry.relation {
            ApproxRelation::Similar => {
                pairs.insert(key, ApproxSource::Personal);
            }
            ApproxRelation::NotSimilar => {
                pairs.remove(&key);
            }
        }
    }
    let mut neighbours: HashMap<String, Vec<(usize, ApproxSource)>> = HashMap::new();
    for ((a, b), source) in pairs {
        let (Some(&ia), Some(&ib)) = (index.get(a.as_str()), index.get(b.as_str())) else {
            continue;
        };
        neighbours.entry(a).or_default().push((ib, source));
        neighbours.entry(b).or_default().push((ia, source));
    }
    neighbours
}

fn by_display(a: &TagLabel, b: &TagLabel) -> Ordering {
    (a.namespace, &a.name, &a.id).cmp(&(b.namespace, &b.name, &b.id))
}
