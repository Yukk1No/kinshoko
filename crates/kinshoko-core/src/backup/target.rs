//! 备份目标：画师选的本地目录。目录下的 `kinshoko-backup/` 是 Backup 自己的布局：
//!
//! - `originals/<sha 前两位>/<sha>`：按哈希存的原文件，全部快照共用，只复制新增的；
//! - `snapshots/<快照 id>/`：`manifest.json`（格式 `kinshoko.backup`）、`libraries/<资料库 id>/`
//!   下的数据库快照、`groups/<参考组 id>.json`。写到一半的快照在 `<快照 id>.incomplete/`，
//!   不会被当成完整备份，下次备份时清掉。
//!
//! 资料库与参考组只经它们的依赖清单与快照入口接触（[`Library::snapshot_at`]、
//! [`Library::restore_at`]、[`ReferenceGroups::snapshot`]、[`ReferenceGroups::restore`]）。

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::retention;
use super::{BackupScope, ScopeItem, Stamp, Uncovered};
use crate::RegisteredLibrary;
use crate::library::{
    self, Library, LibraryInfo, OriginalFile, ReferenceLens, RestoreProvenance, TableDigest,
};
use crate::reference_groups::{self, GroupError, ReferenceGroups, RestoredFrom};

mod report;
mod restoring;

pub use report::*;

const ROOT: &str = "kinshoko-backup";
const STORE: &str = "originals";
const SNAPSHOTS: &str = "snapshots";
const INCOMPLETE: &str = ".incomplete";
const MANIFEST: &str = "manifest.json";
const FORMAT: &str = "kinshoko.backup";
const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: String,
    format_version: u32,
    id: String,
    created_at: Stamp,
    scope: BackupScope,
    libraries: Vec<ManifestLibrary>,
    groups: Vec<ManifestGroup>,
    skipped: Vec<SkippedLibrary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestLibrary {
    id: String,
    name: String,
    /// Library 返回的快照文件键，Backup 不推断资料库的磁盘布局。
    #[serde(default = "legacy_database_key")]
    database_key: PathBuf,
    database_sha256: String,
    originals: Vec<OriginalFile>,
    curation: Vec<TableDigest>,
}

// 早期格式 v1 清单没有记录文件键；这是旧备份格式的固定值，不用于新快照。
fn legacy_database_key() -> PathBuf {
    "library.sqlite".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestGroup {
    id: String,
    name: String,
    sha256: String,
}

/// 画师选的备份目标目录。
#[derive(Debug, Clone)]
pub struct BackupTarget {
    dir: PathBuf,
}

impl BackupTarget {
    pub fn new(dir: &Path) -> BackupTarget {
        BackupTarget {
            dir: dir.to_path_buf(),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 备份目标在不在。选好的目录不会被自动建立：移动盘没插时不往别处写。
    pub fn available(&self) -> bool {
        self.dir.is_dir()
    }

    fn root(&self) -> Result<PathBuf, BackupError> {
        if !self.available() {
            return Err(BackupError::TargetUnavailable(self.dir.clone()));
        }
        Ok(self.dir.join(ROOT))
    }

    fn stored(&self, root: &Path, sha: &str) -> PathBuf {
        root.join(STORE).join(&sha[..2.min(sha.len())]).join(sha)
    }

    /// 执行前的容量估计：范围内的全部内容，以及备份目标里还没有、这次要复制的部分。
    /// 备份目标不在时按全部需要复制估计。
    pub fn estimate(
        &self,
        scope: &BackupScope,
        sources: &BackupSources,
    ) -> Result<BackupEstimate, BackupError> {
        let root = self.root().ok();
        let mut est = BackupEstimate {
            total_bytes: 0,
            new_bytes: 0,
            originals: 0,
            new_originals: 0,
            unavailable: Vec::new(),
        };
        let mut seen = BTreeSet::new();
        for item in &scope.libraries {
            let deps = registered(sources, item).and_then(|reg| {
                Library::dependencies_at(&reg.root, &reg.id).map_err(|e| e.to_string())
            });
            let deps = match deps {
                Ok(d) => d,
                Err(reason) => {
                    est.unavailable.push(SkippedLibrary {
                        library: item.clone(),
                        reason,
                    });
                    continue;
                }
            };
            est.total_bytes += deps.database_size;
            est.new_bytes += deps.database_size;
            for dep in deps.originals {
                est.originals += 1;
                est.total_bytes += dep.file.size;
                if !seen.insert(dep.file.sha256.clone()) {
                    continue;
                }
                let have = root.as_ref().is_some_and(|r| {
                    fs::metadata(self.stored(r, &dep.file.sha256))
                        .is_ok_and(|m| m.len() == dep.file.size)
                });
                if !have {
                    est.new_originals += 1;
                    est.new_bytes += dep.file.size;
                }
            }
        }
        for g in &scope.groups {
            if let Ok(bytes) = sources.groups.snapshot(&g.id) {
                est.total_bytes += bytes.len() as u64;
                est.new_bytes += bytes.len() as u64;
            }
        }
        Ok(est)
    }

    /// 按范围备份一次：每个资料库先取原文件租约并做数据库快照，再把快照引用的原文件按哈希
    /// 增量复制（复制时核对哈希），然后复制参考组、写清单，最后改名为完整快照，按保留策略
    /// 清理旧快照与不再被引用的原文件。原文件内容与记录不符或缺失时快照不完整。
    /// 读不到的资料库（移动盘没插）跳过并在结果里列出。
    pub fn run(
        &self,
        scope: &BackupScope,
        sources: &BackupSources,
        at: Stamp,
        progress: &mut dyn FnMut(BackupProgress),
    ) -> Result<BackupReport, BackupError> {
        self.run_content(scope, sources, None, at, progress)
    }

    /// Content backup with current application definitions, excluding display preferences.
    /// The shared scope, snapshot, lease and retention pipeline is unchanged.
    pub fn run_with_catalog(
        &self,
        scope: &BackupScope,
        sources: &BackupSources,
        catalog: &crate::tag_catalog::CatalogInspection,
        at: Stamp,
        progress: &mut dyn FnMut(BackupProgress),
    ) -> Result<BackupReport, BackupError> {
        self.run_content(scope, sources, Some(catalog), at, progress)
    }

    fn run_content(
        &self,
        scope: &BackupScope,
        sources: &BackupSources,
        catalog: Option<&crate::tag_catalog::CatalogInspection>,
        at: Stamp,
        progress: &mut dyn FnMut(BackupProgress),
    ) -> Result<BackupReport, BackupError> {
        let root = self.root()?;
        let snapshots = root.join(SNAPSHOTS);
        fs::create_dir_all(&snapshots)?;
        fs::create_dir_all(root.join(STORE))?;
        remove_incomplete(&snapshots);

        let id = snapshot_id(at);
        let work = snapshots.join(format!("{id}{INCOMPLETE}"));
        fs::create_dir_all(&work)?;
        let mut report = BackupReport {
            snapshot_id: id.clone(),
            complete: false,
            copied: 0,
            copied_bytes: 0,
            reused: 0,
            skipped: Vec::new(),
            problems: Vec::new(),
            removed_snapshots: Vec::new(),
        };
        let mut manifest = Manifest {
            format: FORMAT.into(),
            format_version: FORMAT_VERSION,
            id: id.clone(),
            created_at: at,
            scope: scope.clone(),
            libraries: Vec::new(),
            groups: Vec::new(),
            skipped: Vec::new(),
        };

        // 先固定组引用，再取库快照。复制期间保存的新成员不混入本次备份。
        let groups_dir = work.join("groups");
        fs::create_dir_all(&groups_dir)?;
        for g in &scope.groups {
            match sources.groups.snapshot(&g.id) {
                Ok(bytes) => {
                    let libraries = match ReferenceGroups::snapshot_libraries(&bytes) {
                        Ok(libraries) => libraries,
                        Err(e) => {
                            report.problems.push(format!("参考组“{}”：{e}", g.name));
                            continue;
                        }
                    };
                    if libraries.iter().any(|id| {
                        !scope.libraries.iter().any(|l| &l.id == id)
                            && !scope.uncovered.iter().any(|u| {
                                matches!(u,
                                Uncovered::Library { group, library_id, .. }
                                    if group.id == g.id && library_id == id)
                            })
                    }) {
                        report.problems.push(format!(
                            "参考组“{}”有新的资料库引用，请重新计算备份范围后重试",
                            g.name
                        ));
                        continue;
                    }
                    write_synced(&groups_dir.join(format!("{}.json", g.id)), &bytes)?;
                    manifest.groups.push(ManifestGroup {
                        id: g.id.clone(),
                        name: g.name.clone(),
                        sha256: sha256(&bytes),
                    });
                }
                Err(e) => report.problems.push(format!("参考组“{}”：{e}", g.name)),
            }
        }

        let mut snaps = Vec::new();
        for item in &scope.libraries {
            let snap = registered(sources, item).and_then(|reg| {
                Library::snapshot_at(&reg.root, &reg.id, &work.join("libraries").join(&reg.id))
                    .map_err(|e| e.to_string())
            });
            match snap {
                Ok(mut s) => {
                    if let Some(catalog) = catalog {
                        // Failure enriching a selected library is incomplete, not an unavailable skip.
                        if let Err(e) = s.apply_content_definitions(catalog) {
                            report
                                .problems
                                .push(format!("资料库“{}”的标签定义：{e}", item.name));
                            continue;
                        }
                    }
                    snaps.push(s);
                }
                Err(reason) => report.skipped.push(SkippedLibrary {
                    library: item.clone(),
                    reason,
                }),
            }
        }
        let total = snaps.iter().map(|s| s.originals.len() as u32).sum();
        let mut done = 0;
        progress(BackupProgress { done, total });
        // 整次备份都持有各资料库的原文件租约（`snaps` 活到函数结束）。
        for snap in &snaps {
            for dep in &snap.originals {
                let target = self.stored(&root, &dep.file.sha256);
                let have = fs::metadata(&target).is_ok_and(|m| m.len() == dep.file.size);
                if have {
                    report.reused += 1;
                } else {
                    match store(&dep.source, &target, &dep.file.sha256) {
                        Ok(()) => {
                            report.copied += 1;
                            report.copied_bytes += dep.file.size;
                            library::fault::hit(library::fault::BACKUP_AFTER_COPY);
                        }
                        Err(why) => report.problems.push(format!(
                            "资料库“{}”的原图 {}：{why}",
                            snap.library.name, dep.file.key
                        )),
                    }
                }
                done += 1;
                progress(BackupProgress { done, total });
            }
            manifest.libraries.push(ManifestLibrary {
                id: snap.library.id.clone(),
                name: snap.library.name.clone(),
                database_key: snap
                    .database
                    .strip_prefix(work.join("libraries").join(&snap.library.id))
                    .map_err(std::io::Error::other)?
                    .to_path_buf(),
                database_sha256: library::hash_file(&snap.database)?,
                originals: snap.originals.iter().map(|d| d.file.clone()).collect(),
                curation: snap.curation.clone(),
            });
        }

        manifest.skipped = report.skipped.clone();
        let bytes = serde_json::to_vec_pretty(&manifest).map_err(std::io::Error::other)?;
        write_synced(&work.join(MANIFEST), &bytes)?;
        if !report.problems.is_empty() {
            return Ok(report);
        }
        fs::rename(&work, snapshots.join(&id))?;
        report.complete = true;
        report.removed_snapshots = self.prune(&root)?;
        Ok(report)
    }

    /// 备份目标里的完整快照，新的在前。
    pub fn snapshots(&self) -> Result<Vec<SnapshotSummary>, BackupError> {
        let root = self.root()?;
        let mut out: Vec<SnapshotSummary> = complete_manifests(&root)
            .into_iter()
            .map(|(_, m)| SnapshotSummary {
                libraries: m
                    .libraries
                    .iter()
                    .map(|l| ScopeItem {
                        id: l.id.clone(),
                        name: l.name.clone(),
                    })
                    .collect(),
                groups: m
                    .groups
                    .iter()
                    .map(|g| ScopeItem {
                        id: g.id.clone(),
                        name: g.name.clone(),
                    })
                    .collect(),
                skipped: m.skipped,
                created_at: m.created_at,
                id: m.id,
            })
            .collect();
        out.sort_by_key(|s| std::cmp::Reverse(s.created_at.unix_ms));
        Ok(out)
    }

    /// 按保留策略删掉旧快照，再删掉不再被任何快照引用的原文件。返回删掉的快照。
    fn prune(&self, root: &Path) -> Result<Vec<String>, BackupError> {
        let manifests = complete_manifests(root);
        let stamps: Vec<Stamp> = manifests.iter().map(|(_, m)| m.created_at).collect();
        let keep = retention::keep(&stamps);
        let mut removed = Vec::new();
        let mut referenced = BTreeSet::new();
        for (i, (dir, m)) in manifests.iter().enumerate() {
            if keep.contains(&i) {
                for lib in &m.libraries {
                    referenced.extend(lib.originals.iter().map(|f| f.sha256.clone()));
                }
            } else {
                fs::remove_dir_all(dir)?;
                removed.push(m.id.clone());
            }
        }
        for shard in fs::read_dir(root.join(STORE))?.flatten() {
            let Ok(files) = fs::read_dir(shard.path()) else {
                continue;
            };
            for file in files.flatten() {
                let name = file.file_name().to_string_lossy().into_owned();
                if !referenced.contains(&name) {
                    let _ = fs::remove_file(file.path());
                }
            }
        }
        removed.sort();
        Ok(removed)
    }
}

fn registered<'a>(
    sources: &'a BackupSources,
    item: &ScopeItem,
) -> Result<&'a RegisteredLibrary, String> {
    sources
        .libraries
        .iter()
        .find(|l| l.id == item.id)
        .ok_or_else(|| "本设备没有登记这个资料库".to_owned())
}

/// 复制进备份目标的原文件区：先写临时文件、核对哈希、落盘，再改名。
fn store(source: &Path, target: &Path, sha: &str) -> Result<(), String> {
    let dir = target.parent().expect("原文件区有上级目录");
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".{sha}.tmp-{}", uuid::Uuid::new_v4().simple()));
    let result = match library::copy_hashed(source, &tmp) {
        Ok(got) if got == sha => fs::rename(&tmp, target).map_err(|e| e.to_string()),
        Ok(_) => Err("原图内容与资料库记录不符（可能被外部改动），这次备份不完整".into()),
        Err(e) => Err(format!("读不到原图：{e}")),
    };
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn remove_incomplete(snapshots: &Path) {
    if let Ok(entries) = fs::read_dir(snapshots) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().ends_with(INCOMPLETE) {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
}

fn complete_manifests(root: &Path) -> Vec<(PathBuf, Manifest)> {
    let Ok(entries) = fs::read_dir(root.join(SNAPSHOTS)) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| !e.file_name().to_string_lossy().ends_with(INCOMPLETE))
        .filter_map(|e| read_manifest(&e.path()).ok().map(|m| (e.path(), m)))
        .collect()
}

fn read_manifest(dir: &Path) -> Result<Manifest, String> {
    let bytes = fs::read(dir.join(MANIFEST)).map_err(|e| format!("读不到清单：{e}"))?;
    let m: Manifest = serde_json::from_slice(&bytes).map_err(|e| format!("清单已损坏：{e}"))?;
    if m.format != FORMAT {
        return Err("不是 Kinshoko 备份".into());
    }
    if m.format_version > FORMAT_VERSION {
        return Err(format!(
            "由更新版本的 Kinshoko 写成（格式版本 {}）",
            m.format_version
        ));
    }
    for lib in &m.libraries {
        if !valid_id(&lib.id)
            || lib.database_key.as_os_str().is_empty()
            || !lib
                .database_key
                .components()
                .all(|p| matches!(p, std::path::Component::Normal(_)))
        {
            return Err("数据库快照文件键无效".into());
        }
    }
    Ok(m)
}

pub(super) fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = fs::File::create(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn snapshot_id(at: Stamp) -> String {
    let (y, mo, d, h, mi, s) = at.local_parts();
    let tail = uuid::Uuid::new_v4().simple().to_string();
    format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}-{}", &tail[..6])
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `into` 下以 `name` 命名、还不存在的文件夹；重名时加序号。
fn unique_dir(into: &Path, name: &str) -> PathBuf {
    let clean: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let clean = clean.trim().trim_end_matches('.').to_owned();
    let mut candidate = into.join(&clean);
    let mut n = 2;
    while candidate.exists() {
        candidate = into.join(format!("{clean} {n}"));
        n += 1;
    }
    candidate
}
