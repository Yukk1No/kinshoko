//! 写入一个 Eagle 条目的来源层（与原图同一事务）。

use super::*;

/// 这个 Eagle 条目在本库里的状况。
pub(in crate::library) enum Existing {
    /// 从没迁入过。
    New,
    /// 同样的原图已绑定；`unchanged` 表示元数据与状态都和上次一样，不必再写。
    Bound { image_id: String, unchanged: bool },
    /// 迁入过，但原图内容变了；旧内容是 `previous_image_id`。
    Changed { previous_image_id: String },
}

pub(in crate::library) fn existing(
    tx: &Transaction,
    item: &Item,
    sha: &str,
) -> Result<Existing, Error> {
    let mut stmt = tx.prepare_cached(
        "SELECT sha256, image_id, state, raw_item_json FROM source_binding
         WHERE source_id = ?1 AND external_id = ?2",
    )?;
    let rows: Vec<(String, String, String, String)> = stmt
        .query_map(params![item.source_id, item.metadata.id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<Result<_, _>>()?;
    let current = |s: &&(String, String, String, String)| s.2 != "superseded";
    if let Some((_, image_id, state, raw)) = rows.iter().find(|r| r.0 == sha) {
        let others_current = rows.iter().filter(current).any(|r| r.0 != sha);
        return Ok(Existing::Bound {
            image_id: image_id.clone(),
            unchanged: !others_current && state == item.state() && raw == &item.raw,
        });
    }
    Ok(match rows.iter().find(current) {
        Some((_, image_id, ..)) => Existing::Changed {
            previous_image_id: image_id.clone(),
        },
        None => Existing::New,
    })
}

pub(in crate::library) struct CommitContext {
    pub(in crate::library) now: i64,
    pub(in crate::library) created_in_this_task: bool,
}

/// 写入（或刷新）这个条目的 Eagle 来源层，仍处在原图的提交事务中：原样 JSON、绑定状态、
/// 区域评论、标签（与 Library::replace_source_tags 相同的分层）、来源备注与链接、文件夹归属。
/// 人工整理与已有回收站状态保持；同批新建图的初始 Eagle 状态由同批条目共同决定。
pub(in crate::library) fn commit(
    tx: &Transaction,
    translations: &tags::TranslationIndex,
    item: &Item,
    sha: &str,
    image_id: &str,
    location: &str,
    context: CommitContext,
) -> Result<i64, Error> {
    let CommitContext {
        now,
        created_in_this_task,
    } = context;
    let source = FactSource::eagle(&format!("{}:{}", item.source_id, item.metadata.id));
    // Eagle 原文是本库的来源名称，不是某种语言的名称（ADR-0012）。
    let source_tags = item
        .metadata
        .tags
        .iter()
        .map(|name| {
            Ok(SourceTag {
                tag: TagRef::Id {
                    id: tags::resolve_source_named(tx, TagNamespace::General, name)?,
                },
                score: None,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
    tags::replace_source_tags_in(tx, translations, &source, image_id, &source_tags)?;
    // 文件夹归属只跟随 Eagle 自上次迁入以来的改动。
    let previous_raw: Option<String> = tx
        .query_row(
            "SELECT raw_item_json FROM source_binding
             WHERE source_id = ?1 AND external_id = ?2 AND sha256 = ?3",
            params![item.source_id, item.metadata.id, sha],
            |r| r.get(0),
        )
        .optional()?;
    let mut before = HashSet::new();
    if let Some(raw) = &previous_raw {
        let old: Value =
            serde_json::from_str(raw.trim_start_matches('\u{feff}')).unwrap_or_default();
        for eagle_id in old["folders"].as_array().into_iter().flatten() {
            if let Some(folder_id) = eagle_id
                .as_str()
                .map(|id| local_folder(tx, &item.source_id, id))
                .transpose()?
                .flatten()
            {
                before.insert(folder_id);
            }
        }
    }
    // 画师在本库决定过的归属（放入或移出）由画师说了算，Eagle 之后怎么改都不动。
    let decided = |folder_id: &str| -> Result<bool, Error> {
        Ok(tx
            .query_row(
                "SELECT 1 FROM folder_decision WHERE folder_id = ?1 AND image_id = ?2",
                params![folder_id, image_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    };
    for folder_id in item.folders.iter().filter(|f| !before.contains(*f)) {
        if !decided(folder_id)? {
            tx.execute("INSERT OR IGNORE INTO folder_member (folder_id, image_id, added_at) VALUES (?1, ?2, ?3)", params![folder_id, image_id, now])?;
        }
    }
    for folder_id in before.iter().filter(|f| !item.folders.contains(f)) {
        if !decided(folder_id)? {
            tx.execute(
                "DELETE FROM folder_member WHERE folder_id = ?1 AND image_id = ?2",
                params![folder_id, image_id],
            )?;
        }
    }
    // 每个条目一行来源记录：重导只刷新这一条的备注与链接。
    tx.execute(
        "INSERT INTO image_source (image_id, source, location, recorded_at, note, url)
         VALUES (?1, 'eagle', ?2, ?3, ?4, ?5)
         ON CONFLICT (image_id, source, location) DO UPDATE SET note = excluded.note, url = excluded.url",
        params![image_id, location, now, item.metadata.annotation, item.metadata.url],
    )?;
    // 同一条目的旧内容让位给这一份。
    tx.execute(
        "UPDATE source_binding SET state = 'superseded'
         WHERE source_id = ?1 AND external_id = ?2 AND sha256 <> ?3",
        params![item.source_id, item.metadata.id, sha],
    )?;
    let first_seen = tx.execute(
        "INSERT INTO source_binding (source_id, external_id, sha256, image_id, raw_item_json, state, collected_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (source_id, external_id, sha256) DO NOTHING",
        params![item.source_id, item.metadata.id, sha, image_id, item.raw, item.state(), item.collected_at(now)],
    )? == 1;
    if !first_seen {
        tx.execute(
            "UPDATE source_binding SET raw_item_json = ?4, state = ?5, collected_at = ?6
             WHERE source_id = ?1 AND external_id = ?2 AND sha256 = ?3",
            params![
                item.source_id,
                item.metadata.id,
                sha,
                item.raw,
                item.state(),
                item.collected_at(now)
            ],
        )?;
    }
    // 同一次首次迁入的重复条目共同决定新图的初始状态，不依赖条目顺序。
    // #78 T14：此前任务已放进回收站的副本不能自动恢复；人工删除会清除 initial 标记。
    if first_seen && created_in_this_task && !item.metadata.is_deleted {
        tx.execute(
            "UPDATE image SET deleted_at = NULL, eagle_initial_trash = 0
             WHERE id = ?1 AND eagle_initial_trash = 1",
            [image_id],
        )?;
    }
    tx.execute(
        "DELETE FROM region_note WHERE source_id = ?1 AND external_id = ?2 AND sha256 = ?3",
        params![item.source_id, item.metadata.id, sha],
    )?;
    for (ord, note) in item.metadata.comments.iter().enumerate() {
        tx.execute("INSERT INTO region_note (source_id, external_id, sha256, ord, basis, raw_json) VALUES (?1, ?2, ?3, ?4, 'eagle-raw-unverified', ?5)", params![item.source_id, item.metadata.id, sha, ord as i64, note.to_string()])?;
    }
    tags::bump_revision(tx)
}

pub(in crate::library) fn snapshots(inner: &Inner) -> Result<Vec<EagleSourceSnapshot>, Error> {
    let conn = inner.readers.get();
    let mut stmt = conn.prepare_cached(
        "SELECT id, location, raw_library_json FROM import_source ORDER BY registered_at, id",
    )?;
    let mut sources = stmt
        .query_map([], |r| {
            Ok(EagleSourceSnapshot {
                id: r.get(0)?,
                location: PathBuf::from(r.get::<_, String>(1)?),
                raw_library_json: r.get(2)?,
                bindings: Vec::new(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for source in &mut sources {
        let mut stmt = conn.prepare_cached("SELECT external_id, sha256, image_id, raw_item_json, state, collected_at FROM source_binding WHERE source_id = ?1 ORDER BY external_id, sha256")?;
        source.bindings = stmt
            .query_map([&source.id], |r| {
                Ok(EagleBinding {
                    external_id: r.get(0)?,
                    sha256: r.get(1)?,
                    image_id: r.get(2)?,
                    raw_item_json: r.get(3)?,
                    state: r.get(4)?,
                    collected_at: r.get(5)?,
                    region_notes: Vec::new(),
                })
            })?
            .collect::<Result<_, _>>()?;
        for binding in &mut source.bindings {
            let mut stmt = conn.prepare_cached("SELECT basis, raw_json FROM region_note WHERE source_id = ?1 AND external_id = ?2 AND sha256 = ?3 ORDER BY ord")?;
            binding.region_notes = stmt
                .query_map(
                    params![source.id, binding.external_id, binding.sha256],
                    |r| {
                        Ok(EagleRegionNote {
                            basis: r.get(0)?,
                            raw_json: r.get(1)?,
                        })
                    },
                )?
                .collect::<Result<_, _>>()?;
        }
    }
    Ok(sources)
}
