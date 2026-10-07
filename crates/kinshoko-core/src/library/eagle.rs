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

/// 新位置疑似已登记来源搬了家：某个来源已绑定的条目至少一半出现在这里。只提议，不写任何数据。
fn relocation(
    inner: &Inner,
    root: &Path,
    present: &[String],
) -> Result<Option<EagleRelocation>, String> {
    let present: HashSet<&str> = present.iter().map(String::as_str).collect();
    let conn = inner.readers.get();
    let mut stmt = conn
        .prepare_cached(
            "SELECT DISTINCT s.id, s.location, b.external_id
             FROM import_source s JOIN source_binding b ON b.source_id = s.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    // 来源 → (登记位置, 已绑定条目数, 出现在新位置的条目数)
    let mut sources: HashMap<String, (String, u64, u64)> = HashMap::new();
    for row in rows {
        let (id, location, external_id) = row.map_err(|e| e.to_string())?;
        let entry = sources.entry(id).or_insert((location, 0, 0));
        entry.1 += 1;
        entry.2 += u64::from(present.contains(external_id.as_str()));
    }
    let best = sources
        .into_iter()
        .filter(|(_, (_, bound, seen))| seen * 2 >= *bound)
        .max_by(|a, b| {
            (a.1.2 * b.1.1)
                .cmp(&(b.1.2 * a.1.1))
                .then_with(|| b.0.cmp(&a.0))
        });
    Ok(match best {
        Some((source_id, (from, bound, seen))) => Some(EagleRelocation {
            source_id,
            from: PathBuf::from(from),
            to: PathBuf::from(canonical(root)?),
            overlap_percent: (seen * 100 / bound) as u32,
        }),
        None => None,
    })
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

/// 这个来源的 Eagle 文件夹在本库对应的文件夹。
fn local_folder(
    conn: &rusqlite::Connection,
    source_id: &str,
    external_id: &str,
) -> Result<Option<String>, Error> {
    Ok(conn
        .query_row(
            "SELECT folder_id FROM eagle_folder WHERE source_id = ?1 AND external_id = ?2",
            params![source_id, external_id],
            |r| r.get(0),
        )
        .optional()?)
}

/// Eagle 文件夹层级进本库。`old` 是上次迁入时的层级：只跟随 Eagle 自那以后的改动
/// （新建、改名、移动），画师在本库改过名或挪过的文件夹不动；Eagle 删掉的文件夹本库保留。
fn sync_folders(
    tx: &Transaction,
    source_id: &str,
    old: Option<&LibraryMetadata>,
    new: &LibraryMetadata,
) -> Result<(), Error> {
    type Before = HashMap<String, (String, Option<String>)>;
    fn index(folders: &[Folder], parent: Option<&str>, out: &mut Before) {
        for folder in folders {
            out.insert(
                folder.id.clone(),
                (folder.name.clone(), parent.map(str::to_owned)),
            );
            index(&folder.children, Some(&folder.id), out);
        }
    }
    let mut before = Before::new();
    if let Some(old) = old {
        index(&old.folders, None, &mut before);
    }
    fn next_ord(tx: &Transaction, parent: Option<&str>) -> Result<i64, Error> {
        Ok(tx.query_row(
            "SELECT coalesce(max(ord) + 1, 0) FROM folder WHERE parent_id IS ?1",
            [parent],
            |r| r.get(0),
        )?)
    }
    /// `id` 移到 `parent` 之下会不会成环。
    fn cycle(tx: &Transaction, id: &str, parent: Option<&str>) -> Result<bool, Error> {
        let mut cursor = parent.map(str::to_owned);
        while let Some(at) = cursor {
            if at == id {
                return Ok(true);
            }
            cursor = tx
                .query_row("SELECT parent_id FROM folder WHERE id = ?1", [&at], |r| {
                    r.get(0)
                })
                .optional()?
                .flatten();
        }
        Ok(false)
    }
    fn walk(
        tx: &Transaction,
        source_id: &str,
        before: &Before,
        folders: &[Folder],
        eagle_parent: Option<&str>,
        local_parent: Option<&str>,
    ) -> Result<(), Error> {
        for folder in folders {
            let local: Option<(String, String, Option<String>)> = tx
                .query_row(
                    "SELECT f.id, f.name, f.parent_id FROM eagle_folder e JOIN folder f ON f.id = e.folder_id
                     WHERE e.source_id = ?1 AND e.external_id = ?2",
                    params![source_id, folder.id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let id = match local {
                None => {
                    let id = uuid::Uuid::now_v7().simple().to_string();
                    tx.execute(
                        "INSERT INTO folder (id, name, parent_id, ord, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![id, folder.name, local_parent, next_ord(tx, local_parent)?, now_ms()],
                    )?;
                    tx.execute(
                        "INSERT INTO eagle_folder (source_id, external_id, folder_id) VALUES (?1, ?2, ?3)",
                        params![source_id, folder.id, id],
                    )?;
                    id
                }
                Some((id, name, parent)) => {
                    if let Some((old_name, old_parent)) = before.get(&folder.id) {
                        if *old_name != folder.name && name == *old_name {
                            tx.execute(
                                "UPDATE folder SET name = ?2 WHERE id = ?1",
                                params![id, folder.name],
                            )?;
                        }
                        if old_parent.as_deref() != eagle_parent {
                            let was = match old_parent {
                                Some(p) => local_folder(tx, source_id, p)?,
                                None => None,
                            };
                            if parent == was && !cycle(tx, &id, local_parent)? {
                                tx.execute(
                                    "UPDATE folder SET parent_id = ?2, ord = ?3 WHERE id = ?1",
                                    params![id, local_parent, next_ord(tx, local_parent)?],
                                )?;
                            }
                        }
                    }
                    id
                }
            };
            walk(
                tx,
                source_id,
                before,
                &folder.children,
                Some(&folder.id),
                Some(&id),
            )?;
        }
        Ok(())
    }
    walk(tx, source_id, &before, &new.folders, None, None)
}

/// 去掉 Windows 规范路径的 `\\?\` 前缀，与导入时记下的条目位置同形。
fn plain(location: &str) -> PathBuf {
    if let Some(rest) = location.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else {
        PathBuf::from(location.strip_prefix(r"\\?\").unwrap_or(location))
    }
}

/// 来源记录里一个条目的位置：`<资料库根>/images/<条目目录>`。
fn item_location(root: &Path, entry: &std::ffi::OsStr) -> String {
    root.join("images")
        .join(entry)
        .to_string_lossy()
        .into_owned()
}

/// 两个路径写法是否指同一位置。Windows 的路径不区分大小写，分隔符可写成 `/` 或 `\`。
fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        let fold = |p: &Path| p.to_string_lossy().replace('/', "\\").to_lowercase();
        fold(a) == fold(b)
    } else {
        a == b
    }
}

/// 画师确认疑似搬家的位置。
pub(super) fn confirm_location(
    inner: &Inner,
    path: &Path,
    choice: EagleLocationChoice,
) -> Result<(), Error> {
    let invalid =
        |reason: String| Error::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, reason));
    let location = canonical(path).map_err(invalid)?;
    match choice {
        EagleLocationChoice::Separate => {
            register_new(inner, path).map_err(invalid)?;
            Ok(())
        }
        EagleLocationChoice::Moved { source_id } => {
            inner.write(move |tx| {
                let old: String = tx
                    .query_row(
                        "SELECT location FROM import_source WHERE id = ?1",
                        [&source_id],
                        |r| r.get(0),
                    )
                    .optional()?
                    .ok_or(Error::UnknownEagleSource)?;
                if old == location {
                    return Ok(());
                }
                if tx
                    .query_row(
                        "SELECT 1 FROM import_source WHERE location = ?1",
                        [&location],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some()
                {
                    return Err(Error::EagleLocationTaken);
                }
                tx.execute(
                    "UPDATE import_source SET location = ?2, relocated_from = ?3 WHERE id = ?1",
                    params![source_id, location, old],
                )?;
                // 来源记录跟着搬家，重导时刷新同一行而不是多出一行。按绑定的条目找记录，
                // 路径比较不受写法影响：首次导入的写法可能与登记的规范路径大小写不同。
                let (old_root, new_root) = (plain(&old), plain(&location));
                let mut stmt = tx.prepare(
                    "SELECT DISTINCT b.image_id, b.external_id, s.location
                     FROM source_binding b
                     JOIN image_source s ON s.image_id = b.image_id AND s.source = 'eagle'
                     WHERE b.source_id = ?1",
                )?;
                let rows: Vec<(String, String, String)> = stmt
                    .query_map([&source_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect::<Result<_, _>>()?;
                for (image_id, external_id, at) in rows {
                    let entry = format!("{external_id}.info");
                    if !same_path(Path::new(&at), Path::new(&item_location(&old_root, entry.as_ref()))) {
                        continue;
                    }
                    let to = item_location(&new_root, entry.as_ref());
                    // 新位置已有同一条目的记录（例如搬家前已经重导过）：旧记录并入它。
                    let moved = tx.execute(
                        "UPDATE OR IGNORE image_source SET location = ?3
                         WHERE image_id = ?1 AND source = 'eagle' AND location = ?2",
                        params![image_id, at, to],
                    )?;
                    if moved == 0 {
                        tx.execute(
                            "DELETE FROM image_source WHERE image_id = ?1 AND source = 'eagle' AND location = ?2",
                            params![image_id, at],
                        )?;
                    }
                }
                Ok(())
            })
        }
    }
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

/// 这个 Eagle 条目在本库里的状况。
pub(super) enum Existing {
    /// 从没迁入过。
    New,
    /// 同样的原图已绑定；`unchanged` 表示元数据与状态都和上次一样，不必再写。
    Bound { image_id: String, unchanged: bool },
    /// 迁入过，但原图内容变了；旧内容是 `previous_image_id`。
    Changed { previous_image_id: String },
}

pub(super) fn existing(tx: &Transaction, item: &Item, sha: &str) -> Result<Existing, Error> {
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

impl Item {
    fn state(&self) -> &'static str {
        if self.metadata.is_deleted {
            "trashed"
        } else {
            "present"
        }
    }
}

/// 写入（或刷新）这个条目的 Eagle 来源层，仍处在原图的提交事务中：原样 JSON、绑定状态、
/// 区域评论、标签（与 Library::replace_source_tags 相同的分层）、来源备注与链接、文件夹归属。
/// 人工标签决定、本库备注与删除状态都不碰；Eagle 回收站只在第一次见到这个条目时起作用。
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
    // 文件夹归属只跟随 Eagle 自上次迁入以来的改动：画师在本库放入或移出的不被改回。
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
    for folder_id in item.folders.iter().filter(|f| !before.contains(*f)) {
        tx.execute("INSERT OR IGNORE INTO folder_member (folder_id, image_id, added_at) VALUES (?1, ?2, ?3)", params![folder_id, image_id, now])?;
    }
    for folder_id in before.iter().filter(|f| !item.folders.contains(f)) {
        tx.execute(
            "DELETE FROM folder_member WHERE folder_id = ?1 AND image_id = ?2",
            params![folder_id, image_id],
        )?;
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
    // 新的正常条目使重复原图可见；已有人工作出的删除决定不受来源影响。
    // 之后 Eagle 再移入或移出回收站，只改绑定状态。
    if first_seen && !item.metadata.is_deleted {
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
