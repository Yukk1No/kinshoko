//! Eagle 导入来源 adapter：只读来源，枚举以 images/ 为准。
//! 原样 JSON 与解析出的来源事实在原文件发布后的同一事务里提交。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension, Transaction, params};
use serde::Deserialize;
use serde_json::Value;

use super::{Error, FactSource, Inner, SourceTag, TagNamespace, TagRef, now_ms, tags};

/// 已登记的 Eagle 来源快照，供来源管理与字段往返检查使用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EagleSourceSnapshot {
    pub id: String,
    pub location: PathBuf,
    pub raw_library_json: String,
    pub bindings: Vec<EagleBinding>,
}

/// 原图与一个 Eagle 条目的绑定；同库重复的条目仍各自保留元数据。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EagleBinding {
    pub external_id: String,
    pub sha256: String,
    pub image_id: String,
    pub raw_item_json: String,
    pub state: String,
    pub collected_at: i64,
    pub region_notes: Vec<EagleRegionNote>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EagleRegionNote {
    pub basis: String,
    pub raw_json: String,
}

#[derive(Deserialize)]
struct LibraryMetadata {
    #[serde(default)]
    folders: Vec<Folder>,
}

#[derive(Deserialize)]
struct Folder {
    id: String,
    name: String,
    #[serde(default)]
    children: Vec<Folder>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ItemMetadata {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) ext: String,
    pub(super) size: u64,
    pub(super) width: u32,
    pub(super) height: u32,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    folders: Vec<String>,
    #[serde(default)]
    annotation: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    comments: Vec<Value>,
    #[serde(default)]
    btime: Option<i64>,
    #[serde(default)]
    modification_time: Option<i64>,
    #[serde(default)]
    is_deleted: bool,
    #[serde(default)]
    deleted_time: Option<i64>,
}

pub(super) struct Item {
    pub(super) source_id: String,
    pub(super) original: PathBuf,
    pub(super) metadata: ItemMetadata,
    raw: String,
    folders: Vec<String>,
}

pub(super) fn is_library(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("library"))
        || (path.join("metadata.json").is_file() && path.join("images").is_dir())
}

pub(super) fn is_item(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("info"))
        && path
            .parent()
            .is_some_and(|p| p.file_name().is_some_and(|n| n == "images"))
}

fn parse<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T, String> {
    serde_json::from_str(raw.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("Eagle 元数据缺少必需字段或格式无效：{e}"))
}

pub(super) fn collect(inner: &Inner, path: &Path) -> Result<Vec<PathBuf>, String> {
    register(inner, path)?;
    let mut items = Vec::new();
    for entry in std::fs::read_dir(path.join("images")).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() && is_item(&entry.path()) {
            items.push(entry.path());
        }
    }
    items.sort();
    Ok(items)
}

fn register(inner: &Inner, root: &Path) -> Result<String, String> {
    let location = std::fs::canonicalize(root)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let existing = inner
        .readers
        .get()
        .query_row(
            "SELECT id FROM import_source WHERE location = ?1",
            [&location],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let raw = std::fs::read_to_string(root.join("metadata.json")).map_err(|e| e.to_string())?;
    let metadata: LibraryMetadata = parse(&raw)?;
    // 先验证整棵树，避免坏的文件夹层级留下半次登记。
    fn validate(folders: &[Folder], seen: &mut HashSet<String>) -> Result<(), String> {
        for folder in folders {
            if folder.id.is_empty()
                || folder.name.trim().is_empty()
                || !seen.insert(folder.id.clone())
            {
                return Err("Eagle 文件夹的 id 或名称无效，或 id 重复".into());
            }
            validate(&folder.children, seen)?;
        }
        Ok(())
    }
    validate(&metadata.folders, &mut HashSet::new())?;
    inner.write(move |tx| {
        // 同一来源可能同时由两个任务登记。
        if let Some(id) = tx.query_row("SELECT id FROM import_source WHERE location = ?1", [&location], |r| r.get::<_, String>(0)).optional()? {
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        tx.execute(
            "INSERT INTO import_source (id, kind, location, raw_library_json, mapping_version, registered_at) VALUES (?1, 'eagle', ?2, ?3, 1, ?4)",
            params![id, location, raw, now_ms()],
        )?;
        fn insert(tx: &Transaction, source_id: &str, folders: &[Folder], parent: Option<&str>) -> Result<(), Error> {
            let offset: i64 = tx.query_row("SELECT coalesce(max(ord) + 1, 0) FROM folder WHERE parent_id IS ?1", [parent], |r| r.get(0))?;
            for (ord, folder) in folders.iter().enumerate() {
                let folder_id = uuid::Uuid::now_v7().simple().to_string();
                tx.execute("INSERT INTO folder (id, name, parent_id, ord, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![folder_id, folder.name, parent, offset + ord as i64, now_ms()])?;
                tx.execute("INSERT INTO eagle_folder (source_id, external_id, folder_id) VALUES (?1, ?2, ?3)", params![source_id, folder.id, folder_id])?;
                insert(tx, source_id, &folder.children, Some(&folder_id))?;
            }
            Ok(())
        }
        insert(tx, &id, &metadata.folders, None)?;
        Ok(id)
    }).map_err(|e| e.to_string())
}

pub(super) fn load(inner: &Inner, path: &Path) -> Result<Item, String> {
    let root = path
        .parent()
        .and_then(Path::parent)
        .ok_or("Eagle 条目路径无效")?;
    let source_id = register(inner, root)?;
    let raw = std::fs::read_to_string(path.join("metadata.json")).map_err(|e| e.to_string())?;
    let metadata: ItemMetadata = parse(&raw)?;
    for (field, value) in [
        ("id", &metadata.id),
        ("name", &metadata.name),
        ("ext", &metadata.ext),
    ] {
        if value.is_empty()
            || value.contains(['/', '\\', ':', '\0'])
            || value == "."
            || value == ".."
        {
            return Err(format!("Eagle 条目的 {field} 无效"));
        }
    }
    if path.file_stem().and_then(|s| s.to_str()) != Some(&metadata.id) {
        return Err("Eagle 条目的 id 与 images 下的目录名不符".into());
    }
    if metadata.width == 0
        || metadata.height == 0
        || metadata.tags.iter().any(|t| t.trim().is_empty())
    {
        return Err("Eagle 条目的尺寸或标签无效".into());
    }
    let conn = inner.readers.get();
    let mut stmt = conn
        .prepare_cached("SELECT external_id, folder_id FROM eagle_folder WHERE source_id = ?1")
        .map_err(|e| e.to_string())?;
    let folders: HashMap<String, String> = stmt
        .query_map([&source_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let folders = metadata
        .folders
        .iter()
        .map(|id| {
            folders
                .get(id)
                .cloned()
                .ok_or_else(|| format!("Eagle 条目引用了不存在的文件夹：{id}"))
        })
        .collect::<Result<_, _>>()?;
    Ok(Item {
        source_id,
        original: path.join(format!("{}.{}", metadata.name, metadata.ext)),
        metadata,
        raw,
        folders,
    })
}

impl Item {
    pub(super) fn collected_at(&self, now: i64) -> i64 {
        self.metadata
            .btime
            .or(self.metadata.modification_time)
            .unwrap_or(now)
    }

    pub(super) fn deleted_at(&self, now: i64) -> Option<i64> {
        self.metadata
            .is_deleted
            .then_some(self.metadata.deleted_time.unwrap_or(now))
    }
}

/// 写入与 Library::replace_source_tags 相同的来源层，仍处在原图的提交事务中。
pub(super) fn commit(
    tx: &Transaction,
    translations: &tags::TranslationIndex,
    item: &Item,
    sha: &str,
    image_id: &str,
    location: &str,
    now: i64,
) -> Result<i64, Error> {
    let source = FactSource::eagle(&format!("{}:{}", item.source_id, item.metadata.id));
    let source_tags: Vec<_> = item
        .metadata
        .tags
        .iter()
        .map(|name| SourceTag {
            tag: TagRef::Named {
                namespace: TagNamespace::General,
                name: name.clone(),
                lang: "zh-CN".into(),
            },
            score: None,
        })
        .collect();
    tags::replace_source_tags_in(tx, translations, &source, image_id, &source_tags)?;
    for folder_id in &item.folders {
        tx.execute("INSERT OR IGNORE INTO folder_member (folder_id, image_id, added_at) VALUES (?1, ?2, ?3)", params![folder_id, image_id, now])?;
    }
    tx.execute("INSERT OR IGNORE INTO image_source (image_id, source, location, recorded_at, note, url) VALUES (?1, 'eagle', ?2, ?3, ?4, ?5)", params![image_id, location, now, item.metadata.annotation, item.metadata.url])?;
    tx.execute("INSERT INTO source_binding (source_id, external_id, sha256, image_id, raw_item_json, state, collected_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", params![item.source_id, item.metadata.id, sha, image_id, item.raw, if item.metadata.is_deleted { "trashed" } else { "present" }, item.collected_at(now)])?;
    // 新的正常条目使重复原图可见；已有人工作出的删除决定不受来源影响。
    if !item.metadata.is_deleted {
        tx.execute(
            "UPDATE image SET deleted_at = NULL, eagle_initial_trash = 0
             WHERE id = ?1 AND eagle_initial_trash = 1",
            [image_id],
        )?;
    }
    for (ord, note) in item.metadata.comments.iter().enumerate() {
        tx.execute("INSERT INTO region_note (source_id, external_id, sha256, ord, basis, raw_json) VALUES (?1, ?2, ?3, ?4, 'eagle-raw-unverified', ?5)", params![item.source_id, item.metadata.id, sha, ord as i64, note.to_string()])?;
    }
    tags::bump_revision(tx)
}

pub(super) fn snapshots(inner: &Inner) -> Result<Vec<EagleSourceSnapshot>, Error> {
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
