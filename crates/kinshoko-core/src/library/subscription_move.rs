//! 订阅改了收进的资料库以后，把旧库里收的图移到新库（#461）。
//!
//! - 只移画师没动过的图：不在回收站，不在文件夹里，没被参考组用到，没有人工标签决定、本库备注
//!   与人工分级，来源也只有这条订阅的这些作品。别的都留在原处（“人工整理优先”）。
//! - 移 = 原图按订阅收进的写入顺序进新库（来源层照旧重建，打标与颜色在新库重新生成），旧库里的
//!   那张移进回收站。撤销反过来：旧库的恢复，新库去掉这一层来源；新库的图是这次移过来才有的、
//!   去掉后没有别的来源时移进回收站。
//! - 不经浏览视角：安全模式下被封印的图照样移。

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};

use super::edit::{ImageEdit, edit_in};
use super::tags::{self, FactSource};
use super::{Error, Library, LibraryEvent, SubscriptionPage};
use crate::reference_groups::ReferenceGroupUsage;

/// 一张订阅收进来的图里的一页作品：哪个来源的哪个作品的第几页。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ReceivedPageRef {
    pub source: String,
    pub work_id: String,
    pub page: u32,
}

/// 能移的一张图：原图的 SHA-256 与在新库重建来源层要用的各页。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MovableImage {
    pub image_id: String,
    pub sha256: String,
    pub pages: Vec<SubscriptionPage>,
}

impl MovableImage {
    /// 这张图在资料库里的来源层，每个作品一层。
    pub fn layers(&self) -> Vec<FactSource> {
        let mut seen = HashSet::new();
        self.pages
            .iter()
            .map(|p| FactSource::subscription(&p.source, &p.work_id))
            .filter(|s| seen.insert(s.clone()))
            .collect()
    }
}

impl Library {
    /// `image_id` 能不能移走：能时给出要带走的东西，留在原处时为空。`pages` 是订阅记录里指向
    /// 这张图的各页。
    pub fn movable_image(
        &self,
        image_id: &str,
        pages: &[ReceivedPageRef],
        usage: &dyn ReferenceGroupUsage,
    ) -> Result<Option<MovableImage>, Error> {
        let found = {
            let conn = self.inner.readers.get();
            read_movable(&conn, image_id, pages)?
        };
        let Some(found) = found else {
            return Ok(None);
        };
        let used = usage
            .groups_using(&self.inner.info.id, &[image_id.to_owned()])
            .map_err(Error::reference_groups)?;
        Ok(used.is_empty().then_some(found))
    }

    /// 把从别的库移来的图收进本库；返回本库的图 id，以及这张图是不是这次才进本库。本库已有
    /// 字节相同的图时只合并来源；它在回收站里就恢复。
    pub fn receive_moved(
        &self,
        image: &MovableImage,
        bytes: &[u8],
    ) -> Result<(String, bool), Error> {
        let existing: Option<(String, Option<i64>)> = self
            .inner
            .readers
            .get()
            .query_row(
                "SELECT id, deleted_at FROM image WHERE sha256 = ?1",
                [&image.sha256],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let mut id = None;
        for page in &image.pages {
            id = Some(self.import_from_subscription(page.clone(), bytes)?);
        }
        let id = id.ok_or(Error::UnknownImage)?;
        if let Some((_, Some(_))) = existing {
            edit_in(
                &self.inner,
                std::slice::from_ref(&id),
                &[ImageEdit::Restore],
                true,
            )?;
        }
        Ok((id, existing.is_none()))
    }

    /// 要移走的图的原文件位置，不经浏览视角。
    pub fn moved_original(&self, image_id: &str) -> Result<std::path::PathBuf, Error> {
        self.inner.original_path(image_id)
    }

    /// 移进回收站，不经浏览视角。
    pub fn trash_moved(&self, ids: &[String]) -> Result<(), Error> {
        edit_in(&self.inner, ids, &[ImageEdit::Delete], true).map(drop)
    }

    /// 从回收站恢复，不经浏览视角。
    pub fn restore_moved(&self, ids: &[String]) -> Result<(), Error> {
        edit_in(&self.inner, ids, &[ImageEdit::Restore], true).map(drop)
    }

    /// 撤销移进本库：去掉 `layers` 这几层来源；`created` 且去掉后没有别的来源时移进回收站。
    pub fn undo_receive_moved(
        &self,
        image_id: &str,
        layers: &[FactSource],
        created: bool,
    ) -> Result<(), Error> {
        let id = image_id.to_owned();
        let layers: Vec<String> = layers.iter().map(|l| l.as_str().to_owned()).collect();
        let revision = self.inner.write(move |tx| {
            for layer in &layers {
                tx.execute(
                    "DELETE FROM image_source WHERE image_id = ?1 AND source = ?2",
                    params![id, layer],
                )?;
                tx.execute(
                    "DELETE FROM tag_fact WHERE image_id = ?1 AND source = ?2",
                    params![id, layer],
                )?;
                tx.execute(
                    "DELETE FROM rating_fact WHERE image_id = ?1 AND source = ?2",
                    params![id, layer],
                )?;
            }
            tags::bump_revision(tx)
        })?;
        let library_id = self.inner.info.id.clone();
        self.inner.hub.publish(LibraryEvent::ImagesChanged {
            library_id: library_id.clone(),
            image_ids: vec![image_id.to_owned()],
        });
        self.inner.hub.publish(LibraryEvent::VocabularyChanged {
            library_id,
            revision,
        });
        let bare = self.inner.readers.get().query_row(
            "SELECT NOT EXISTS (SELECT 1 FROM image_source WHERE image_id = ?1)",
            [image_id],
            |row| row.get::<_, bool>(0),
        )?;
        if created && bare {
            self.trash_moved(&[image_id.to_owned()])?;
        }
        Ok(())
    }
}

/// 原图 SHA-256、进回收站的时间、本库备注、人工分级、原文件名、收集时间。
type ImageRow = (
    String,
    Option<i64>,
    Option<String>,
    Option<String>,
    String,
    i64,
);

fn read_movable(
    conn: &Connection,
    image_id: &str,
    pages: &[ReceivedPageRef],
) -> Result<Option<MovableImage>, Error> {
    let row: Option<ImageRow> = conn
        .query_row(
            "SELECT sha256, deleted_at, note_manual, rating_manual, original_name,
                    coalesce(collected_at, imported_at)
             FROM image WHERE id = ?1",
            [image_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?;
    let Some((sha256, deleted_at, note, rating, original_name, collected_at)) = row else {
        return Ok(None);
    };
    if pages.is_empty() || deleted_at.is_some() || note.is_some() || rating.is_some() {
        return Ok(None);
    }
    let touched: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM folder_member WHERE image_id = ?1)
             OR EXISTS (SELECT 1 FROM tag_decision WHERE image_id = ?1)",
        [image_id],
        |row| row.get(0),
    )?;
    if touched {
        return Ok(None);
    }
    let layers: HashSet<String> = pages
        .iter()
        .map(|p| {
            FactSource::subscription(&p.source, &p.work_id)
                .as_str()
                .to_owned()
        })
        .collect();
    let sources: Vec<(String, String, Option<String>)> = {
        let mut stmt = conn
            .prepare_cached("SELECT source, location, url FROM image_source WHERE image_id = ?1")?;
        stmt.query_map([image_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<Result<_, _>>()?
    };
    if sources
        .iter()
        .any(|(source, _, _)| !layers.contains(source))
    {
        return Ok(None);
    }
    let mut out = Vec::with_capacity(pages.len());
    for page in pages {
        let layer = FactSource::subscription(&page.source, &page.work_id);
        let suffix = format!("#p{}", page.page);
        let Some((_, location, url)) = sources
            .iter()
            .find(|(s, l, _)| s == layer.as_str() && l.ends_with(&suffix))
        else {
            // 来源层缺了这一页：重建不出来，留在原处。
            return Ok(None);
        };
        let page_url = url
            .clone()
            .unwrap_or_else(|| location[..location.len() - suffix.len()].to_owned());
        let (author, tags) = layer_tags(conn, image_id, &layer)?;
        let explicit: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM rating_fact
                            WHERE image_id = ?1 AND source = ?2 AND rating = 'explicit')",
            params![image_id, layer.as_str()],
            |row| row.get(0),
        )?;
        out.push(SubscriptionPage {
            source: page.source.clone(),
            work_id: page.work_id.clone(),
            page: page.page,
            original_name: original_name.clone(),
            page_url,
            author,
            tags,
            explicit,
            collected_at,
        });
    }
    Ok(Some(MovableImage {
        image_id: image_id.to_owned(),
        sha256,
        pages: out,
    }))
}

/// 这一层来源标签的原文：作者与作品标签。原文按来源名称、不分语言的别名、标签名的顺序找。
fn layer_tags(
    conn: &Connection,
    image_id: &str,
    layer: &FactSource,
) -> Result<(Option<String>, Vec<String>), Error> {
    let mut stmt = conn.prepare_cached(
        "SELECT t.namespace,
                coalesce((SELECT name FROM tag_source_name s WHERE s.tag_id = t.id ORDER BY name LIMIT 1),
                         (SELECT name FROM tag_alias a WHERE a.tag_id = t.id AND a.lang IS NULL
                          ORDER BY name LIMIT 1),
                         (SELECT name FROM tag_name n WHERE n.tag_id = t.id ORDER BY lang LIMIT 1))
         FROM tag_fact f JOIN tag t ON t.id = f.tag_id
         WHERE f.image_id = ?1 AND f.source = ?2
         ORDER BY t.namespace, 2",
    )?;
    let rows: Vec<(String, Option<String>)> = stmt
        .query_map(params![image_id, layer.as_str()], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<Result<_, _>>()?;
    let mut author = None;
    let mut tags = Vec::new();
    for (namespace, name) in rows {
        let Some(name) = name else { continue };
        if namespace == "artist" && author.is_none() {
            author = Some(name);
        } else {
            tags.push(name);
        }
    }
    Ok((author, tags))
}
