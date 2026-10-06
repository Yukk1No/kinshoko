//! 执行 Search 给出的条件树（#54）：把条件树写成对 `image` 表的 SQL 筛选。
//!
//! - 标签项：有这个有效标签或任一相近标签（`effective_tag`，人工标签决定已算进去）；
//! - 文字项：有名称或别名含这段文字的任一标签，或参考图自身的文字含它。参考图自身的文字
//!   是原文件名、本库备注、来源备注与非本地文件来源的位置（如网址）；
//! - 安全模式（#60）等浏览视角的过滤在调用方另加条件，与条件树无关。

use rusqlite::Connection;
use rusqlite::functions::FunctionFlags;
use rusqlite::types::Value;

use crate::search::{Condition, ConditionTree, Term, fold};

/// 在读连接上注册的比较函数名，与 [`fold`] 相同。
const FOLD_FN: &str = "kinshoko_fold";

/// 给连接注册 [`FOLD_FN`]。
pub(super) fn register(conn: &Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function(
        FOLD_FN,
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| Ok(fold(&ctx.get::<String>(0)?)),
    )
}

/// 条件树对应的筛选表达式（引用 `image`）。参数追加到 `args` 末尾，按 `?N` 编号。
pub(super) fn sql(tree: &ConditionTree, args: &mut Vec<Value>) -> String {
    let parts: Vec<String> = tree.conditions.iter().map(|c| condition(c, args)).collect();
    if parts.is_empty() {
        "1".to_owned()
    } else {
        parts.join(" AND ")
    }
}

fn condition(condition: &Condition, args: &mut Vec<Value>) -> String {
    let terms: Vec<String> = condition.any.iter().map(|t| term(t, args)).collect();
    let any = if terms.is_empty() {
        "0".to_owned()
    } else {
        terms.join(" OR ")
    };
    if condition.negate {
        format!("NOT ({any})")
    } else {
        format!("({any})")
    }
}

fn param(args: &mut Vec<Value>, value: Value) -> String {
    args.push(value);
    format!("?{}", args.len())
}

/// 有其中任一有效标签。
fn has_any_tag<'a>(ids: impl Iterator<Item = &'a str>, args: &mut Vec<Value>) -> Option<String> {
    let list: Vec<String> = ids
        .map(|id| param(args, Value::Text(id.to_owned())))
        .collect();
    (!list.is_empty()).then(|| {
        format!(
            "image.id IN (SELECT image_id FROM effective_tag WHERE tag_id IN ({}))",
            list.join(", ")
        )
    })
}

fn term(term: &Term, args: &mut Vec<Value>) -> String {
    match term {
        Term::Tag { tag, similar } => has_any_tag(
            std::iter::once(tag.id.as_str()).chain(similar.iter().map(|s| s.tag.id.as_str())),
            args,
        )
        .unwrap_or_else(|| "0".to_owned()),
        Term::Text {
            text,
            tags,
            similar,
        } => {
            let needle = param(args, Value::Text(fold(text)));
            let mut any = vec![
                format!("instr({FOLD_FN}(image.original_name), {needle}) > 0"),
                format!("instr({FOLD_FN}(coalesce(image.note_manual, '')), {needle}) > 0"),
                format!(
                    "EXISTS (SELECT 1 FROM image_source s WHERE s.image_id = image.id \
                     AND (instr({FOLD_FN}(coalesce(s.note, '')), {needle}) > 0                      OR (s.source <> 'file' AND instr({FOLD_FN}(s.location), {needle}) > 0)))"
                ),
            ];
            any.extend(has_any_tag(
                tags.iter()
                    .map(|t| t.id.as_str())
                    .chain(similar.iter().map(|s| s.tag.id.as_str())),
                args,
            ));
            format!("({})", any.join(" OR "))
        }
    }
}
