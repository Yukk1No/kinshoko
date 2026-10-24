//! Eagle 导入来源 adapter：只读来源，枚举以 images/ 为准。
//! 原样 JSON 与解析出的来源事实在原文件发布后的同一事务里提交。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension, Transaction, params};
use serde::Deserialize;
use serde_json::Value;

use super::{
    EagleLocationChoice, EagleRelocation, Error, FactSource, Inner, LibraryEvent, SourceTag,
    TagNamespace, TagRef, now_ms, tags,
};

mod commit;
mod folders;
mod location;

pub(super) use commit::*;
use folders::*;
pub(super) use location::*;

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
    /// 来源记录里的条目位置：由登记的规范根路径拼出，与导入时用的路径写法无关。
    pub(super) location: String,
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

/// 一个 Eagle 资料库里要导入的条目。
pub(super) struct Collected {
    pub(super) items: Vec<PathBuf>,
    /// 已迁入、但在这个资料库里已经不存在的条目数（本库副本保留）。
    pub(super) missing: u32,
}

/// 枚举一个 Eagle 资料库没有得到条目的原因。
pub(super) enum CollectError {
    Failed(String),
    /// 新位置像是已登记来源搬了家：什么都没写，等画师确认。
    Relocation(EagleRelocation),
}

impl From<String> for CollectError {
    fn from(reason: String) -> Self {
        CollectError::Failed(reason)
    }
}

/// `images/` 下的条目目录，按名称排序。`mtime.json` 不可靠，不作为枚举依据。
fn item_dirs(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut items = Vec::new();
    for entry in std::fs::read_dir(root.join("images")).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() && is_item(&entry.path()) {
            items.push(entry.path());
        }
    }
    items.sort();
    Ok(items)
}

fn external_ids(items: &[PathBuf]) -> Vec<String> {
    items
        .iter()
        .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(str::to_owned))
        .collect()
}

pub(super) fn collect(inner: &Inner, path: &Path) -> Result<Collected, CollectError> {
    let items = item_dirs(path)?;
    let present = external_ids(&items);
    let source_id = match registered(inner, path)? {
        // 已登记的来源：Eagle 这次的文件夹改动先进来，条目才能引用新文件夹。
        Some(id) => {
            refresh(inner, &id, path)?;
            id
        }
        None => {
            if let Some(proposal) = relocation(inner, path, &present)? {
                return Err(CollectError::Relocation(proposal));
            }
            register_new(inner, path)?
        }
    };
    // Eagle 中删除的条目只把绑定记为 missing，不删本库副本；重新出现时由刷新改回。
    let present = serde_json::to_string(&present).map_err(|e| e.to_string())?;
    let missing = inner
        .writer
        .run(move |conn| {
            conn.execute(
                "UPDATE source_binding SET state = 'missing'
                 WHERE source_id = ?1 AND state IN ('present', 'trashed')
                   AND external_id NOT IN (SELECT value FROM json_each(?2))",
                params![source_id, present],
            )?;
            conn.query_row(
                "SELECT COUNT(DISTINCT external_id) FROM source_binding
                 WHERE source_id = ?1 AND state = 'missing'
                   AND external_id NOT IN (SELECT value FROM json_each(?2))",
                params![source_id, present],
                |r| r.get(0),
            )
        })
        .map_err(|e| e.to_string())?;
    Ok(Collected { items, missing })
}

fn canonical(root: &Path) -> Result<String, String> {
    Ok(std::fs::canonicalize(root)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned())
}

/// 这个位置已登记的来源。
fn registered(inner: &Inner, root: &Path) -> Result<Option<String>, String> {
    let location = canonical(root)?;
    inner
        .readers
        .get()
        .query_row(
            "SELECT id FROM import_source WHERE location = ?1",
            [&location],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())
}

/// 按位置找到来源；没登记过就登记。疑似搬家的位置不登记，要画师先确认。
fn register(inner: &Inner, root: &Path) -> Result<String, String> {
    if let Some(id) = registered(inner, root)? {
        return Ok(id);
    }
    if relocation(inner, root, &external_ids(&item_dirs(root)?))?.is_some() {
        return Err("这个 Eagle 资料库像是已登记的来源搬了家，确认后才能迁入".into());
    }
    register_new(inner, root)
}

/// 读出并验证 Eagle 资料库的 metadata.json；先验证整棵文件夹树，避免坏的层级留下半次写入。
fn library_metadata(root: &Path) -> Result<(String, LibraryMetadata), String> {
    let raw = std::fs::read_to_string(root.join("metadata.json")).map_err(|e| e.to_string())?;
    let metadata: LibraryMetadata = parse(&raw)?;
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
    Ok((raw, metadata))
}

/// 把这个位置登记为新的 Eagle 来源（不检查是否搬家）。
fn register_new(inner: &Inner, root: &Path) -> Result<String, String> {
    let location = canonical(root)?;
    let (raw, metadata) = library_metadata(root)?;
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
        sync_folders(tx, &id, None, &metadata)?;
        Ok(id)
    }).map_err(|e| e.to_string())
}

/// 重导时刷新资料库级的原样 JSON 与文件夹层级。
fn refresh(inner: &Inner, source_id: &str, root: &Path) -> Result<(), String> {
    let (raw, metadata) = library_metadata(root)?;
    let source_id = source_id.to_owned();
    let changed = inner
        .writer
        .run(move |conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let old: String = tx.query_row(
                "SELECT raw_library_json FROM import_source WHERE id = ?1",
                [&source_id],
                |r| r.get(0),
            )?;
            if old == raw {
                return Ok(false);
            }
            let old = parse::<LibraryMetadata>(&old).ok();
            sync_folders(&tx, &source_id, old.as_ref(), &metadata)?;
            tx.execute(
                "UPDATE import_source SET raw_library_json = ?2 WHERE id = ?1",
                params![source_id, raw],
            )?;
            tx.commit()?;
            Ok(true)
        })
        .map_err(|e: Error| e.to_string())?;
    // 只有文件夹层级或原样 JSON 真的变了才让浏览结果过期。
    if changed {
        inner.hub.publish(LibraryEvent::ListStale {
            library_id: inner.info.id.clone(),
        });
    }
    Ok(())
}

/// 来源记录里一个条目的位置：`<资料库根>/images/<条目目录>`。
fn item_location(root: &Path, entry: &std::ffi::OsStr) -> String {
    root.join("images")
        .join(entry)
        .to_string_lossy()
        .into_owned()
}

pub(super) fn load(inner: &Inner, path: &Path) -> Result<Item, String> {
    let root = path
        .parent()
        .and_then(Path::parent)
        .ok_or("Eagle 条目路径无效")?;
    let source_id = register(inner, root)?;
    let location = item_location(
        &plain(&canonical(root)?),
        path.file_name().ok_or("Eagle 条目路径无效")?,
    );
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
    // Eagle 资料库里有、本库却没有对应的文件夹是画师在本库删掉的（#114）：归属略过，不算错。
    // 只在遇到没有对应的文件夹时才读这个来源的文件夹层级。
    let mut known: Option<HashSet<String>> = None;
    let mut mapped = Vec::with_capacity(metadata.folders.len());
    for id in &metadata.folders {
        if let Some(folder) = folders.get(id) {
            mapped.push(folder.clone());
            continue;
        }
        if known.is_none() {
            known = Some(source_folder_ids(&conn, &source_id)?);
        }
        if !known.as_ref().is_some_and(|known| known.contains(id)) {
            return Err(format!("Eagle 条目引用了不存在的文件夹：{id}"));
        }
    }
    let folders = mapped;
    Ok(Item {
        source_id,
        original: path.join(format!("{}.{}", metadata.name, metadata.ext)),
        location,
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

impl Item {
    fn state(&self) -> &'static str {
        if self.metadata.is_deleted {
            "trashed"
        } else {
            "present"
        }
    }
}
