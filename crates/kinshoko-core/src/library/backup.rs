//! Library 的备份子接口（#69，#42“模块与接口”）：依赖清单（文件、大小、哈希）、原文件租约
//! （持有期间禁止清理）、快照到目录、从目录恢复（新的资料库身份，记录恢复来源）。
//!
//! Backup 只经这里接触资料库的存储：依赖清单里的 `key` 对它是不透明的，原文件放在资料库目录的
//! 哪里只有这里知道。这些入口按位置与身份工作，资料库是否是活动资料库都可以用（WAL 下只读
//! 与写入并发）。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rusqlite::types::ValueRef;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use super::{DB_FILE, Error, Library, LibraryInfo, ORIGINALS_DIR, STAGING_DIR, store};

/// 依赖清单里的一个原文件。`key` 只在资料库内部有意义，备份原样记下、恢复时原样交回。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalFile {
    pub key: String,
    pub sha256: String,
    pub size: u64,
}

/// 原文件及它此刻在磁盘上的位置（只读，供复制）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dependency {
    pub file: OriginalFile,
    pub source: PathBuf,
}

/// 资料库的依赖清单：数据库大小与引用的全部原文件（含回收站里的图）。容量估计用。
#[derive(Debug, Clone)]
pub struct LibraryDependencies {
    pub library: LibraryInfo,
    pub database_size: u64,
    pub originals: Vec<Dependency>,
}

/// 一张表整理信息的摘要：恢复后按同样的列重算，核对逐行一致。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDigest {
    pub table: String,
    pub columns: Vec<String>,
    pub rows: u64,
    pub sha256: String,
}

/// 快照到目录的结果。持有期间这个资料库的原文件不会被清理（原文件租约），复制完原文件再放下。
pub struct LibrarySnapshot {
    pub library: LibraryInfo,
    /// 目录里的数据库快照（SQLite Online Backup）。
    pub database: PathBuf,
    /// 快照引用的原文件；按快照，不按快照之后的变化。
    pub originals: Vec<Dependency>,
    /// 快照的整理信息摘要（资料库身份与恢复来源除外）。
    pub curation: Vec<TableDigest>,
    _lease: OriginalsLease,
}

impl LibrarySnapshot {
    /// Complete this private snapshot with current pure app definitions. The source stays read-only.
    pub(crate) fn apply_content_definitions(
        &mut self,
        catalog: &crate::tag_catalog::CatalogInspection,
    ) -> Result<(), Error> {
        let mut conn = Connection::open(store::sqlite_path(&self.database)?)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let tx = conn.transaction()?;
        super::tag_definitions::seed(&tx)?;
        tx.commit()?;
        let dependencies = super::tag_definitions::read(&conn)?;
        let local_ids = dependencies
            .iter()
            .map(|binding| binding.local_tag_id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        let mut bindings = catalog
            .content_bindings(&self.library.id, dependencies)
            .map_err(|e| Error::TagDefinitions(e.to_string()))?;
        // A mapping can outlive a tag deleted before the fixed database snapshot.
        bindings.retain(|binding| local_ids.contains(&binding.local_tag_id));
        super::tag_definitions::publish(&mut conn, &bindings)?;
        // These legacy rows are program settings since #78. A new library identity must not
        // make their migration replay during a later content-only registration.
        clear_legacy_application_settings(&conn)?;
        self.curation = curation(&conn, None)?;
        Ok(())
    }
}

/// 这个资料库是从哪个备份恢复出来的。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RestoreProvenance {
    pub old_library_id: String,
    pub backup_id: String,
    #[ts(type = "number")]
    pub restored_at: i64,
}

/// 恢复后对一个资料库的往返检查结果。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LibraryCheck {
    /// 核对过哈希的原文件数。
    pub originals_checked: u32,
    /// 缺失或内容不符的原文件。
    pub original_problems: Vec<String>,
    /// 与快照不一致的整理信息（表）。
    pub curation_problems: Vec<String>,
    /// Content tables actually compared; legacy program settings are excluded.
    pub curation_checked: u32,
}

/// 原文件租约：持有期间不清除该资料库的原文件——永久删除（#67）照常删掉记录，原文件留在待清除
/// 表里，租约放下后的下一次永久删除或打开资料库时再清。按资料库身份登记在进程内，资料库在租约
/// 期间打开或切换也有效。
pub struct OriginalsLease {
    library_id: String,
}

fn leases() -> &'static Mutex<HashMap<String, usize>> {
    static LEASES: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
    LEASES.get_or_init(Mutex::default)
}

impl OriginalsLease {
    fn take(library_id: &str) -> OriginalsLease {
        *leases()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(library_id.to_owned())
            .or_default() += 1;
        OriginalsLease {
            library_id: library_id.to_owned(),
        }
    }
}

impl Drop for OriginalsLease {
    fn drop(&mut self) {
        let mut map = leases().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = map.get_mut(&self.library_id) {
            *n -= 1;
            if *n == 0 {
                map.remove(&self.library_id);
            }
        }
    }
}

/// 资料库 `library_id` 的原文件此刻有租约：永久删除的清除步骤（[`super::permanent_delete`]）据此暂缓。
pub(super) fn leased(library_id: &str) -> bool {
    leases()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(library_id)
}

/// 不进整理信息核对的表：资料库身份、恢复来源、未完成导入与待清除原文件的对账记录。
const NOT_CURATION: &[&str] = &[
    "library",
    "restore_provenance",
    "import_pending",
    "original_removal",
];

impl Library {
    /// 有备份正在复制这个资料库的原文件（原文件租约）。持有期间不得清理原文件。
    pub fn originals_leased(&self) -> bool {
        leased(&self.inner.info.id)
    }

    /// 这个资料库的恢复来源，先恢复的在前；不是恢复出来的库为空。
    pub fn restore_provenance(&self) -> Result<Vec<RestoreProvenance>, Error> {
        let conn = self.inner.readers.get();
        let mut stmt = conn.prepare(
            "SELECT old_library_id, backup_id, restored_at FROM restore_provenance
             ORDER BY restored_at, rowid",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(RestoreProvenance {
                old_library_id: r.get(0)?,
                backup_id: r.get(1)?,
                restored_at: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// 依赖清单（只读，不升级、不对账）：数据库大小与引用的全部原文件。
    pub fn dependencies_at(root: &Path, expected_id: &str) -> Result<LibraryDependencies, Error> {
        let library = checked_info(root, expected_id)?;
        let db = root.join(DB_FILE);
        let conn = store::inspect_db(&db)?;
        Ok(LibraryDependencies {
            database_size: std::fs::metadata(&db)?.len(),
            originals: originals(&conn, &library.root)?,
            library,
        })
    }

    /// 取得原文件租约，再用 SQLite Online Backup 把数据库一致地快照到 `into` 下，依赖清单与整理信息
    /// 摘要都按快照读出。`into` 不存在时建立。
    pub fn snapshot_at(
        root: &Path,
        expected_id: &str,
        into: &Path,
    ) -> Result<LibrarySnapshot, Error> {
        let library = checked_info(root, expected_id)?;
        let lease = OriginalsLease::take(&library.id);
        std::fs::create_dir_all(into)?;
        let database = into.join(DB_FILE);
        {
            let source = store::inspect_db(&root.join(DB_FILE))?;
            let mut copy = Connection::open(store::sqlite_path(&database)?)?;
            // 一步复制全部页：整个复制期间持有同一个读事务，得到一致的快照。
            let backup = rusqlite::backup::Backup::new(&source, &mut copy)?;
            loop {
                match backup.step(-1)? {
                    rusqlite::backup::StepResult::Done => break,
                    rusqlite::backup::StepResult::More => {}
                    _ => std::thread::sleep(std::time::Duration::from_millis(50)),
                }
            }
            drop(backup);
            // 快照是一个自足的文件，不带 -wal。
            copy.pragma_update(None, "journal_mode", "DELETE")?;
        }
        let conn = store::inspect_db(&database)?;
        Ok(LibrarySnapshot {
            originals: originals(&conn, &library.root)?,
            curation: curation(&conn, None)?,
            database,
            library,
            _lease: lease,
        })
    }

    pub(crate) fn snapshot_tag_definitions(
        database: &Path,
    ) -> Result<Vec<crate::portable_tags::PortableTagDefinition>, Error> {
        let conn = store::inspect_db(database)?;
        let present: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='tag_definition_dependency')", [], |r| r.get(0))?;
        if !present {
            return Ok(Vec::new());
        } // Backups made before portable dependencies remain compatible.
        Ok(super::tag_definitions::read(&conn)?
            .into_iter()
            .map(|binding| binding.definition)
            .collect())
    }

    /// 从快照恢复出一个新的资料库：放在 `root`（不存在或空文件夹），新的资料库身份、名称 `name`，
    /// 参考图身份不变，记下恢复来源。原文件由 `fetch(文件, 目标位置)` 写到资料库指定的位置，
    /// 写好后在这里核对哈希。失败时删掉已写的部分。
    pub fn restore_at(
        database: &Path,
        root: &Path,
        name: &str,
        provenance: &RestoreProvenance,
        fetch: &mut dyn FnMut(&OriginalFile, &Path) -> std::io::Result<()>,
    ) -> Result<LibraryInfo, Error> {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::InvalidName);
        }
        if root.exists() && std::fs::read_dir(root)?.next().is_some() {
            return Err(Error::NotEmpty(root.to_path_buf()));
        }
        let result = (|| {
            std::fs::create_dir_all(root.join(ORIGINALS_DIR))?;
            std::fs::create_dir_all(root.join(STAGING_DIR))?;
            std::fs::copy(database, root.join(DB_FILE))?;
            let mut conn = store::open_db(&root.join(DB_FILE))?;
            for dep in originals(&conn, root)? {
                if !safe_key(&dep.file.key) {
                    return Err(Error::NotALibrary(database.to_path_buf()));
                }
                if let Some(dir) = dep.source.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                fetch(&dep.file, &dep.source)?;
                if hash_file(&dep.source)? != dep.file.sha256 {
                    return Err(Error::Io(std::io::Error::other(format!(
                        "恢复的原文件内容不符：{}",
                        dep.file.key
                    ))));
                }
            }
            // Old content snapshots can still contain the former per-library settings.
            // Restoring content must not give them a new migration identity in the target app.
            clear_legacy_application_settings(&conn)?;
            let tx = conn.transaction()?;
            tx.execute(
                "UPDATE library SET id = ?1, name = ?2",
                params![uuid::Uuid::new_v4().simple().to_string(), name],
            )?;
            tx.execute(
                "INSERT INTO restore_provenance (old_library_id, backup_id, restored_at)
                 VALUES (?1, ?2, ?3)",
                params![
                    provenance.old_library_id,
                    provenance.backup_id,
                    provenance.restored_at
                ],
            )?;
            tx.commit()?;
            drop(conn);
            // 按资料库自己的规则打开一次：对账、确认能用。
            let library = Library::open(root)?;
            Ok(library.info().clone())
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(root);
        }
        result
    }

    /// 恢复后的往返检查：每个原文件都在、哈希与记录一致；整理信息按快照的表与列逐行一致。
    pub fn check_restored(
        root: &Path,
        expected_id: &str,
        expected: &[OriginalFile],
        curation_expected: &[TableDigest],
    ) -> Result<LibraryCheck, Error> {
        let info = checked_info(root, expected_id)?;
        let conn = store::inspect_db(&root.join(DB_FILE))?;
        let mut check = LibraryCheck::default();
        let present: HashMap<String, Dependency> = originals(&conn, &info.root)?
            .into_iter()
            .map(|d| (d.file.key.clone(), d))
            .collect();
        for file in expected {
            check.originals_checked += 1;
            match present.get(&file.key) {
                None => check
                    .original_problems
                    .push(format!("缺少原图 {}", file.key)),
                Some(dep) => match hash_file(&dep.source) {
                    Ok(sha) if sha == file.sha256 && dep.file.sha256 == file.sha256 => {}
                    Ok(_) => check
                        .original_problems
                        .push(format!("原图内容不符 {}", file.key)),
                    Err(e) => check
                        .original_problems
                        .push(format!("读不到原图 {}：{e}", file.key)),
                },
            }
        }
        if present.len() != expected.len() {
            check.original_problems.push(format!(
                "原图数量不符：快照 {} 张，恢复后 {} 张",
                expected.len(),
                present.len()
            ));
        }
        let content_expected = curation_expected
            .iter()
            .filter(|digest| {
                !["tag_group", "tag_group_member", "personal_approx"]
                    .contains(&digest.table.as_str())
            })
            .cloned()
            .collect::<Vec<_>>();
        check.curation_checked = content_expected.len() as u32;
        let actual = curation(&conn, Some(&content_expected))?;
        for (want, got) in content_expected.iter().zip(&actual) {
            if want != got {
                check.curation_problems.push(format!(
                    "表 {}：快照 {} 行，恢复后 {} 行，内容{}",
                    want.table,
                    want.rows,
                    got.rows,
                    if want.sha256 == got.sha256 {
                        "一致"
                    } else {
                        "不一致"
                    }
                ));
            }
        }
        Ok(check)
    }
}

fn clear_legacy_application_settings(conn: &Connection) -> Result<(), Error> {
    conn.execute_batch("BEGIN IMMEDIATE; DELETE FROM tag_group_member; DELETE FROM tag_group; DELETE FROM personal_approx; COMMIT;")?;
    Ok(())
}

fn checked_info(root: &Path, expected_id: &str) -> Result<LibraryInfo, Error> {
    let info = Library::inspect(root)?;
    if info.id != expected_id {
        return Err(Error::NotALibrary(root.to_path_buf()));
    }
    Ok(info)
}

fn originals(conn: &Connection, root: &Path) -> Result<Vec<Dependency>, Error> {
    let mut stmt = conn.prepare("SELECT rel_path, sha256, size FROM image ORDER BY seq")?;
    let rows = stmt.query_map([], |r| {
        let key: String = r.get(0)?;
        Ok(Dependency {
            source: root.join(&key),
            file: OriginalFile {
                key,
                sha256: r.get(1)?,
                size: r.get::<_, i64>(2)?.max(0) as u64,
            },
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// 备份里读出的位置只能落在资料库目录里。
fn safe_key(key: &str) -> bool {
    let path = Path::new(key);
    !key.is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)))
}

pub(crate) fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 整理信息摘要。`like` 给出时按它的表与列（快照里的列；之后的迁移只会加列）计算，顺序一致。
fn curation(conn: &Connection, like: Option<&[TableDigest]>) -> Result<Vec<TableDigest>, Error> {
    let specs: Vec<(String, Vec<String>)> = match like {
        Some(like) => like
            .iter()
            .map(|d| (d.table.clone(), d.columns.clone()))
            .collect(),
        None => {
            let mut stmt = conn.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                 ORDER BY name",
            )?;
            let tables: Vec<String> = stmt
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            let mut specs = Vec::new();
            for table in tables {
                if NOT_CURATION.contains(&table.as_str()) {
                    continue;
                }
                let columns = columns(conn, &table)?;
                specs.push((table, columns));
            }
            specs
        }
    };
    let mut out = Vec::new();
    for (table, cols) in specs {
        out.push(digest(conn, &table, &cols).unwrap_or_else(|_| TableDigest {
            table: table.clone(),
            columns: cols.clone(),
            rows: 0,
            sha256: "缺少这张表或列".into(),
        }));
    }
    Ok(out)
}

fn columns(conn: &Connection, table: &str) -> Result<Vec<String>, Error> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", quote(table)))?;
    let cols = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<_, _>>()?;
    Ok(cols)
}

fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn digest(conn: &Connection, table: &str, cols: &[String]) -> Result<TableDigest, Error> {
    let list = cols.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", ");
    let order = (1..=cols.len())
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn.prepare(&format!(
        "SELECT {list} FROM {} ORDER BY {order}",
        quote(table)
    ))?;
    let mut rows = stmt.query([])?;
    let mut hasher = Sha256::new();
    let mut count = 0u64;
    while let Some(row) = rows.next()? {
        count += 1;
        for i in 0..cols.len() {
            match row.get_ref(i)? {
                ValueRef::Null => hasher.update([0u8]),
                ValueRef::Integer(v) => {
                    hasher.update([1u8]);
                    hasher.update(v.to_le_bytes());
                }
                ValueRef::Real(v) => {
                    hasher.update([2u8]);
                    hasher.update(v.to_le_bytes());
                }
                ValueRef::Text(t) => {
                    hasher.update([3u8]);
                    hasher.update((t.len() as u64).to_le_bytes());
                    hasher.update(t);
                }
                ValueRef::Blob(b) => {
                    hasher.update([4u8]);
                    hasher.update((b.len() as u64).to_le_bytes());
                    hasher.update(b);
                }
            }
        }
    }
    Ok(TableDigest {
        table: table.to_owned(),
        columns: cols.to_vec(),
        rows: count,
        sha256: hex(&hasher.finalize()),
    })
}

/// 把 `source` 复制到 `target`，边复制边算哈希并落盘；返回写入内容的哈希。备份复制原文件用。
pub(crate) fn copy_hashed(source: &Path, target: &Path) -> std::io::Result<String> {
    let mut from = std::fs::File::open(source)?;
    let mut to = std::fs::File::create(target)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        to.write_all(&buf[..n])?;
    }
    to.sync_all()?;
    Ok(hex(&hasher.finalize()))
}
