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
//! - 外部对应不是叫法，不参与匹配（ADR-0003）；尚未翻译的标签按显示出来的外部名称匹配。
//! - 比较前统一做 NFKC 与小写（[`fold`]），全角半角、大小写不影响查找。
//!
//! 条件树为后续切片留好位置，调用方不用改：近似查找（#56）把相近标签填进
//! [`Term::Tag::similar`]；安全模式（#60）在 Library 执行条件树时过滤，Search 不参与。

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use unicode_normalization::UnicodeNormalization;

use crate::library::{TagLabel, Vocabulary, display_label};

/// 搜索框里的一项：点选的标签，或直接输入的文字。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum TermInput {
    /// 从候选中点选的标签。
    Tag { id: String },
    /// 直接输入的文字。
    Text { text: String },
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
}

/// 条件树中的一项，带显示用的标签名，界面照此显示条件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum Term {
    /// 有这个有效标签，或有任一相近标签。
    Tag {
        tag: TagLabel,
        /// 近似查找展开的相近标签（#56），与 `tag` 一起作为任一；精确查找时为空。
        #[serde(default)]
        similar: Vec<TagLabel>,
    },
    /// 直接输入的文字：有名称或别名含这段文字的任一标签，或参考图自身的文字含它。
    Text {
        text: String,
        /// 名称或别名含这段文字的标签，按命名空间与名称排序。
        tags: Vec<TagLabel>,
    },
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

/// 词表中一个标签可被查到的叫法。
struct Entry {
    id: String,
    namespace: crate::library::TagNamespace,
    names: Vec<crate::library::LocalizedName>,
    external: Vec<String>,
    count: u32,
    /// 各语言名称（尚未翻译时是显示出来的外部名称）与别名，已 [`fold`]。
    words: Vec<String>,
}

impl Entry {
    fn label(&self, lang: &str) -> TagLabel {
        display_label(&self.id, self.namespace, &self.names, &self.external, lang)
    }

    fn contains(&self, needle: &str) -> bool {
        self.words.iter().any(|w| w.contains(needle))
    }
}

/// 基于一份词表快照的查找。词表修订号不变时可以一直复用。
pub struct Search {
    revision: i64,
    entries: Vec<Entry>,
}

impl Search {
    pub fn new(vocabulary: &Vocabulary) -> Search {
        let entries = vocabulary
            .tags
            .iter()
            .map(|t| {
                let mut words: Vec<String> = t.names.iter().map(|n| fold(&n.name)).collect();
                if t.names.is_empty() {
                    let shown = display_label(&t.id, t.namespace, &t.names, &t.external, "");
                    words.push(fold(&shown.name));
                }
                words.extend(t.aliases.iter().map(|a| fold(&a.name)));
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
        Search {
            revision: vocabulary.revision,
            entries,
        }
    }

    /// 所用词表快照的修订号。
    pub fn revision(&self) -> i64 {
        self.revision
    }

    /// 把搜索框里的条件解析成可见的条件树，标签名按界面语言 `lang`。
    pub fn resolve(&self, input: &SearchInput, lang: &str) -> ConditionTree {
        let conditions = input
            .conditions
            .iter()
            .filter_map(|c| self.condition(c, lang))
            .collect();
        ConditionTree { conditions }
    }

    fn condition(&self, input: &ConditionInput, lang: &str) -> Option<Condition> {
        let mut any = Vec::new();
        let mut expressed = false;
        for term in &input.any {
            match term {
                TermInput::Text { text } => {
                    let text = text.trim();
                    if text.is_empty() {
                        continue;
                    }
                    expressed = true;
                    let needle = fold(text);
                    let mut tags: Vec<TagLabel> = self
                        .entries
                        .iter()
                        .filter(|e| e.contains(&needle))
                        .map(|e| e.label(lang))
                        .collect();
                    tags.sort_by(by_display);
                    any.push(Term::Text {
                        text: text.to_owned(),
                        tags,
                    });
                }
                TermInput::Tag { id } => {
                    expressed = true;
                    if let Some(entry) = self.entries.iter().find(|e| &e.id == id) {
                        any.push(Term::Tag {
                            tag: entry.label(lang),
                            similar: Vec::new(),
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

fn by_display(a: &TagLabel, b: &TagLabel) -> Ordering {
    (a.namespace, &a.name, &a.id).cmp(&(b.namespace, &b.name, &b.id))
}
