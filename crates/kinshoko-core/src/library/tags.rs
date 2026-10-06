//! 标签与人工标签决定（#51，ADR-0003）。
//!
//! - 标签以库内稳定的 id 为身份，命名空间是身份的一部分；名称按语言保存，另有别名与外部对应。
//! - 写入按来源分层：每条标签事实标明来源（[`FactSource`]），某个来源重写时只替换自己那一层，
//!   不碰其他来源，也不碰人工标签决定。
//! - 有效标签：未解决的标签决定冲突保留“添加” > 人工标签决定 > 各来源事实的并集
//!   （迁移 0051 中的视图 `effective_tag`，查找与计数都以它为准）。
//! - 外部名称首次进库时由翻译表（[`TagTranslations`]）给出各语言的初始名称与别名；
//!   没有翻译的照常进库，显示外部名称并标明尚未翻译。之后名称属于画师的整理数据，
//!   翻译表更新不改动已有标签。
//!
//! 编辑入口 [`super::Library::edit_tags`] 只管标签决定；#50 的 `edit(ids, edits)`
//! 可以把 [`TagEdit`] 包成其中一种编辑。

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::events::LibraryEvent;
use super::{Error, Inner, LIVE, lens, now_ms};
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
    fn as_str(self) -> &'static str {
        match self {
            TagNamespace::General => "general",
            TagNamespace::Artist => "artist",
            TagNamespace::Character => "character",
            TagNamespace::Work => "work",
        }
    }

    fn parse(s: &str) -> rusqlite::Result<TagNamespace> {
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
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

/// 随软件分发的翻译表。只在标签首次进库时使用。
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct TagTranslations {
    pub entries: Vec<TagTranslation>,
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
    /// 只有外部名称、还没有任何语言的名称（界面显示“文A”）。
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TagCount {
    pub tag: TagLabel,
    pub count: u32,
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

// ---------------------------------------------------------------- 写入

/// 在写线程上执行一个标签写入事务：词表修订号加一，提交后推送事件。
fn write<T: Send + 'static>(
    inner: &Inner,
    changed_images: Vec<String>,
    f: impl FnOnce(&Transaction, &TranslationIndex) -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    let translations = inner.translations();
    let (value, revision) = inner.writer.run(move |conn| {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let value = f(&tx, &translations)?;
        let revision = bump_revision(&tx)?;
        tx.commit()?;
        Ok::<_, Error>((value, revision))
    })?;
    let library_id = inner.info.id.clone();
    if !changed_images.is_empty() {
        inner.hub.publish(LibraryEvent::ImagesChanged {
            library_id: library_id.clone(),
            image_ids: changed_images,
        });
    }
    inner.hub.publish(LibraryEvent::VocabularyChanged {
        library_id,
        revision,
    });
    Ok(value)
}

/// 词表修订号加一，返回新值。词表内容或计数变化的写入事务里调用。
pub(super) fn bump_revision(tx: &Transaction) -> Result<i64, Error> {
    Ok(tx.query_row(
        "UPDATE vocabulary_revision SET value = value + 1 RETURNING value",
        [],
        |r| r.get(0),
    )?)
}

fn require_image(tx: &Transaction, image_id: &str) -> Result<(), Error> {
    tx.query_row("SELECT 1 FROM image WHERE id = ?1", [image_id], |_| Ok(()))
        .optional()?
        .ok_or(Error::UnknownImage)
}

fn require_tag(tx: &Transaction, tag_id: &str) -> Result<TagNamespace, Error> {
    tx.query_row("SELECT namespace FROM tag WHERE id = ?1", [tag_id], |r| {
        TagNamespace::parse(&r.get::<_, String>(0)?)
    })
    .optional()?
    .ok_or(Error::UnknownTag)
}

fn clean(name: &str) -> Result<String, Error> {
    let name = name.trim();
    if name.is_empty() {
        Err(Error::InvalidTagName)
    } else {
        Ok(name.to_owned())
    }
}

fn new_tag(tx: &Transaction, namespace: TagNamespace) -> Result<String, Error> {
    let id = uuid::Uuid::now_v7().simple().to_string();
    tx.execute(
        "INSERT INTO tag (id, namespace, created_at) VALUES (?1, ?2, ?3)",
        params![id, namespace.as_str(), now_ms()],
    )?;
    Ok(id)
}

/// 命名空间内名称（任一语言）为 `name` 的标签；没有时看别名。
fn find_named(
    tx: &Transaction,
    namespace: TagNamespace,
    name: &str,
) -> Result<Option<String>, Error> {
    for sql in [
        "SELECT DISTINCT t.id FROM tag t JOIN tag_name n ON n.tag_id = t.id
         WHERE t.namespace = ?1 AND n.name = ?2",
        "SELECT DISTINCT t.id FROM tag t JOIN tag_alias a ON a.tag_id = t.id
         WHERE t.namespace = ?1 AND a.name = ?2",
    ] {
        let mut stmt = tx.prepare_cached(sql)?;
        let ids = stmt
            .query_map(params![namespace.as_str(), name], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        match ids.len() {
            0 => continue,
            1 => return Ok(ids.into_iter().next()),
            _ => return Err(Error::AmbiguousTag(name.to_owned())),
        }
    }
    Ok(None)
}

/// 找到或新建 `tag` 指向的标签。`create` 为假时找不到返回 `None`。
fn resolve(
    tx: &Transaction,
    translations: &TranslationIndex,
    tag: &TagRef,
    create: bool,
) -> Result<Option<String>, Error> {
    match tag {
        TagRef::Id { id } => {
            require_tag(tx, id)?;
            Ok(Some(id.clone()))
        }
        TagRef::Named {
            namespace,
            name,
            lang,
        } => {
            let name = clean(name)?;
            if let Some(id) = find_named(tx, *namespace, &name)? {
                return Ok(Some(id));
            }
            if !create {
                return Ok(None);
            }
            let id = new_tag(tx, *namespace)?;
            tx.execute(
                "INSERT INTO tag_name (tag_id, lang, name) VALUES (?1, ?2, ?3)",
                params![id, lang, name],
            )?;
            Ok(Some(id))
        }
        TagRef::External { namespace, name } => {
            let name = clean(name)?;
            let existing: Option<String> = tx
                .query_row(
                    "SELECT tag_id FROM tag_external WHERE name = ?1",
                    [&name],
                    |r| r.get(0),
                )
                .optional()?;
            if existing.is_some() || !create {
                return Ok(existing);
            }
            let translation = translations.get(&name);
            // 翻译后的名称已是本命名空间某个标签的名称：外部对应落在那个标签上。
            let mut id = None;
            if let Some(t) = translation {
                for translated in t.names.values() {
                    if let Some(found) = find_named(tx, *namespace, translated)? {
                        id = Some(found);
                        break;
                    }
                }
            }
            let id = match id {
                Some(id) => id,
                None => {
                    let id = new_tag(tx, *namespace)?;
                    if let Some(t) = translation {
                        for (lang, n) in &t.names {
                            tx.execute(
                                "INSERT INTO tag_name (tag_id, lang, name) VALUES (?1, ?2, ?3)",
                                params![id, lang, n],
                            )?;
                        }
                        for alias in &t.aliases {
                            tx.execute(
                                "INSERT OR IGNORE INTO tag_alias (tag_id, name, lang)
                                 VALUES (?1, ?2, ?3)",
                                params![id, alias.name, alias.lang],
                            )?;
                        }
                    }
                    id
                }
            };
            tx.execute(
                "INSERT INTO tag_external (name, tag_id) VALUES (?1, ?2)",
                params![name, id],
            )?;
            Ok(Some(id))
        }
    }
}

pub(super) fn edit_tags(
    inner: &Inner,
    image_ids: &[String],
    edits: &[TagEdit],
) -> Result<(), Error> {
    let ids = image_ids.to_vec();
    let edits = edits.to_vec();
    let lens = inner.lens_filter();
    write(inner, image_ids.to_vec(), move |tx, translations| {
        for id in &ids {
            lens::require_visible(tx, &lens, id)?;
        }
        let now = now_ms();
        for edit in &edits {
            let (tag, decision) = match edit {
                TagEdit::Add { tag } => (tag, Some("add")),
                TagEdit::Reject { tag } => (tag, Some("reject")),
                TagEdit::Clear { tag } => (tag, None),
            };
            let Some(tag_id) = resolve(tx, translations, tag, decision.is_some())? else {
                continue;
            };
            for image_id in &ids {
                match decision {
                    Some(decision) => tx.execute(
                        "INSERT INTO tag_decision (image_id, tag_id, decision, decided_at)
                         VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT (image_id, tag_id)
                         DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at",
                        params![image_id, tag_id, decision, now],
                    )?,
                    None => tx.execute(
                        "DELETE FROM tag_decision WHERE image_id = ?1 AND tag_id = ?2",
                        params![image_id, tag_id],
                    )?,
                };
            }
        }
        Ok(())
    })
}

pub(super) fn replace_source_tags(
    inner: &Inner,
    source: &FactSource,
    image_id: &str,
    tags: &[SourceTag],
) -> Result<(), Error> {
    let source = source.as_str().to_owned();
    let image_id = image_id.to_owned();
    let tags = tags.to_vec();
    write(inner, vec![image_id.clone()], move |tx, translations| {
        require_image(tx, &image_id)?;
        tx.execute(
            "DELETE FROM tag_fact WHERE image_id = ?1 AND source = ?2",
            params![image_id, source],
        )?;
        for t in &tags {
            let tag_id = resolve(tx, translations, &t.tag, true)?.ok_or(Error::UnknownTag)?;
            tx.execute(
                "INSERT INTO tag_fact (image_id, tag_id, source, score) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (image_id, tag_id, source)
                 DO UPDATE SET score = max(coalesce(score, excluded.score), coalesce(excluded.score, score))",
                params![image_id, tag_id, source, t.score],
            )?;
        }
        Ok(())
    })
}

pub(super) fn rename_tag(inner: &Inner, tag_id: &str, lang: &str, name: &str) -> Result<(), Error> {
    let (tag_id, lang, name) = (tag_id.to_owned(), lang.to_owned(), clean(name)?);
    write(inner, Vec::new(), move |tx, _| {
        let namespace = require_tag(tx, &tag_id)?;
        let taken: Option<String> = tx
            .query_row(
                "SELECT t.id FROM tag t JOIN tag_name n ON n.tag_id = t.id
                 WHERE t.namespace = ?1 AND n.lang = ?2 AND n.name = ?3 AND t.id <> ?4",
                params![namespace.as_str(), lang, name, tag_id],
                |r| r.get(0),
            )
            .optional()?;
        if taken.is_some() {
            return Err(Error::DuplicateTagName(name));
        }
        tx.execute(
            "INSERT INTO tag_name (tag_id, lang, name) VALUES (?1, ?2, ?3)
             ON CONFLICT (tag_id, lang) DO UPDATE SET name = excluded.name",
            params![tag_id, lang, name],
        )?;
        Ok(())
    })
}

pub(super) fn add_tag_alias(inner: &Inner, tag_id: &str, alias: &TagAlias) -> Result<(), Error> {
    let tag_id = tag_id.to_owned();
    let alias = TagAlias {
        name: clean(&alias.name)?,
        lang: alias.lang.clone(),
    };
    write(inner, Vec::new(), move |tx, _| {
        require_tag(tx, &tag_id)?;
        tx.execute(
            "INSERT INTO tag_alias (tag_id, name, lang) VALUES (?1, ?2, ?3)
             ON CONFLICT (tag_id, name) DO UPDATE SET lang = excluded.lang",
            params![tag_id, alias.name, alias.lang],
        )?;
        Ok(())
    })
}

pub(super) fn remove_tag_alias(inner: &Inner, tag_id: &str, alias: &str) -> Result<(), Error> {
    let (tag_id, alias) = (tag_id.to_owned(), alias.trim().to_owned());
    write(inner, Vec::new(), move |tx, _| {
        require_tag(tx, &tag_id)?;
        tx.execute(
            "DELETE FROM tag_alias WHERE tag_id = ?1 AND name = ?2",
            params![tag_id, alias],
        )?;
        Ok(())
    })
}

pub(super) fn add_tag_external(inner: &Inner, tag_id: &str, external: &str) -> Result<(), Error> {
    let (tag_id, external) = (tag_id.to_owned(), clean(external)?);
    write(inner, Vec::new(), move |tx, _| {
        require_tag(tx, &tag_id)?;
        let owner: Option<String> = tx
            .query_row(
                "SELECT tag_id FROM tag_external WHERE name = ?1",
                [&external],
                |r| r.get(0),
            )
            .optional()?;
        match owner {
            Some(owner) if owner == tag_id => Ok(()),
            Some(_) => Err(Error::ExternalTaken(external)),
            None => {
                tx.execute(
                    "INSERT INTO tag_external (name, tag_id) VALUES (?1, ?2)",
                    params![external, tag_id],
                )?;
                Ok(())
            }
        }
    })
}

pub(super) fn remove_tag_external(
    inner: &Inner,
    tag_id: &str,
    external: &str,
) -> Result<(), Error> {
    let (tag_id, external) = (tag_id.to_owned(), external.trim().to_owned());
    write(inner, Vec::new(), move |tx, _| {
        require_tag(tx, &tag_id)?;
        tx.execute(
            "DELETE FROM tag_external WHERE tag_id = ?1 AND name = ?2",
            params![tag_id, external],
        )?;
        Ok(())
    })
}

fn require_group(tx: &Transaction, group_id: &str) -> Result<Option<String>, Error> {
    tx.query_row(
        "SELECT namespace FROM tag_group WHERE id = ?1",
        [group_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()?
    .ok_or(Error::UnknownTagGroup)
}

pub(super) fn create_tag_group(
    inner: &Inner,
    name: &str,
    namespace: Option<TagNamespace>,
) -> Result<String, Error> {
    let name = clean(name)?;
    write(inner, Vec::new(), move |tx, _| {
        let id = uuid::Uuid::now_v7().simple().to_string();
        tx.execute(
            "INSERT INTO tag_group (id, name, namespace, ord, created_at)
             VALUES (?1, ?2, ?3, (SELECT coalesce(max(ord), -1) + 1 FROM tag_group), ?4)",
            params![id, name, namespace.map(TagNamespace::as_str), now_ms()],
        )?;
        Ok(id)
    })
}

pub(super) fn rename_tag_group(inner: &Inner, group_id: &str, name: &str) -> Result<(), Error> {
    let (group_id, name) = (group_id.to_owned(), clean(name)?);
    write(inner, Vec::new(), move |tx, _| {
        require_group(tx, &group_id)?;
        tx.execute(
            "UPDATE tag_group SET name = ?2 WHERE id = ?1",
            params![group_id, name],
        )?;
        Ok(())
    })
}

pub(super) fn set_tag_group_tags(
    inner: &Inner,
    group_id: &str,
    tag_ids: &[String],
) -> Result<(), Error> {
    let (group_id, tag_ids) = (group_id.to_owned(), tag_ids.to_vec());
    write(inner, Vec::new(), move |tx, _| {
        if require_group(tx, &group_id)?.is_some() {
            return Err(Error::NamespaceGroup);
        }
        tx.execute(
            "DELETE FROM tag_group_member WHERE group_id = ?1",
            [&group_id],
        )?;
        for (ord, tag_id) in tag_ids.iter().enumerate() {
            require_tag(tx, tag_id)?;
            tx.execute(
                "INSERT OR IGNORE INTO tag_group_member (group_id, tag_id, ord) VALUES (?1, ?2, ?3)",
                params![group_id, tag_id, ord as i64],
            )?;
        }
        Ok(())
    })
}

pub(super) fn order_tag_groups(inner: &Inner, group_ids: &[String]) -> Result<(), Error> {
    let group_ids = group_ids.to_vec();
    write(inner, Vec::new(), move |tx, _| {
        for (ord, id) in group_ids.iter().enumerate() {
            require_group(tx, id)?;
            tx.execute(
                "UPDATE tag_group SET ord = ?2 WHERE id = ?1",
                params![id, ord as i64],
            )?;
        }
        Ok(())
    })
}

pub(super) fn delete_tag_group(inner: &Inner, group_id: &str) -> Result<(), Error> {
    let group_id = group_id.to_owned();
    write(inner, Vec::new(), move |tx, _| {
        require_group(tx, &group_id)?;
        tx.execute("DELETE FROM tag_group WHERE id = ?1", [&group_id])?;
        Ok(())
    })
}

// ---------------------------------------------------------------- 读取

struct TagRow {
    namespace: TagNamespace,
    names: Vec<LocalizedName>,
    external: Vec<String>,
}

/// 读取若干标签的命名空间、名称与外部对应。
fn load_tags(
    conn: &rusqlite::Connection,
    ids: impl IntoIterator<Item = String>,
) -> Result<HashMap<String, TagRow>, Error> {
    let mut out = HashMap::new();
    let mut tag = conn.prepare_cached("SELECT namespace FROM tag WHERE id = ?1")?;
    let mut names =
        conn.prepare_cached("SELECT lang, name FROM tag_name WHERE tag_id = ?1 ORDER BY lang")?;
    let mut external =
        conn.prepare_cached("SELECT name FROM tag_external WHERE tag_id = ?1 ORDER BY name")?;
    for id in ids {
        if out.contains_key(&id) {
            continue;
        }
        let namespace = tag.query_row([&id], |r| TagNamespace::parse(&r.get::<_, String>(0)?))?;
        let names = names
            .query_map([&id], |r| {
                Ok(LocalizedName {
                    lang: r.get(0)?,
                    name: r.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let external = external
            .query_map([&id], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        out.insert(
            id,
            TagRow {
                namespace,
                names,
                external,
            },
        );
    }
    Ok(out)
}

/// 主语言子标签，例如 `zh-CN` → `zh`。
fn primary(lang: &str) -> &str {
    lang.split(['-', '_']).next().unwrap_or(lang)
}

/// 按界面语言选择显示名：界面语言 → 同一主语言 → 其他语言 → 外部名称（尚未翻译）。
fn label(id: &str, row: &TagRow, lang: &str) -> TagLabel {
    display_label(id, row.namespace, &row.names, &row.external, lang)
}

/// 同 [`label`]，供 Search 按词表快照显示标签。
pub(crate) fn display_label(
    id: &str,
    namespace: TagNamespace,
    names: &[LocalizedName],
    external: &[String],
    lang: &str,
) -> TagLabel {
    let pick = names
        .iter()
        .find(|n| n.lang.eq_ignore_ascii_case(lang))
        .or_else(|| {
            names
                .iter()
                .find(|n| primary(&n.lang).eq_ignore_ascii_case(primary(lang)))
        })
        .or_else(|| names.first());
    let (name, untranslated) = match pick {
        Some(n) => (n.name.clone(), false),
        None => (
            external
                .first()
                .map(|e| e.replace('_', " "))
                .unwrap_or_else(|| id.to_owned()),
            true,
        ),
    };
    TagLabel {
        id: id.to_owned(),
        namespace,
        name,
        untranslated,
        has_external: !external.is_empty(),
    }
}

fn sort_labels(labels: &mut [TagLabel]) {
    labels.sort_by(|a, b| (a.namespace, &a.name, &a.id).cmp(&(b.namespace, &b.name, &b.id)));
}

pub(super) fn image_tags(inner: &Inner, image_id: &str, lang: &str) -> Result<ImageTags, Error> {
    let conn = inner.readers.get();
    inner.require_visible(&conn, image_id)?;

    let mut origins: BTreeMap<String, Vec<TagOrigin>> = BTreeMap::new();
    let mut facts = conn.prepare_cached(
        "SELECT tag_id, source, score FROM tag_fact WHERE image_id = ?1 ORDER BY source",
    )?;
    for row in facts.query_map([image_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<f64>>(2)?,
        ))
    })? {
        let (tag_id, source, score) = row?;
        origins.entry(tag_id).or_default().push(TagOrigin::Source {
            source,
            score: score.map(|s| s as f32),
        });
    }
    let mut rejected = Vec::new();
    let mut decisions =
        conn.prepare_cached("SELECT tag_id, decision FROM tag_decision WHERE image_id = ?1")?;
    for row in decisions.query_map([image_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (tag_id, decision) = row?;
        match decision.as_str() {
            "add" => origins.entry(tag_id).or_default().push(TagOrigin::Manual),
            "conflict" => origins.entry(tag_id).or_default().push(TagOrigin::Conflict),
            _ => {
                origins.remove(&tag_id);
                rejected.push(tag_id);
            }
        }
    }
    let rows = load_tags(
        &conn,
        origins.keys().cloned().chain(rejected.iter().cloned()),
    )?;
    let mut tags: Vec<ImageTag> = origins
        .into_iter()
        .map(|(id, origins)| ImageTag {
            tag: label(&id, &rows[&id], lang),
            origins,
        })
        .collect();
    tags.sort_by(|a, b| {
        (a.tag.namespace, &a.tag.name, &a.tag.id).cmp(&(b.tag.namespace, &b.tag.name, &b.tag.id))
    });
    let mut rejected: Vec<TagLabel> = rejected
        .iter()
        .map(|id| label(id, &rows[id], lang))
        .collect();
    sort_labels(&mut rejected);
    Ok(ImageTags {
        image_id: image_id.to_owned(),
        tags,
        rejected,
    })
}

/// 每个标签的有效张数，只算浏览视角下可见的图（不含回收站与被封印的图）。
fn counts(inner: &Inner, conn: &rusqlite::Connection) -> Result<HashMap<String, u32>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT e.tag_id, COUNT(*) FROM effective_tag e
         JOIN image ON image.id = e.image_id WHERE {LIVE} AND {} GROUP BY e.tag_id",
        inner.lens_filter()
    ))?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub(super) fn vocabulary(inner: &Inner) -> Result<Vocabulary, Error> {
    let mut conn = inner.readers.get();
    // 修订号与内容取自同一个读事务，保证快照一致。
    let tx = conn.transaction()?;
    let revision: i64 = tx.query_row("SELECT value FROM vocabulary_revision", [], |r| r.get(0))?;
    let counts = counts(inner, &tx)?;
    let hidden = inner.sealed_only_tags(&tx)?;
    let mut tags: BTreeMap<String, VocabularyTag> = BTreeMap::new();
    {
        let mut stmt = tx.prepare("SELECT id, namespace FROM tag")?;
        for row in stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                TagNamespace::parse(&r.get::<_, String>(1)?)?,
            ))
        })? {
            let (id, namespace) = row?;
            if hidden.contains(&id) {
                continue;
            }
            tags.insert(
                id.clone(),
                VocabularyTag {
                    count: counts.get(&id).copied().unwrap_or(0),
                    id,
                    namespace,
                    names: Vec::new(),
                    aliases: Vec::new(),
                    external: Vec::new(),
                },
            );
        }
        let mut stmt = tx.prepare("SELECT tag_id, lang, name FROM tag_name ORDER BY lang")?;
        for row in stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get(2)?))
        })? {
            let (id, lang, name) = row?;
            if let Some(t) = tags.get_mut(&id) {
                t.names.push(LocalizedName { lang, name });
            }
        }
        let mut stmt = tx.prepare("SELECT tag_id, name, lang FROM tag_alias ORDER BY name")?;
        for row in stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get(2)?))
        })? {
            let (id, name, lang) = row?;
            if let Some(t) = tags.get_mut(&id) {
                t.aliases.push(TagAlias { name, lang });
            }
        }
        let mut stmt = tx.prepare("SELECT tag_id, name FROM tag_external ORDER BY name")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get(1)?)))? {
            let (id, name) = row?;
            if let Some(t) = tags.get_mut(&id) {
                t.external.push(name);
            }
        }
    }
    let mut personal_approx = read_personal_approx(&tx)?;
    personal_approx.retain(|e| !hidden.contains(&e.a) && !hidden.contains(&e.b));
    tx.finish()?;
    Ok(Vocabulary {
        revision,
        tags: tags.into_values().collect(),
        personal_approx,
    })
}

pub(super) fn tag_groups(inner: &Inner, lang: &str) -> Result<Vec<TagGroupView>, Error> {
    let conn = inner.readers.get();
    let counts = counts(inner, &conn)?;
    let hidden = inner.sealed_only_tags(&conn)?;
    let mut stmt =
        conn.prepare_cached("SELECT id, name, namespace FROM tag_group ORDER BY ord, created_at")?;
    let groups = stmt
        .query_map([], |r| {
            let namespace: Option<String> = r.get(2)?;
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                namespace.as_deref().map(TagNamespace::parse).transpose()?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut members = conn
        .prepare_cached("SELECT tag_id FROM tag_group_member WHERE group_id = ?1 ORDER BY ord")?;
    let mut in_namespace = conn.prepare_cached("SELECT id FROM tag WHERE namespace = ?1")?;
    let mut out = Vec::new();
    for (id, name, namespace) in groups {
        let mut tag_ids = match namespace {
            Some(ns) => in_namespace
                .query_map([ns.as_str()], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?,
            None => members
                .query_map([&id], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?,
        };
        tag_ids.retain(|t| !hidden.contains(t));
        let rows = load_tags(&conn, tag_ids.iter().cloned())?;
        let mut tags: Vec<TagCount> = tag_ids
            .iter()
            .map(|t| TagCount {
                tag: label(t, &rows[t], lang),
                count: counts.get(t).copied().unwrap_or(0),
            })
            .collect();
        // 命名空间分组按名称排序；画师整理的分组保持画师给出的顺序。
        if namespace.is_some() {
            tags.sort_by(|a, b| (&a.tag.name, &a.tag.id).cmp(&(&b.tag.name, &b.tag.id)));
        }
        out.push(TagGroupView {
            id,
            name,
            namespace,
            tags,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------- 个人近似对应表

fn relation_str(relation: ApproxRelation) -> &'static str {
    match relation {
        ApproxRelation::Similar => "similar",
        ApproxRelation::NotSimilar => "notSimilar",
    }
}

fn parse_relation(s: &str) -> rusqlite::Result<ApproxRelation> {
    match s {
        "similar" => Ok(ApproxRelation::Similar),
        "notSimilar" => Ok(ApproxRelation::NotSimilar),
        other => Err(rusqlite::Error::InvalidColumnType(
            2,
            format!("未知的近似判断 {other}"),
            rusqlite::types::Type::Text,
        )),
    }
}

/// 删掉 `a`、`b` 这一对两种顺序的记录。
fn delete_pair(tx: &Transaction, a: &str, b: &str) -> Result<(), Error> {
    tx.execute(
        "DELETE FROM personal_approx
         WHERE (tag_a = ?1 AND tag_b = ?2) OR (tag_a = ?2 AND tag_b = ?1)",
        params![a, b],
    )?;
    Ok(())
}

pub(super) fn set_tag_approx(
    inner: &Inner,
    a: &str,
    b: &str,
    relation: ApproxRelation,
) -> Result<(), Error> {
    if a == b {
        return Err(Error::SameTag);
    }
    let (a, b) = (a.to_owned(), b.to_owned());
    write(inner, Vec::new(), move |tx, _| {
        require_tag(tx, &a)?;
        require_tag(tx, &b)?;
        delete_pair(tx, &a, &b)?;
        tx.execute(
            "INSERT INTO personal_approx (tag_a, tag_b, relation, decided_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![a, b, relation_str(relation), now_ms()],
        )?;
        Ok(())
    })
}

pub(super) fn remove_tag_approx(inner: &Inner, a: &str, b: &str) -> Result<(), Error> {
    let (a, b) = (a.to_owned(), b.to_owned());
    write(inner, Vec::new(), move |tx, _| delete_pair(tx, &a, &b))
}

/// 个人近似对应表的全部条目，最近记下的在前。
fn read_personal_approx(conn: &rusqlite::Connection) -> Result<Vec<PersonalApprox>, Error> {
    let mut stmt = conn.prepare_cached(
        "SELECT tag_a, tag_b, relation FROM personal_approx
         ORDER BY decided_at DESC, rowid DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(PersonalApprox {
            a: r.get(0)?,
            b: r.get(1)?,
            relation: parse_relation(&r.get::<_, String>(2)?)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub(super) fn personal_approx(
    inner: &Inner,
    lang: &str,
) -> Result<Vec<PersonalApproxEntry>, Error> {
    let conn = inner.readers.get();
    let mut entries = read_personal_approx(&conn)?;
    // 浏览视角：只出现在被封印的图上的标签不露出名称。
    let hidden = inner.sealed_only_tags(&conn)?;
    entries.retain(|e| !hidden.contains(&e.a) && !hidden.contains(&e.b));
    let rows = load_tags(
        &conn,
        entries.iter().flat_map(|e| [e.a.clone(), e.b.clone()]),
    )?;
    Ok(entries
        .into_iter()
        .map(|e| PersonalApproxEntry {
            a: label(&e.a, &rows[&e.a], lang),
            b: label(&e.b, &rows[&e.b], lang),
            relation: e.relation,
        })
        .collect())
}
