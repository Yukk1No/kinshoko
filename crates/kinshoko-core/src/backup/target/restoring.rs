//! 从快照恢复出独立的资料库与参考组，恢复后做往返检查。

use super::*;

impl BackupTarget {
    /// 从快照恢复出独立的资料库与参考组：资料库放在 `into` 下（新的资料库身份，记下恢复来源），
    /// 参考组恢复成 `groups` 里的新参考组并连接恢复出的库；不覆盖现有的任何资料库与参考组。
    /// 恢复后自动运行往返检查。恢复出的资料库由调用方登记到本设备。
    pub fn restore(
        &self,
        snapshot_id: &str,
        into: &Path,
        groups: &ReferenceGroups,
        at: Stamp,
    ) -> Result<RestoreReport, BackupError> {
        self.restore_content(snapshot_id, into, groups, at, None)
    }

    /// Validate against the current complete application definitions before publishing content.
    /// Existing preferences, aliases and personal settings are never replaced by this action.
    pub fn restore_with_catalog(
        &self,
        snapshot_id: &str,
        into: &Path,
        groups: &ReferenceGroups,
        at: Stamp,
        catalog: &crate::tag_catalog::CatalogInspection,
    ) -> Result<RestoreReport, BackupError> {
        self.restore_content(snapshot_id, into, groups, at, Some(catalog))
    }

    fn restore_content(
        &self,
        snapshot_id: &str,
        into: &Path,
        groups: &ReferenceGroups,
        at: Stamp,
        catalog: Option<&crate::tag_catalog::CatalogInspection>,
    ) -> Result<RestoreReport, BackupError> {
        let _gate = crate::backup::restore::lock();
        crate::backup::restore::recover(groups)?;
        let root = self.root()?;
        if snapshot_id.ends_with(INCOMPLETE) {
            return Err(unfinished());
        }
        if !valid_id(snapshot_id) {
            return Err(BackupError::UnknownSnapshot);
        }
        let dir = root.join(SNAPSHOTS).join(snapshot_id);
        if !dir.is_dir() {
            return if root
                .join(SNAPSHOTS)
                .join(format!("{snapshot_id}{INCOMPLETE}"))
                .is_dir()
            {
                Err(unfinished())
            } else {
                Err(BackupError::UnknownSnapshot)
            };
        }
        let manifest = read_manifest(&dir).map_err(|e| BackupError::Incomplete(Box::new(e)))?;
        // 先核对快照本身，有问题就不动本设备。
        for lib in &manifest.libraries {
            let db = dir.join("libraries").join(&lib.id).join(&lib.database_key);
            if library::hash_file(&db).ok().as_deref() != Some(&lib.database_sha256) {
                return Err(BackupError::incomplete(
                    crate::command_error::ErrorKind::SnapshotLibraryMismatch {
                        name: lib.name.clone(),
                    },
                    format!("资料库“{}”的数据库快照不符", lib.name),
                ));
            }
        }
        if let Some(catalog) = catalog {
            let mut definitions = Vec::new();
            for lib in &manifest.libraries {
                definitions.extend(Library::snapshot_tag_definitions(
                    &dir.join("libraries").join(&lib.id).join(&lib.database_key),
                )?);
            }
            catalog
                .validate_content_dependencies(&definitions)
                .map_err(|error| {
                    BackupError::Incomplete(Box::new(crate::CommandError::caused_by(
                        error,
                        |cause| crate::command_error::ErrorKind::SnapshotDefinitionsConflict {
                            cause,
                        },
                        |error| format!("标签定义与当前程序冲突，未恢复内容：{error}"),
                    )))
                })?;
        }
        let mut group_bytes = Vec::new();
        let mut group_captures = Vec::new();
        for g in &manifest.groups {
            let bytes =
                fs::read(dir.join("groups").join(format!("{}.json", g.id))).map_err(|e| {
                    BackupError::incomplete(
                        crate::command_error::ErrorKind::SnapshotGroupUnreadable {
                            name: g.name.clone(),
                            detail: e.to_string(),
                        },
                        format!("参考组“{}”：{e}", g.name),
                    )
                })?;
            if sha256(&bytes) != g.sha256 {
                return Err(BackupError::incomplete(
                    crate::command_error::ErrorKind::SnapshotGroupMismatch {
                        name: g.name.clone(),
                    },
                    format!("参考组“{}”的快照不符", g.name),
                ));
            }
            group_bytes.push((g, bytes));
            group_captures.push(group_captures::load(&dir.join("groups"), g)?);
        }

        fs::create_dir_all(into)?;
        let mut report = RestoreReport {
            snapshot_id: manifest.id.clone(),
            libraries: Vec::new(),
            groups: Vec::new(),
            check: RoundTripCheck::default(),
        };
        let mut batch = crate::backup::restore::RestoreBatch::new(into, groups, &manifest.id)?;
        let outcome = (|| -> Result<(), BackupError> {
            let mut mapping: HashMap<String, String> = HashMap::new();
            let mut staged_libraries = Vec::new();
            let mut reserved = BTreeSet::new();
            for lib in &manifest.libraries {
                let mut dest =
                    unique_dir(into, &format!("{}（恢复 {}）", lib.name, at.local_date()));
                while !reserved.insert(dest.clone()) {
                    dest = unique_dir(
                        into,
                        &format!(
                            "{}（恢复 {}） {}",
                            lib.name,
                            at.local_date(),
                            reserved.len()
                        ),
                    );
                }
                let stage = batch.stage().join(&lib.id);
                let provenance = RestoreProvenance {
                    old_library_id: lib.id.clone(),
                    backup_id: manifest.id.clone(),
                    restored_at: at.unix_ms,
                };
                let mut info = Library::restore_at(
                    &dir.join("libraries").join(&lib.id).join(&lib.database_key),
                    &stage,
                    &format!("{}（恢复）", lib.name),
                    &provenance,
                    &mut |file, target| {
                        fs::copy(self.stored(&root, &file.sha256), target).map(|_| ())
                    },
                )?;
                mapping.insert(lib.id.clone(), info.id.clone());
                info.root = std::path::absolute(&dest)?;
                staged_libraries.push(stage);
                report.libraries.push(RestoredLibrary {
                    old_id: lib.id.clone(),
                    library: info,
                });
            }
            let staged_groups = ReferenceGroups::open(&batch.stage().join("groups"))?;
            let mut ready_groups = Vec::new();
            for (g, bytes) in &group_bytes {
                let restored = staged_groups.restore(
                    bytes,
                    &mapping,
                    RestoredFrom {
                        group_id: g.id.clone(),
                        backup_id: manifest.id.clone(),
                    },
                )?;
                report.groups.push(RestoredGroup {
                    old_id: g.id.clone(),
                    id: restored.id.clone(),
                    name: restored.name.clone(),
                });
                ready_groups.push(restored);
            }
            // Record every new identity before the first publication. Recovery can undo the
            // exact whole batch even if the process dies between individual filesystem commits.
            batch.prepare(&report.libraries, &ready_groups)?;
            for (stage, restored) in staged_libraries.iter().zip(&report.libraries) {
                if restored.library.root.exists() {
                    return Err(library::Error::NotEmpty(restored.library.root.clone()).into());
                }
                fs::rename(stage, &restored.library.root)?;
                library::fault::storage("content_restore_library_published")
                    .map_err(library::Error::from)?;
            }
            for (group, captures) in ready_groups.into_iter().zip(&group_captures) {
                groups.publish_restored(&group, captures)?;
                library::fault::storage("content_restore_group_published")
                    .map_err(library::Error::from)?;
            }
            report.check = check(&manifest, &report, &group_bytes, groups);
            if !report.check.passed() {
                return Err(BackupError::incomplete(
                    crate::command_error::ErrorKind::RestoreRoundTripMismatch,
                    "恢复后的往返检查不一致，本批次已撤回，可重试",
                ));
            }
            Ok(())
        })();
        if let Err(error) = outcome {
            if let Err(rollback) = batch.rollback() {
                let text =
                    format!("{error}；本批次回退未完成：{rollback}。重启或重试恢复时会再次回退");
                return Err(BackupError::Incomplete(Box::new(crate::CommandError::new(
                    crate::command_error::ErrorKind::RestoreRollbackIncomplete {
                        cause: Box::new(crate::CommandError::from(error).kind),
                        rollback: Box::new(crate::CommandError::from(rollback).kind),
                    },
                    text,
                ))));
            }
            return Err(error);
        }
        batch.finish()?;
        Ok(report)
    }
}

/// 往返检查：原图哈希与整理信息由 Library 按快照核对；参考组与快照里的一致（成员改连恢复出的
/// 库），每个成员都能从恢复出的库取到原图。
fn unfinished() -> BackupError {
    BackupError::incomplete(
        crate::command_error::ErrorKind::BackupUnfinished,
        "备份没有完成",
    )
}

fn check(
    manifest: &Manifest,
    report: &RestoreReport,
    group_bytes: &[(&ManifestGroup, Vec<u8>)],
    groups: &ReferenceGroups,
) -> RoundTripCheck {
    let mut out = RoundTripCheck::default();
    let mut lenses: HashMap<String, ReferenceLens> = HashMap::new();
    for (lib, restored) in manifest.libraries.iter().zip(&report.libraries) {
        let info = &restored.library;
        match Library::check_restored(&info.root, &info.id, &lib.originals, &lib.curation) {
            Ok(c) => {
                out.originals.checked += c.originals_checked;
                out.originals.problems.extend(
                    c.original_problems
                        .into_iter()
                        .map(|p| format!("{}：{p}", lib.name)),
                );
                out.curation.checked += c.curation_checked;
                out.curation.problems.extend(
                    c.curation_problems
                        .into_iter()
                        .map(|p| format!("{}：{p}", lib.name)),
                );
            }
            Err(e) => out.originals.problems.push(format!("{}：{e}", lib.name)),
        }
        match ReferenceLens::open_detached(&info.root, &info.id) {
            Ok(lens) => {
                lenses.insert(info.id.clone(), lens);
            }
            Err(e) => out
                .groups
                .problems
                .push(format!("无法读取恢复出的资料库“{}”：{e}", lib.name)),
        }
    }
    let mapping: HashMap<&str, &str> = report
        .libraries
        .iter()
        .map(|l| (l.old_id.as_str(), l.library.id.as_str()))
        .collect();
    for ((g, bytes), restored) in group_bytes.iter().zip(&report.groups) {
        out.groups.checked += 1;
        let (before, after) = match (reference_groups::parse(bytes), groups.get(&restored.id)) {
            (Ok(b), Ok(a)) => (b, a),
            (_, Err(e)) | (Err(e), _) => {
                out.groups.problems.push(format!("参考组“{}”：{e}", g.name));
                continue;
            }
        };
        if after.name != before.name || after.members.len() != before.members.len() {
            out.groups
                .problems
                .push(format!("参考组“{}”的名称或成员数不一致", g.name));
            continue;
        }
        for (b, a) in before.members.iter().zip(&after.members) {
            let expected_library = b.library_id().map(|l| mapping.get(l).copied().unwrap_or(l));
            if a.id != b.id
                || a.image_id() != b.image_id()
                || a.library_id() != expected_library
                || a.crop != b.crop
                || a.placement != b.placement
                || (a.source_width, a.source_height) != (b.source_width, b.source_height)
            {
                out.groups
                    .problems
                    .push(format!("参考组“{}”的成员 {} 不一致", g.name, b.id));
                continue;
            }
            // 参考组自带的截图核对字节；引用的库不在这次备份里时成员原样保留，不在这里核对。
            let Some((library_id, image_id)) = a.source.library_image() else {
                out.groups
                    .problems
                    .extend(group_captures::check(groups, &restored.id, a, g));
                continue;
            };
            let Some(lens) = lenses.get(library_id) else {
                continue;
            };
            match lens.image(image_id) {
                Ok(img) if (img.width, img.height) == (a.source_width, a.source_height) => {}
                Ok(_) => out
                    .groups
                    .problems
                    .push(format!("参考组“{}”的成员 {} 原图尺寸不符", g.name, a.id)),
                Err(e) => out
                    .groups
                    .problems
                    .push(format!("参考组“{}”的成员 {} 取不到原图：{e}", g.name, a.id)),
            }
        }
    }
    out
}
