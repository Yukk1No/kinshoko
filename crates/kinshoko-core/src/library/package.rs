//! 参考组包（#68）用到的资料库接口。
//!
//! - 导出：[`ReferenceLens::snapshot`] 给出所用参考图在导出时的整理信息快照（标签、备注、来源链接、
//!   内容分级），不论是否被封印。快照只是导出时的样子，不反向更新来源库。
//! - 导入：[`Library::import_from_package`](super::Library::import_from_package) 让包里的原图走
//!   普通导入的写入顺序（完整解码 → 同库暂存校验 → pending → 发布 → 短事务提交），同库已有字节
//!   相同的原图只合并来源。快照按 `package:<包 id>:<来源库 id>:<来源图 id>` 来源分层写入：只替换这一层，不碰人工标签决定、
//!   本库备注与人工分级；同一个包重复导入不重复建图。包本身记在 `package_import`。

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::Error;
use super::lens::ReferenceLens;
use super::rating::{self, ContentRating};
use super::tags::{self, FactSource, LocalizedName, TagNamespace};

/// 参考组包里一张参考图在导出时的整理信息快照。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageSnapshot {
    /// 原文件的 SHA-256（小写十六进制）。导入时逐字节核对。
    pub sha256: String,
    pub original_name: String,
    pub width: u32,
    pub height: u32,
    /// 收集时间（Unix 毫秒）。
    #[ts(type = "number")]
    pub collected_at: i64,
    /// 有效标签。
    pub tags: Vec<SnapshotTag>,
    /// 画师当时看到的备注（本库备注，没写时是来源备注）；没有备注时为空。
    pub note: Option<String>,
    pub source_links: Vec<String>,
    /// 有效内容分级；带着它，导入后被封印的图在安全模式下立即遮蔽，不等重新打标。
    pub rating: Option<ContentRating>,
}

/// 快照标签：新版按稳定定义对应，旧版保留名称与外部对应的兼容解释。默认名称不包含程序偏好。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SnapshotTag {
    /// Present in modern content packages. Legacy packages continue through their compatibility resolver.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub definition: Option<crate::portable_tags::PortableTagDefinition>,
    /// Only a source correspondence, never the identity on the destination library.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub local_tag_id: Option<String>,
    pub namespace: TagNamespace,
    pub names: Vec<LocalizedName>,
    pub external: Vec<String>,
}

/// 一次参考组包导入的来历（`imported_from_package`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageOrigin {
    pub package_id: String,
    /// 包内快照的来源身份；不同库的同字节原图仍有各自的整理信息。
    pub source_library_id: String,
    pub source_image_id: String,
    /// 导出它的参考组。
    pub group_id: String,
    pub group_name: String,
    pub exported_at: i64,
    /// 导入时包文件的位置。
    pub location: String,
}

impl ReferenceLens {
    /// 参考图此刻的整理信息快照（参考组包导出用），不论是否被封印；回收站里的图也能取得。
    pub fn snapshot(&self, image_id: &str) -> Result<ImageSnapshot, Error> {
        snapshot(&self.inner.readers.get(), image_id)
    }
}

fn snapshot(conn: &Connection, image_id: &str) -> Result<ImageSnapshot, Error> {
    let (sha256, original_name, width, height, collected_at, manual_note): (
        String,
        String,
        u32,
        u32,
        i64,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT sha256, original_name, width, height, coalesce(collected_at, imported_at),
                    note_manual
             FROM image WHERE id = ?1",
            [image_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .optional()?
        .ok_or(Error::UnknownImage)?;
    let note = match manual_note {
        // 画师清空了备注：当时看到的就是没有备注。
        Some(text) => Some(text).filter(|t| !t.is_empty()),
        None => {
            let mut stmt = conn.prepare_cached(
                "SELECT note FROM image_source WHERE image_id = ?1 AND note IS NOT NULL
                   AND note <> '' ORDER BY recorded_at, source, location",
            )?;
            let notes: Vec<String> = stmt
                .query_map([image_id], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            Some(notes.join("\n\n")).filter(|t| !t.is_empty())
        }
    };
    let mut stmt = conn.prepare_cached(
        "SELECT DISTINCT url FROM image_source WHERE image_id = ?1 AND url IS NOT NULL
           AND url <> '' ORDER BY url",
    )?;
    let source_links = stmt
        .query_map([image_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut stmt = conn.prepare_cached(
        "SELECT DISTINCT t.id, t.namespace FROM effective_tag e JOIN tag t ON t.id = e.tag_id
         WHERE e.image_id = ?1 ORDER BY t.id",
    )?;
    let ids: Vec<(String, String)> = stmt
        .query_map([image_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let mut names =
        conn.prepare_cached("SELECT lang, name FROM tag_name WHERE tag_id = ?1 ORDER BY lang")?;
    let mut external =
        conn.prepare_cached("SELECT name FROM tag_external WHERE tag_id = ?1 ORDER BY name")?;
    let library_id: String = conn.query_row("SELECT id FROM library", [], |r| r.get(0))?;
    let mut tags = Vec::new();
    for (id, namespace) in ids {
        let definition = conn
            .query_row(
                "SELECT definition FROM tag_definition_dependency WHERE local_tag_id=?1",
                [&id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|json| {
                serde_json::from_str::<crate::portable_tags::PortableTagDefinition>(&json)
                    .map_err(|e| Error::TagDefinitions(e.to_string()))
            })
            .transpose()?;
        let mut snapshot_tag = SnapshotTag {
            definition,
            local_tag_id: Some(id.clone()),
            namespace: TagNamespace::parse(&namespace)?,
            names: names
                .query_map([&id], |r| {
                    Ok(LocalizedName {
                        lang: r.get(0)?,
                        name: r.get(1)?,
                    })
                })?
                .collect::<Result<_, _>>()?,
            external: external
                .query_map([&id], |r| r.get(0))?
                .collect::<Result<_, _>>()?,
        };
        if snapshot_tag.definition.is_none() {
            let mut aliases =
                conn.prepare("SELECT name,lang FROM tag_alias WHERE tag_id=?1 ORDER BY name")?;
            snapshot_tag.definition = Some(crate::portable_tags::PortableTagDefinition {
                id: format!("legacy-{library_id}-{id}"),
                namespace: snapshot_tag.namespace,
                default_names: snapshot_tag.names.clone(),
                aliases: aliases
                    .query_map([&id], |r| {
                        Ok(super::TagAlias {
                            name: r.get(0)?,
                            lang: r.get(1)?,
                        })
                    })?
                    .collect::<Result<_, _>>()?,
                external: snapshot_tag
                    .external
                    .iter()
                    .map(|name| crate::tag_catalog::ExternalTagIdentity {
                        vocabulary: "danbooru".into(),
                        name: name.clone(),
                    })
                    .collect(),
            });
        }
        if let Some(definition) = &snapshot_tag.definition {
            snapshot_tag.names = definition.default_names.clone();
            snapshot_tag.external = definition
                .external
                .iter()
                .filter(|e| e.vocabulary == "danbooru")
                .map(|e| e.name.clone())
                .collect();
        }
        tags.push(snapshot_tag);
    }
    Ok(ImageSnapshot {
        sha256,
        original_name,
        width,
        height,
        collected_at,
        tags,
        note,
        source_links,
        rating: rating::rating_of(conn, image_id)?.effective,
    })
}

/// 包里一张图的来源层：随原图的提交事务写入。
pub(super) struct PackageFacts {
    pub(super) origin: PackageOrigin,
    pub(super) snapshot: ImageSnapshot,
}

/// 写入（或刷新）这张图的 `package:<包 id>:<来源库 id>:<来源图 id>` 来源层，仍处在原图的提交事务中；返回新的词表修订号。
pub(super) fn commit(
    tx: &Transaction,
    translations: &tags::TranslationIndex,
    facts: &PackageFacts,
    image_id: &str,
    now: i64,
) -> Result<i64, Error> {
    let (origin, snapshot) = (&facts.origin, &facts.snapshot);
    let source = FactSource::package_image(
        &origin.package_id,
        &origin.source_library_id,
        &origin.source_image_id,
    );
    tx.execute(
        "DELETE FROM image_source WHERE image_id = ?1 AND source = ?2",
        params![image_id, source.as_str()],
    )?;
    tx.execute(
        "INSERT INTO image_source (image_id, source, location, recorded_at, note)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            image_id,
            source.as_str(),
            origin.location,
            now,
            snapshot.note
        ],
    )?;
    for (n, url) in snapshot.source_links.iter().enumerate() {
        tx.execute(
            "INSERT OR IGNORE INTO image_source (image_id, source, location, recorded_at, url)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                image_id,
                source.as_str(),
                format!("{}#link{}", origin.location, n + 1),
                now,
                url
            ],
        )?;
    }
    tags::replace_snapshot_tags(tx, translations, &source, image_id, &snapshot.tags)?;
    tx.execute(
        "DELETE FROM rating_fact WHERE image_id = ?1 AND source = ?2",
        params![image_id, source.as_str()],
    )?;
    if let Some(rating) = snapshot.rating {
        tx.execute(
            "INSERT INTO rating_fact (image_id, source, rating, score) VALUES (?1, ?2, ?3, NULL)",
            params![image_id, source.as_str(), rating.as_str()],
        )?;
    }
    tx.execute(
        "INSERT INTO package_import (package_id, group_id, group_name, exported_at, location,
                                     imported_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (package_id) DO UPDATE SET location = excluded.location,
                                                imported_at = excluded.imported_at",
        params![
            origin.package_id,
            origin.group_id,
            origin.group_name,
            origin.exported_at,
            origin.location,
            now
        ],
    )?;
    tags::bump_revision(tx)
}
