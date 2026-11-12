//! 来源标签里的成人记号：pixiv 的 R-18、R-18G，以及 Eagle 里从 pixiv 存下来的同名标签。
//!
//! - 内容分级已经表达“含成人内容”，所以 R-18 不作为标签进库，只体现为分级。
//! - R-18G 同样记为成人分级，但标签保留：它还多一层“猎奇”的意思，分级表达不了。
//! - pixiv 订阅的分级来自作品的 `x_restrict`（见 [`crate::library::subscription_import`]），这里只决定
//!   哪些标签不进库；Eagle 没有分级字段，带记号的条目由这里记为成人分级。

use rusqlite::{Transaction, params};

use super::ContentRating;
use crate::library::tags::FactSource;

/// 来源标签里的一种成人记号。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::library) enum AdultMark {
    /// R-18：只是分级，不作为标签进库。
    R18,
    /// R-18G：记为成人分级，标签保留。
    R18G,
}

impl AdultMark {
    /// 认出标签原文里的记号：不分大小写，忽略连字符、下划线与空格（`R-18`、`r18`、`R_18G`）。
    pub(in crate::library) fn of(name: &str) -> Option<AdultMark> {
        match normalize(name).as_str() {
            "R18" => Some(AdultMark::R18),
            "R18G" => Some(AdultMark::R18G),
            _ => None,
        }
    }

    /// 带这个记号的标签仍作为标签进库。
    pub(in crate::library) fn keeps_tag(self) -> bool {
        self == AdultMark::R18G
    }
}

fn normalize(name: &str) -> String {
    name.chars()
        .filter(|c| !matches!(c, '-' | '_' | ' ' | '\u{3000}'))
        .flat_map(char::to_uppercase)
        .collect()
}

/// 来源标签原文中作为标签进库的那些（去掉 R-18）。
pub(in crate::library) fn tags_to_keep(names: &[String]) -> impl Iterator<Item = &String> {
    names
        .iter()
        .filter(|n| AdultMark::of(n).is_none_or(AdultMark::keeps_tag))
}

/// 来源标签原文里有成人记号。
pub(in crate::library) fn marks_adult(names: &[String]) -> bool {
    names.iter().any(|n| AdultMark::of(n).is_some())
}

/// 按来源标签原文重写这一来源层的分级：有成人记号时记为成人，否则这一层没有分级。
/// 有效分级因此变了时列表修订号前进：安全模式下浏览结果集跟着变，旧的分页游标要失效。
pub(in crate::library) fn replace_rating_from_tags(
    tx: &Transaction,
    source: &FactSource,
    image_id: &str,
    names: &[String],
) -> rusqlite::Result<()> {
    let effective = format!("SELECT {}", super::effective_rank_sql("?1"));
    let before: Option<i64> = tx.query_row(&effective, [image_id], |r| r.get(0))?;
    tx.execute(
        "DELETE FROM rating_fact WHERE image_id = ?1 AND source = ?2",
        params![image_id, source.as_str()],
    )?;
    if marks_adult(names) {
        tx.execute(
            "INSERT INTO rating_fact (image_id, source, rating, score) VALUES (?1, ?2, ?3, NULL)",
            params![image_id, source.as_str(), ContentRating::Explicit.as_str()],
        )?;
    }
    let after: Option<i64> = tx.query_row(&effective, [image_id], |r| r.get(0))?;
    if before != after {
        tx.execute("UPDATE list_revision SET value = value + 1", [])?;
    }
    Ok(())
}

/// 与 [`normalize`] 相同的写法归一，SQL 版。
const NORMALIZED_SQL: &str =
    "upper(replace(replace(replace(replace(name, '-', ''), '_', ''), ' ', ''), char(12288), ''))";

/// 迁移：已经进库的 pixiv 订阅与 Eagle 来源层按上面的规则改写。Eagle 条目带 R-18 或 R-18G
/// 的记为成人分级（记号按来源名称、名称或别名认）；两种来源层的 R-18 标签去掉。只看一般标签：叫 R-18 的作者等不受影响；
/// 人工加的标签不动。
pub(in crate::library) fn upgrade_existing(tx: &Transaction) -> rusqlite_migration::HookResult {
    let marked = |normalized: &str| {
        format!(
            "SELECT id FROM tag WHERE namespace = 'general' AND id IN (
                 SELECT tag_id FROM tag_source_name WHERE {NORMALIZED_SQL} = '{normalized}'
                 UNION SELECT tag_id FROM tag_name WHERE {NORMALIZED_SQL} = '{normalized}'
                 UNION SELECT tag_id FROM tag_alias WHERE {NORMALIZED_SQL} = '{normalized}')"
        )
    };
    let (r18, r18g) = (marked("R18"), marked("R18G"));
    let added = tx.execute(
        &format!(
            "INSERT OR IGNORE INTO rating_fact (image_id, source, rating, score)
             SELECT DISTINCT image_id, source, ?1, NULL FROM tag_fact
             WHERE source LIKE 'eagle:%' AND (tag_id IN ({r18}) OR tag_id IN ({r18g}))"
        ),
        [ContentRating::Explicit.as_str()],
    )?;
    let removed = tx.execute(
        &format!(
            "DELETE FROM tag_fact
             WHERE (source LIKE 'eagle:%' OR source LIKE 'pixiv:%') AND tag_id IN ({r18})"
        ),
        [],
    )?;
    if added > 0 {
        tx.execute("UPDATE list_revision SET value = value + 1", [])?;
    }
    if removed > 0 {
        tx.execute("UPDATE vocabulary_revision SET value = value + 1", [])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_are_recognized_in_common_spellings() {
        for name in ["R-18", "r-18", "R18", "R_18", " R-18 "] {
            assert_eq!(AdultMark::of(name), Some(AdultMark::R18), "{name}");
        }
        for name in ["R-18G", "r18g", "R-18g"] {
            assert_eq!(AdultMark::of(name), Some(AdultMark::R18G), "{name}");
        }
        for name in ["R-15", "R-180", "原神", "R-18G漫画"] {
            assert_eq!(AdultMark::of(name), None, "{name}");
        }
    }

    #[test]
    fn only_r18_is_dropped_from_tags() {
        let names: Vec<String> = ["R-18", "R-18G", "原神"].map(str::to_owned).into();
        let kept: Vec<&String> = tags_to_keep(&names).collect();
        assert_eq!(kept, ["R-18G", "原神"]);
        assert!(marks_adult(&names));
        assert!(!marks_adult(&["原神".to_owned()]));
    }
}
