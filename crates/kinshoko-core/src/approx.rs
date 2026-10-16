//! 近似对应表（#55、#56，ADR-0003）。
//!
//! - 内置近似对应表（[`BuiltinApproxTable`]）随软件分发，按外部对应写成，格式见
//!   `data/README.md`。相近关系无方向、不传递。
//! - 个人近似对应表（[`PersonalApprox`]）在应用中保存，按统一标签身份记录“相近”或“不相近”，
//!   与内置近似对应表冲突时以它为准；内置表更新不改动它。
//!
//! 两份表都只是 Search 的输入，展开在 [`crate::search::Search::resolve`] 中完成。

use std::collections::BTreeSet;
use std::fmt;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

const FORMAT: &str = "kinshoko.builtin-approx-table";
const FORMAT_VERSION: u32 = 1;
const BUNDLED: &str = include_str!("../../../data/builtin-approx-table.json");

/// 内置近似对应表：相近的外部名称对。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BuiltinApproxTable {
    table_version: u32,
    /// 每对按字母序存一次（小的在前）。
    pairs: BTreeSet<(String, String)>,
}

/// 内置近似对应表读不懂。
#[derive(Debug)]
pub enum ApproxTableError {
    Json(serde_json::Error),
    /// `format` 不是内置近似对应表。
    NotATable(String),
    /// 本版本不认识的 `format_version`。
    UnknownFormatVersion(u32),
}

impl fmt::Display for ApproxTableError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApproxTableError::Json(e) => write!(f, "内置近似对应表不是有效的 JSON：{e}"),
            ApproxTableError::NotATable(format) => {
                write!(f, "不是内置近似对应表（format 为 {format}）")
            }
            ApproxTableError::UnknownFormatVersion(v) => {
                write!(f, "不认识的内置近似对应表格式版本 {v}")
            }
        }
    }
}

impl std::error::Error for ApproxTableError {}

#[derive(Deserialize)]
struct TableFile {
    format: String,
    format_version: u32,
    table_version: u32,
    pairs: Vec<PairFile>,
}

#[derive(Deserialize)]
struct PairFile {
    a: String,
    b: String,
}

impl BuiltinApproxTable {
    /// 随软件分发的内置近似对应表（`data/builtin-approx-table.json`）。
    pub fn bundled() -> BuiltinApproxTable {
        BuiltinApproxTable::parse(BUNDLED).expect("随软件分发的内置近似对应表应能读取")
    }

    /// 读取内置近似对应表文件；先核对 `format` 与 `format_version`。
    pub fn parse(json: &str) -> Result<BuiltinApproxTable, ApproxTableError> {
        let file: TableFile = serde_json::from_str(json).map_err(ApproxTableError::Json)?;
        if file.format != FORMAT {
            return Err(ApproxTableError::NotATable(file.format));
        }
        if file.format_version != FORMAT_VERSION {
            return Err(ApproxTableError::UnknownFormatVersion(file.format_version));
        }
        Ok(BuiltinApproxTable::from_pairs(
            file.table_version,
            file.pairs.iter().map(|p| (p.a.as_str(), p.b.as_str())),
        ))
    }

    /// 由外部名称对直接构造，顺序与重复不影响结果。
    pub fn from_pairs<'a>(
        table_version: u32,
        pairs: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> BuiltinApproxTable {
        BuiltinApproxTable {
            table_version,
            pairs: pairs
                .into_iter()
                .filter(|(a, b)| a != b)
                .map(|(a, b)| ordered(a.to_owned(), b.to_owned()))
                .collect(),
        }
    }

    /// 表内容的版本。
    pub fn table_version(&self) -> u32 {
        self.table_version
    }

    /// 相近的外部名称对数。
    pub fn len(&self) -> usize {
        self.pairs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pairs.is_empty()
    }

    /// 全部相近的外部名称对。
    pub fn pairs(&self) -> impl Iterator<Item = (&str, &str)> {
        self.pairs.iter().map(|(a, b)| (a.as_str(), b.as_str()))
    }
}

/// 个人近似对应表中一条记录的判断。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ApproxRelation {
    /// 相近：查其中一个时展开另一个。
    Similar,
    /// 不相近：压过内置近似对应表中的同一对。
    NotSimilar,
}

/// 个人近似对应表中的一条：两个标签身份（无方向）与画师的判断。旧 Library 接口仍使用本地 ID；应用规则使用统一 ID。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PersonalApprox {
    pub a: String,
    pub b: String,
    pub relation: ApproxRelation,
}

/// 一个展开出来的相近标签来自哪份近似对应表。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ApproxSource {
    /// 内置近似对应表。
    Builtin,
    /// 个人近似对应表。
    Personal,
}

/// 无方向的一对按字典序排好，作为键。
pub(crate) fn ordered(a: String, b: String) -> (String, String) {
    if a <= b { (a, b) } else { (b, a) }
}
