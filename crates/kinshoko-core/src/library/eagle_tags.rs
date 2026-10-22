//! 迁入向导：Eagle 标签的外部对应（#59，ADR-0003）。
//!
//! - Eagle 原有标签没有外部对应，因而不参与内置近似对应表。迁入后按名称与翻译表把它们
//!   精确匹配到外部词表（[`ExternalVocabulary`]）中的名称，写成外部对应。
//! - 比较前把两边都规范化：NFKC（全角转半角）、不分大小写、空格与下划线视为同一个分隔符。
//!   规范化后仍对应到多个外部名称的不自动写入，交给画师选。
//! - 没对上的标签列出来，画师可以逐个补对应（[`super::Library::map_tag_external`]），
//!   也可以跳过；跳过的标签早已照常迁入，只是不参与内置近似对应表。
//! - 对上之后按 ADR-0012 安置 Eagle 原文（本库的来源名称）：与外部名称写法相同的成为不分语言的
//!   别名，显示跟随默认名称；是翻译表中某语言的名称或别名的，成为该语言的来源名称；其余保持
//!   按文字判断的语言。外部对应已属于库内另一个标签时，Eagle 标签并入那个标签，原文只作别名，
//!   显示跟随那个标签。

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;
use ts_rs::TS;

use super::events::LibraryEvent;
use super::source_names;
use super::tags::{self, TagLabel, TagNamespace, TagTranslation, TagTranslations};
use super::{Error, Inner};
use crate::approx::BuiltinApproxTable;
use crate::search::fold;

mod upgrade;
mod vocabulary;

pub(super) use upgrade::upgrade_source_names;
pub use vocabulary::ExternalVocabulary;
use vocabulary::{Placement, key};

/// 规范化后写法相同（不分大小写、全半角，空格与下划线视为同一个分隔符），如 `blue eyes` 与 `blue_eyes`。
pub(crate) fn same_spelling(a: &str, b: &str) -> bool {
    key(a) == key(b)
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
    /// 外部对应已属于库内另一个标签（例如打标模型先建了它），这个 Eagle 标签已并入它。
    /// 那个标签被安全模式藏起来时为空。
    pub merged_into: Option<TagLabel>,
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
    /// 外部名称已属于另一个标签时，这个标签已并入它；这里是那个标签的 id。
    pub merged_into: Option<String>,
}

/// 写线程上一个标签的匹配结果。
enum Outcome {
    Matched(MatchBasis),
    Merged { into: String, basis: MatchBasis },
    Ambiguous(Vec<String>),
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
        "SELECT name FROM tag_source_name WHERE tag_id = ?1
         UNION SELECT name FROM tag_name WHERE tag_id = ?1
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

fn namespace(tx: &Transaction, tag_id: &str) -> Result<String, Error> {
    Ok(
        tx.query_row("SELECT namespace FROM tag WHERE id = ?1", [tag_id], |r| {
            r.get(0)
        })?,
    )
}

fn has_external(tx: &Transaction, tag_id: &str) -> Result<bool, Error> {
    Ok(tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM tag_external WHERE tag_id = ?1)",
        [tag_id],
        |r| r.get(0),
    )?)
}

/// 标签对上 `external` 之后：按 ADR-0012 安置它的来源名称；还没有默认名称时按翻译表初始化。
fn settle(
    tx: &Transaction,
    vocabulary: &ExternalVocabulary,
    tag_id: &str,
    external: &str,
) -> Result<(), Error> {
    for name in source_names::load(tx, tag_id)? {
        match vocabulary.place(&name.name, external) {
            Placement::Alias => {
                tx.execute(
                    "DELETE FROM tag_source_name WHERE tag_id = ?1 AND name = ?2",
                    params![tag_id, name.name],
                )?;
                tx.execute(
                    "INSERT OR IGNORE INTO tag_alias (tag_id, name, lang) VALUES (?1, ?2, NULL)",
                    params![tag_id, name.name],
                )?;
            }
            Placement::Lang(lang) => {
                tx.execute(
                    "UPDATE tag_source_name SET lang = ?3 WHERE tag_id = ?1 AND name = ?2",
                    params![tag_id, name.name, lang],
                )?;
            }
            Placement::Keep => {}
        }
    }
    let has_names: bool = tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM tag_name WHERE tag_id = ?1)",
        [tag_id],
        |r| r.get(0),
    )?;
    if !has_names && let Some(translation) = vocabulary.translation(external) {
        let namespace: String =
            tx.query_row("SELECT namespace FROM tag WHERE id = ?1", [tag_id], |r| {
                r.get(0)
            })?;
        tags::initialise_names(tx, TagNamespace::parse(&namespace)?, tag_id, translation)?;
    }
    Ok(())
}

/// 两个标签并成一个之前：各自的来源名称只降为别名（按 ADR-0012 定语言，不分语言的不注明），
/// 仍可查找，显示跟随默认名称（维护者在 #217 选定）。
fn demote(
    tx: &Transaction,
    vocabulary: &ExternalVocabulary,
    tag_id: &str,
    external: &str,
) -> Result<(), Error> {
    for name in source_names::load(tx, tag_id)? {
        let lang = match vocabulary.place(&name.name, external) {
            Placement::Alias => None,
            Placement::Lang(lang) => Some(lang),
            Placement::Keep => (name.lang != source_names::UND).then_some(name.lang),
        };
        tx.execute(
            "DELETE FROM tag_source_name WHERE tag_id = ?1 AND name = ?2",
            params![tag_id, name.name],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO tag_alias (tag_id, name, lang) VALUES (?1, ?2, ?3)",
            params![tag_id, name.name, lang],
        )?;
    }
    Ok(())
}

/// 给标签写上 `external`：外部名称已属于另一个标签时并入它。返回并入的标签与标签有变化的图。
fn attach(
    tx: &Transaction,
    vocabulary: &ExternalVocabulary,
    tag_id: &str,
    external: &str,
) -> Result<(Option<String>, Vec<String>), Error> {
    match owner(tx, external)? {
        Some(other) if other == tag_id => {
            settle(tx, vocabulary, tag_id, external)?;
            Ok((None, Vec::new()))
        }
        Some(other) => {
            // 命名空间是标签身份的一部分：不同命名空间的不并，留给画师处理。
            if namespace(tx, tag_id)? != namespace(tx, &other)? {
                return Err(Error::ExternalTaken(external.to_owned()));
            }
            // 两边都降：谁先对上外部名称不影响结果。
            demote(tx, vocabulary, tag_id, external)?;
            demote(tx, vocabulary, &other, external)?;
            let images = tags::merge(tx, tag_id, &other)?;
            settle(tx, vocabulary, &other, external)?;
            Ok((Some(other), images))
        }
        None => {
            tx.execute(
                "INSERT INTO tag_external (name, tag_id) VALUES (?1, ?2)",
                params![external, tag_id],
            )?;
            settle(tx, vocabulary, tag_id, external)?;
            Ok((None, Vec::new()))
        }
    }
}

/// 匹配一个还没有外部对应的标签并写入。
fn match_tag(
    tx: &Transaction,
    vocabulary: &ExternalVocabulary,
    tag_id: &str,
    changed: &mut Vec<String>,
) -> Result<Outcome, Error> {
    let (found, basis) = vocabulary.matches(&tag_names(tx, tag_id)?);
    Ok(match found.as_slice() {
        [] => Outcome::None,
        [external] => match attach(tx, vocabulary, tag_id, external) {
            // 外部名称属于别的命名空间的标签：不自动处理，作为候选留在没对上的里。
            Err(Error::ExternalTaken(_)) => Outcome::Ambiguous(found),
            result => {
                let (merged, images) = result?;
                changed.extend(images);
                match merged {
                    Some(into) => Outcome::Merged { into, basis },
                    None => Outcome::Matched(basis),
                }
            }
        },
        _ => Outcome::Ambiguous(found),
    })
}

/// 自动匹配还没有外部对应的 Eagle 标签并写入，返回向导要显示的内容。
pub(super) fn map_eagle_tags(
    inner: &Inner,
    vocabulary: &ExternalVocabulary,
    lang: &str,
) -> Result<EagleTagMapping, Error> {
    let size = vocabulary_size(vocabulary);
    let hidden_before = {
        let conn = inner.readers.get();
        inner.sealed_only_tags(&conn)?
    };
    let vocabulary = vocabulary.clone();
    let shown_lang = lang.to_owned();
    let (outcomes, changed) = tags::write(inner, Vec::new(), move |tx, _| {
        let mut outcomes = HashMap::new();
        let mut changed = Vec::new();
        for tag_id in eagle_tag_ids(tx)? {
            if has_external(tx, &tag_id)? {
                continue;
            }
            // 并入后这个标签就不在了：先记下它原来的样子。
            let before = tags::load_tags(tx, [tag_id.clone()])?;
            let label = tags::label(&tag_id, &before[&tag_id], &shown_lang);
            let outcome = match_tag(tx, &vocabulary, &tag_id, &mut changed)?;
            outcomes.insert(tag_id, (outcome, label));
        }
        Ok((outcomes, changed))
    })?;
    if !changed.is_empty() {
        inner.hub.publish(LibraryEvent::ImagesChanged {
            library_id: inner.info.id.clone(),
            image_ids: changed,
        });
    }

    let conn = inner.readers.get();
    let hidden = inner.sealed_only_tags(&conn)?;
    let counts = tags::counts(inner, &conn)?;
    let targets: HashSet<String> = outcomes
        .values()
        .filter_map(|(o, _)| match o {
            Outcome::Merged { into, .. } => Some(into.clone()),
            _ => None,
        })
        .collect();
    let ids: Vec<String> = eagle_tag_ids(&conn)?
        .into_iter()
        // 别的标签并入的标签只在自己这次也对上时列出，免得把早先对上的再报一遍。
        .filter(|id| {
            !hidden.contains(id)
                && (!targets.contains(id)
                    || matches!(outcomes.get(id), Some((Outcome::Matched(_), _))))
        })
        .collect();
    let rows = tags::load_tags(&conn, ids.iter().cloned().chain(targets.iter().cloned()))?;
    let mut mapping = EagleTagMapping {
        matched: Vec::new(),
        unmatched: Vec::new(),
        vocabulary_size: size,
    };
    for id in ids {
        let row = &rows[&id];
        let tag = tags::label(&id, row, lang);
        let count = counts.get(&id).copied().unwrap_or(0);
        let basis = match outcomes.get(&id) {
            Some((Outcome::Matched(basis), _)) => *basis,
            None => MatchBasis::Earlier,
            Some((Outcome::Ambiguous(candidates), _)) => {
                mapping.unmatched.push(UnmatchedEagleTag {
                    tag,
                    count,
                    candidates: candidates.clone(),
                });
                continue;
            }
            Some((Outcome::None, _)) => {
                mapping.unmatched.push(UnmatchedEagleTag {
                    tag,
                    count,
                    candidates: Vec::new(),
                });
                continue;
            }
            Some((Outcome::Merged { .. }, _)) => continue,
        };
        mapping.matched.push(EagleTagMatch {
            tag,
            count,
            external: row.external.clone(),
            basis,
            merged_into: None,
        });
    }
    for (id, (outcome, before)) in &outcomes {
        let Outcome::Merged { into, basis } = outcome else {
            continue;
        };
        if hidden_before.contains(id) {
            continue;
        }
        // 被安全模式藏起来的标签不报名字。
        let merged_into = (!hidden.contains(into)).then(|| tags::label(into, &rows[into], lang));
        mapping.matched.push(EagleTagMatch {
            tag: before.clone(),
            count: counts.get(into).copied().unwrap_or(0),
            external: rows[into].external.clone(),
            basis: *basis,
            merged_into,
        });
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
/// 外部名称已属于另一个标签时，这个标签并入它（与迁入向导的自动匹配相同，ADR-0012）。
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
    let (external, known) = match found.as_slice() {
        [one] => (one.clone(), true),
        _ => (input.to_owned(), found.iter().any(|n| n == input)),
    };
    let vocabulary = vocabulary.clone();
    let (tag_id, written) = (tag_id.to_owned(), external.clone());
    let (merged_into, changed) = tags::write(inner, Vec::new(), move |tx, _| {
        tx.query_row("SELECT 1 FROM tag WHERE id = ?1", [&tag_id], |_| Ok(()))
            .optional()?
            .ok_or(Error::UnknownTag)?;
        attach(tx, &vocabulary, &tag_id, &written)
    })?;
    if !changed.is_empty() {
        inner.hub.publish(LibraryEvent::ImagesChanged {
            library_id: inner.info.id.clone(),
            image_ids: changed,
        });
    }
    Ok(MappedExternal {
        external,
        known,
        merged_into,
    })
}
