//! 标签与人工标签决定（#51，ADR-0003）。
//!
//! - 标签以库内稳定的 id 为身份，命名空间是身份的一部分；名称按语言保存，另有别名与外部对应。
//! - 写入按来源分层：每条标签事实标明来源（[`FactSource`]），某个来源重写时只替换自己那一层，
//!   不碰其他来源，也不碰人工标签决定。
//! - 有效标签：未解决的标签决定冲突保留“添加” > 人工标签决定 > 各来源事实的并集
//!   （迁移 0051 中的视图 `effective_tag`，查找与计数都以它为准）。
//! - 外部名称首次进库时由翻译表（[`TagTranslations`]）给出各语言的初始名称与别名；
//!   没有翻译的照常进库，显示外部名称并标明尚未翻译。之后名称属于画师的整理数据，
//!   翻译表更新不改动已有名称、别名与人工标签决定；只有仍尚未翻译（没有任何名称）的标签
//!   在装上新表时做首次初始化。随软件分发的表见 [`TagTranslations::bundled`]。
//!
//! 编辑入口 [`super::Library::edit_tags`] 只管标签决定；#50 的 `edit(ids, edits)`
//! 可以把 [`TagEdit`] 包成其中一种编辑。

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::events::LibraryEvent;
use super::{Error, Inner, LIVE, SafeMode, SafeModeScope, lens, now_ms, rating};
use crate::approx::{ApproxRelation, PersonalApprox};

/// 标签命名空间。名称相同、命名空间不同的是两个标签。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TagNamespace {
    /// 一般标签（不带命名空间）。
    General,
    /// 作者。
    Artist,
    /// 角色。
    Character,
    /// 作品。
    Work,
}

impl TagNamespace {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            TagNamespace::General => "general",
            TagNamespace::Artist => "artist",
            TagNamespace::Character => "character",
            TagNamespace::Work => "work",
        }
    }

    pub(super) fn parse(s: &str) -> rusqlite::Result<TagNamespace> {
        Ok(match s {
            "general" => TagNamespace::General,
            "artist" => TagNamespace::Artist,
            "character" => TagNamespace::Character,
            "work" => TagNamespace::Work,
            other => {
                return Err(rusqlite::Error::InvalidColumnType(
                    0,
                    format!("未知的标签命名空间 {other}"),
                    rusqlite::types::Type::Text,
                ));
            }
        })
    }
}

/// 标签事实的来源，也是按来源分层写入时的“层”。同一来源重写只替换这一层。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FactSource(String);

impl FactSource {
    /// 普通文件导入。
    pub fn file() -> FactSource {
        FactSource("file".into())
    }

    /// 某次登记的 Eagle 资料库（导入来源 id）。
    pub fn eagle(source_id: &str) -> FactSource {
        FactSource(format!("eagle:{source_id}"))
    }

    /// 打标模型。同一模型重新打标替换该层；是否按版本分层由调用方决定写进 `model`。
    pub fn model(model: &str) -> FactSource {
        FactSource(format!("model:{model}"))
    }

    /// 参考组包。
    pub fn package(package_id: &str) -> FactSource {
        FactSource(format!("package:{package_id}"))
    }

    /// 包内每个来源快照各占一层，同字节去重不合并整理信息的身份。
    pub fn package_image(package_id: &str, library_id: &str, image_id: &str) -> FactSource {
        FactSource(format!("package:{package_id}:{library_id}:{image_id}"))
    }

    /// 订阅收进来的作品（#368），例如 `pixiv:12345`。同一作品的各页共用一层。
    pub fn subscription(source: &str, work_id: &str) -> FactSource {
        FactSource(format!("{source}:{work_id}"))
    }

    /// 从备份恢复。
    pub fn restore() -> FactSource {
        FactSource("restore".into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// 指向一个标签的方式。按名称或外部名称指向时，资料库中没有就新建。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum TagRef {
    /// 已有标签。
    Id { id: String },
    /// 命名空间内的名称或别名（任一语言）。新建时以 `lang` 记下这个名称。
    Named {
        namespace: TagNamespace,
        name: String,
        lang: String,
    },
    /// 外部词表中的名称，例如打标模型输出的 `blue_eyes`。
    External {
        namespace: TagNamespace,
        name: String,
    },
}

/// 对参考图的一项标签编辑。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum TagEdit {
    /// 人工添加。
    Add { tag: TagRef },
    /// 人工否决：来源事实中有这个标签也不算有效。
    Reject { tag: TagRef },
    /// 清除人工标签决定，回到来源事实决定的状态。
    Clear { tag: TagRef },
}

/// 来源提供的一条标签事实。
#[derive(Debug, Clone, PartialEq)]
pub struct SourceTag {
    pub tag: TagRef,
    /// 模型给出的分数；导入来源没有分数。
    pub score: Option<f32>,
}

/// 标签别名。`lang` 为空表示不区分语言。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TagAlias {
    pub name: String,
    #[serde(default)]
    pub lang: Option<String>,
}

/// 某种语言的标签名。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocalizedName {
    pub lang: String,
    pub name: String,
}

/// 翻译表中的一项：外部名称首次进库时的各语言初始名称与别名。
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct TagTranslation {
    pub external: String,
    /// 语言 → 名称。
    pub names: BTreeMap<String, String>,
    #[serde(default)]
    pub aliases: Vec<TagAlias>,
}

/// 翻译表。只给标签做首次初始化：外部名称首次进库时，或表装上时仍尚未翻译的标签。
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct TagTranslations {
    pub entries: Vec<TagTranslation>,
}

const BUNDLED_FORMAT: &str = "kinshoko.builtin-translation-table";
const BUNDLED_FORMAT_VERSION: u32 = 1;
const BUNDLED: &str = include_str!("../../data/builtin-translation-table.json");

/// `data/builtin-translation-table.json` 的文件结构（格式见 `data/README.md`）。
#[derive(Deserialize)]
struct BundledFile {
    format: String,
    format_version: u32,
    table_version: u32,
    entries: Vec<TagTranslation>,
}

fn bundled_file() -> BundledFile {
    let file: BundledFile =
        serde_json::from_str(BUNDLED).expect("随软件分发的翻译表应是有效的 JSON");
    assert_eq!(file.format, BUNDLED_FORMAT, "不是内置翻译表");
    assert_eq!(
        file.format_version, BUNDLED_FORMAT_VERSION,
        "不认识的内置翻译表格式版本"
    );
    file
}

impl TagTranslations {
    /// 随软件分发的内置翻译表（`data/builtin-translation-table.json`，由
    /// `tools/translation-table` 生成）：PixAI v1.0 词表中最常见的一般标签的简体中文名称与别名。
    pub fn bundled() -> TagTranslations {
        TagTranslations {
            entries: bundled_file().entries,
        }
    }

    /// 内置翻译表的表版本（内容变化时加一）。
    pub fn bundled_version() -> u32 {
        bundled_file().table_version
    }
}

pub(super) type TranslationIndex = HashMap<String, TagTranslation>;

pub(super) fn index(table: TagTranslations) -> Arc<TranslationIndex> {
    Arc::new(
        table
            .entries
            .into_iter()
            .map(|e| (e.external.clone(), e))
            .collect(),
    )
}

/// 按界面语言显示的标签。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TagLabel {
    pub id: String,
    pub namespace: TagNamespace,
    /// 界面语言的名称；没有时用其他语言的名称；都没有时是外部名称（下划线换成空格）。
    pub name: String,
    /// 只有外部名称、还没有任何语言的名称（界面在名称后显示翻译图标，#160）。
    pub untranslated: bool,
    /// 有外部对应，参与内置近似对应表。
    pub has_external: bool,
}

/// 有效标签的一个出处。
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum TagOrigin {
    /// 某个来源的事实（导入、模型带分数等）。
    Source { source: String, score: Option<f32> },
    /// 人工添加。
    Manual,
    /// 合并资料库时未解决的标签决定冲突，暂按添加处理。
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageTag {
    pub tag: TagLabel,
    pub origins: Vec<TagOrigin>,
}

/// 一张参考图的标签：有效标签及其出处，以及被否决的标签。
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageTags {
    pub image_id: String,
    pub tags: Vec<ImageTag>,
    pub rejected: Vec<TagLabel>,
}

/// 词表中的一个标签。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VocabularyTag {
    pub id: String,
    pub namespace: TagNamespace,
    pub names: Vec<LocalizedName>,
    pub aliases: Vec<TagAlias>,
    pub external: Vec<String>,
    /// 有这个有效标签的参考图张数。
    pub count: u32,
    /// 本库的来源名称（#217），单库内优先于 `names` 显示；`und` 为未注明语言。
    #[serde(default)]
    #[ts(as = "Option<Vec<LocalizedName>>", optional)]
    pub source_names: Vec<LocalizedName>,
}

/// 资料库设置中列出的一条个人近似对应表条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PersonalApproxEntry {
    pub a: TagLabel,
    pub b: TagLabel,
    pub relation: ApproxRelation,
}

/// 标签词表快照，供 Search 使用；按 `revision` 缓存。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Vocabulary {
    #[ts(type = "number")]
    pub revision: i64,
    pub tags: Vec<VocabularyTag>,
    /// 个人近似对应表的全部条目。
    pub personal_approx: Vec<crate::approx::PersonalApprox>,
    /// 快照所用的浏览视角是否开着安全模式：开着时安全模式范围内的分级也查不到（#161）。
    pub safe_mode: bool,
    /// 快照所用的安全模式范围（#223）：决定“R18”代表哪几档，以及开着安全模式时哪些分级查不到。
    /// 只给核心的 Search 用，界面不需要。
    #[ts(skip)]
    pub safe_mode_scope: SafeModeScope,
}

impl Vocabulary {
    /// 快照所用的浏览视角。
    pub fn safe(&self) -> SafeMode {
        SafeMode::new(self.safe_mode, self.safe_mode_scope)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TagCount {
    pub tag: TagLabel,
    pub count: u32,
}

/// Durable legacy configuration, without image labels or visible counts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TagGroupDefinition {
    pub id: String,
    pub name: String,
    pub namespace: Option<TagNamespace>,
    /// Local identities, in the artist's chosen order. Namespace groups are dynamic.
    pub members: Vec<String>,
}

/// 侧栏上的一个标签分组。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TagGroupView {
    pub id: String,
    pub name: String,
    /// 不为空时，分组是这个命名空间中的全部标签。
    pub namespace: Option<TagNamespace>,
    pub tags: Vec<TagCount>,
}

mod approx;
mod groups;
mod names;
mod read;
mod write;

pub(super) use approx::*;
pub(super) use groups::*;
pub(super) use names::*;
pub(crate) use read::display_label;
pub(super) use read::*;
pub(super) use write::*;
