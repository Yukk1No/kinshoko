//! 迁入向导：Eagle 标签的外部对应（#59，ADR-0003）。
//!
//! - Eagle 原有标签没有外部对应，因而不参与内置近似对应表。迁入后按名称与翻译表把它们
//!   精确匹配到外部词表（[`ExternalVocabulary`]）中的名称，写成外部对应。
//! - 比较前把两边都规范化：NFKC（全角转半角）、不分大小写、空格与下划线视为同一个分隔符。
//!   规范化后仍对应到多个外部名称的不自动写入，交给画师选。
//! - 没对上的标签列出来，画师可以逐个补对应（[`super::Library::map_tag_external`]），
//!   也可以跳过；跳过的标签早已照常迁入，只是不参与内置近似对应表。

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;
use ts_rs::TS;

use super::tags::{self, TagLabel, TagTranslations};
use super::{Error, Inner};
use crate::approx::BuiltinApproxTable;
use crate::search::fold;

/// 规范化后的比较键：NFKC、小写，空白与下划线折成一个空格，去掉首尾分隔符。
fn key(text: &str) -> String {
    let folded = fold(text);
    folded
        .split(|c: char| c == '_' || c.is_whitespace())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// 外部词表：可作为外部对应的名称（如打标模型词表 `selected_tags.csv`、内置近似对应表中的
/// 名称），以及翻译表中各外部名称的各语言名称与别名。克隆代价很小。
#[derive(Debug, Clone, Default)]
pub struct ExternalVocabulary {
    inner: Arc<VocabularyIndex>,
}

#[derive(Debug, Default)]
struct VocabularyIndex {
    /// 规范化键 → 外部名称。
    by_name: HashMap<String, BTreeSet<String>>,
    /// 翻译表中名称或别名的规范化键 → 外部名称。
    by_translation: HashMap<String, BTreeSet<String>>,
    /// 供补对应时联想：(规范化键, 外部名称)，按外部名称排好。
    suggest: Vec<(String, String)>,
}

impl ExternalVocabulary {
    /// 由外部名称与翻译表构造。翻译表中的外部名称也算进词表。
    pub fn new(names: impl IntoIterator<Item = String>, translations: &TagTranslations) -> Self {
        let mut index = VocabularyIndex::default();
        let mut all = BTreeSet::new();
        for name in names {
            let name = name.trim().to_owned();
            if !name.is_empty() {
                all.insert(name);
            }
        }
        for entry in &translations.entries {
            let external = entry.external.trim();
            if external.is_empty() {
                continue;
            }
            all.insert(external.to_owned());
            let spoken = entry
                .names
                .values()
                .chain(entry.aliases.iter().map(|a| &a.name));
            for name in spoken {
                let k = key(name);
                if !k.is_empty() {
                    index
                        .by_translation
                        .entry(k.clone())
                        .or_default()
                        .insert(external.to_owned());
                    index.suggest.push((k, external.to_owned()));
                }
            }
        }
        for name in all {
            let k = key(&name);
            if k.is_empty() {
                continue;
            }
            index
                .by_name
                .entry(k.clone())
                .or_default()
                .insert(name.clone());
            index.suggest.push((k, name));
        }
        index
            .suggest
            .sort_by(|a, b| (&a.1, &a.0).cmp(&(&b.1, &b.0)));
        index.suggest.dedup();
        ExternalVocabulary {
            inner: Arc::new(index),
        }
    }

    /// 内置近似对应表中出现的全部外部名称。
    pub fn builtin_names(table: &BuiltinApproxTable) -> Vec<String> {
        let mut names: BTreeSet<String> = BTreeSet::new();
        for (a, b) in table.pairs() {
            names.insert(a.to_owned());
            names.insert(b.to_owned());
        }
        names.into_iter().collect()
    }

    /// 读打标模型的词表 `selected_tags.csv`（`name` 列）。
    pub fn read_tags_csv(path: &Path) -> Result<Vec<String>, String> {
        let mut reader = csv::Reader::from_path(path).map_err(|e| e.to_string())?;
        let column = reader
            .headers()
            .map_err(|e| e.to_string())?
            .iter()
            .position(|h| h == "name")
            .ok_or("词表缺少 name 列")?;
        let mut names = Vec::new();
        for record in reader.records() {
            let record = record.map_err(|e| e.to_string())?;
            if let Some(name) = record.get(column) {
                names.push(name.to_owned());
            }
        }
        Ok(names)
    }

    /// 词表中的外部名称个数。
    pub fn len(&self) -> usize {
        self.inner.by_name.values().map(BTreeSet::len).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.by_name.is_empty()
    }

    /// 规范化后与 `text` 相同的外部名称。
    pub fn by_name(&self, text: &str) -> Vec<String> {
        self.inner
            .by_name
            .get(&key(text))
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// 翻译表中名称或别名规范化后与 `text` 相同的外部名称。
    pub fn by_translation(&self, text: &str) -> Vec<String> {
        self.inner
            .by_translation
            .get(&key(text))
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// 补对应时的联想：规范化后以 `query` 开头的排前面，其次是包含它的；最多 `limit` 个。
    pub fn suggest(&self, query: &str, limit: usize) -> Vec<String> {
        let q = key(query);
        if q.is_empty() {
            return Vec::new();
        }
        let mut hits: Vec<(bool, usize, &str)> = Vec::new();
        let mut seen = HashSet::new();
        for (k, name) in &self.inner.suggest {
            if k.contains(&q) && seen.insert(name.as_str()) {
                hits.push((!k.starts_with(&q), name.len(), name.as_str()));
            }
        }
        hits.sort();
        hits.into_iter()
            .take(limit)
            .map(|(_, _, n)| n.to_owned())
            .collect()
    }

    /// 匹配一个标签的若干名称：先按外部名称本身，再按翻译表。
    fn matches(&self, names: &[String]) -> (Vec<String>, MatchBasis) {
        let collect = |f: &dyn Fn(&str) -> Vec<String>| {
            names
                .iter()
                .flat_map(|n| f(n))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
        };
        let by_name = collect(&|n| self.by_name(n));
        if !by_name.is_empty() {
            return (by_name, MatchBasis::Name);
        }
        (
            collect(&|n| self.by_translation(n)),
            MatchBasis::Translation,
        )
    }
}

/// 外部对应是怎么得来的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MatchBasis {
    /// 标签名规范化后与外部名称相同。
    Name,
    /// 标签名是翻译表中某个外部名称的名称或别名。
    Translation,
    /// 这次匹配之前就有（模型输出、画师补上或上次迁入时匹配的）。
    Earlier,
}

/// 已有外部对应的 Eagle 标签。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EagleTagMatch {
    pub tag: TagLabel,
    pub count: u32,
    pub external: Vec<String>,
    pub basis: MatchBasis,
}

/// 没对上外部对应的 Eagle 标签。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UnmatchedEagleTag {
    pub tag: TagLabel,
    pub count: u32,
    /// 规范化后对上了不止一个外部名称时的候选，由画师选。
    pub candidates: Vec<String>,
    /// 对上的外部名称已对应到库内另一个标签（例如打标模型先建了它）。
    pub taken_by: Option<TagLabel>,
    pub taken_external: Option<String>,
}

/// 迁入向导“标签的外部对应”一步的内容。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EagleTagMapping {
    pub matched: Vec<EagleTagMatch>,
    /// 按张数从多到少。
    pub unmatched: Vec<UnmatchedEagleTag>,
    /// 外部词表的名称个数，供界面说明匹配用的词表规模。
    pub vocabulary_size: u32,
}

/// 画师补上的外部对应。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MappedExternal {
    /// 实际写入的外部名称（规范化后在词表中找到时用词表的写法）。
    pub external: String,
    /// 在外部词表中。不在词表中的名称也会写入，但内置近似对应表多半不认识它。
    pub known: bool,
}

/// 写线程上一个标签的匹配结果。
enum Outcome {
    Matched(MatchBasis),
    Ambiguous(Vec<String>),
    Taken(String, String),
    None,
}

fn eagle_tag_ids(conn: &rusqlite::Connection) -> Result<Vec<String>, Error> {
    let mut stmt = conn.prepare_cached(
        "SELECT DISTINCT tag_id FROM tag_fact WHERE source LIKE 'eagle:%' ORDER BY tag_id",
    )?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn tag_names(tx: &Transaction, tag_id: &str) -> Result<Vec<String>, Error> {
    let mut stmt = tx.prepare_cached(
        "SELECT name FROM tag_name WHERE tag_id = ?1
         UNION SELECT name FROM tag_alias WHERE tag_id = ?1",
    )?;
    let rows = stmt.query_map([tag_id], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn owner(tx: &Transaction, external: &str) -> Result<Option<String>, Error> {
    Ok(tx
        .query_row(
            "SELECT tag_id FROM tag_external WHERE name = ?1",
            [external],
            |r| r.get(0),
        )
        .optional()?)
}

/// 自动匹配还没有外部对应的 Eagle 标签并写入，返回向导要显示的内容。
pub(super) fn map_eagle_tags(
    inner: &Inner,
    vocabulary: &ExternalVocabulary,
    lang: &str,
) -> Result<EagleTagMapping, Error> {
    let size = vocabulary_size(vocabulary);
    let vocabulary = vocabulary.clone();
    let outcomes = tags::write(inner, Vec::new(), move |tx, _| {
        let mut outcomes = HashMap::new();
        for tag_id in eagle_tag_ids(tx)? {
            let has_external: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM tag_external WHERE tag_id = ?1)",
                [&tag_id],
                |r| r.get(0),
            )?;
            if has_external {
                continue;
            }
            let (found, basis) = vocabulary.matches(&tag_names(tx, &tag_id)?);
            let outcome = match found.as_slice() {
                [] => Outcome::None,
                [external] => match owner(tx, external)? {
                    Some(other) => Outcome::Taken(external.clone(), other),
                    None => {
                        tx.execute(
                            "INSERT INTO tag_external (name, tag_id) VALUES (?1, ?2)",
                            params![external, tag_id],
                        )?;
                        Outcome::Matched(basis)
                    }
                },
                _ => Outcome::Ambiguous(found),
            };
            outcomes.insert(tag_id, outcome);
        }
        Ok(outcomes)
    })?;

    let conn = inner.readers.get();
    let hidden = inner.sealed_only_tags(&conn)?;
    let counts = tags::counts(inner, &conn)?;
    let ids: Vec<String> = eagle_tag_ids(&conn)?
        .into_iter()
        .filter(|id| !hidden.contains(id))
        .collect();
    let taken_owners = outcomes.values().filter_map(|o| match o {
        Outcome::Taken(_, owner) => Some(owner.clone()),
        _ => None,
    });
    let rows = tags::load_tags(&conn, ids.iter().cloned().chain(taken_owners))?;
    let mut mapping = EagleTagMapping {
        matched: Vec::new(),
        unmatched: Vec::new(),
        vocabulary_size: size,
    };
    for id in ids {
        let row = &rows[&id];
        let tag = tags::label(&id, row, lang);
        let count = counts.get(&id).copied().unwrap_or(0);
        let mut unmatched = UnmatchedEagleTag {
            tag: tag.clone(),
            count,
            candidates: Vec::new(),
            taken_by: None,
            taken_external: None,
        };
        match outcomes.get(&id) {
            Some(Outcome::Matched(basis)) => mapping.matched.push(EagleTagMatch {
                tag,
                count,
                external: row.external.clone(),
                basis: *basis,
            }),
            None => mapping.matched.push(EagleTagMatch {
                tag,
                count,
                external: row.external.clone(),
                basis: MatchBasis::Earlier,
            }),
            Some(Outcome::Ambiguous(candidates)) => {
                unmatched.candidates = candidates.clone();
                mapping.unmatched.push(unmatched);
            }
            Some(Outcome::Taken(external, owner)) => {
                // 被安全模式藏起来的标签不报名字。
                if !hidden.contains(owner) {
                    unmatched.taken_by = Some(tags::label(owner, &rows[owner], lang));
                }
                unmatched.taken_external = Some(external.clone());
                mapping.unmatched.push(unmatched);
            }
            Some(Outcome::None) => mapping.unmatched.push(unmatched),
        }
    }
    mapping
        .matched
        .sort_by(|a, b| (b.count, &a.tag.name, &a.tag.id).cmp(&(a.count, &b.tag.name, &b.tag.id)));
    mapping
        .unmatched
        .sort_by(|a, b| (b.count, &a.tag.name, &a.tag.id).cmp(&(a.count, &b.tag.name, &b.tag.id)));
    Ok(mapping)
}

fn vocabulary_size(vocabulary: &ExternalVocabulary) -> u32 {
    u32::try_from(vocabulary.len()).unwrap_or(u32::MAX)
}

/// 画师给一个标签补上外部对应；输入规范化后在词表中只对上一个名称时用词表的写法。
pub(super) fn map_tag_external(
    inner: &Inner,
    tag_id: &str,
    input: &str,
    vocabulary: &ExternalVocabulary,
) -> Result<MappedExternal, Error> {
    let input = input.trim();
    if input.is_empty() {
        return Err(Error::InvalidTagName);
    }
    let found = vocabulary.by_name(input);
    let mapped = match found.as_slice() {
        [one] => MappedExternal {
            external: one.clone(),
            known: true,
        },
        _ => MappedExternal {
            external: input.to_owned(),
            known: found.iter().any(|n| n == input),
        },
    };
    tags::add_tag_external(inner, tag_id, &mapped.external)?;
    Ok(mapped)
}
