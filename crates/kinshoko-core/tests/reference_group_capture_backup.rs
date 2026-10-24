//! 参考组自带的截图（#270）随本地备份（#69）走：备份带上截图字节，原参考组丢了也能从备份恢复，
//! 往返检查核对截图；参考组包导入时不接受能跳出参考组目录的截图文件名。
//! 经 `kinshoko_core` 的对外接口，用临时目录里的真文件。

use std::io::{Read, Write};
use std::path::Path;

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::backup::{BackupSources, BackupTarget, ScopeSelection, Stamp, compute_scope};
use kinshoko_core::desktop::{CaptureHistory, PinContent, Placement, SavedPin, Screenshot};
use kinshoko_core::reference_groups::{GroupError, ReferenceGroup, ReferenceGroups};

fn shot(seed: u8) -> Screenshot {
    Screenshot {
        image: RgbaImage::from_fn(24, 16, |x, y| image::Rgba([seed, x as u8, y as u8, 255])),
        icc: None,
    }
}

/// 一个只有一张组内截图的参考组，以及截图的字节。
fn group_with_capture(root: &Path, groups: &ReferenceGroups) -> (ReferenceGroup, Vec<u8>) {
    let mut history = CaptureHistory::open(&root.join("captures")).unwrap();
    let entry = history.add(&shot(4)).unwrap();
    let bytes = std::fs::read(history.file(&entry.id).unwrap()).unwrap();
    let mut pins = [SavedPin {
        id: "p".into(),
        content: PinContent::Capture {
            capture_id: entry.id.clone(),
        },
        crop: None,
        width: 24,
        height: 16,
        placement: Placement {
            x: 50,
            ..Default::default()
        },
        opacity: 1.0,
        locked: false,
        member: None,
    }];
    let keep = [history.group_capture(&entry.id).unwrap()];
    let group = groups
        .create_with_captures("一次性", &mut pins, &keep)
        .unwrap();
    (group, bytes)
}

fn backup(groups: &ReferenceGroups, target: &BackupTarget) -> kinshoko_core::backup::BackupReport {
    let scope = compute_scope(&[], &groups.list().unwrap(), &ScopeSelection::All);
    target
        .run(
            &scope,
            &BackupSources {
                libraries: &[],
                groups,
            },
            Stamp::new(1_791_158_400_000, 0),
            &mut |_| {},
        )
        .unwrap()
}

#[test]
fn a_group_capture_is_backed_up_and_restored_after_the_original_group_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    let groups = ReferenceGroups::open(&dir.path().join("reference-groups")).unwrap();
    let (group, bytes) = group_with_capture(dir.path(), &groups);
    let target = BackupTarget::new(&dir.path().join("backup"));
    std::fs::create_dir_all(dir.path().join("backup")).unwrap();
    let report = backup(&groups, &target);
    assert!(report.complete, "备份完成：{:?}", report.problems);

    // 原参考组和它的截图都没了。
    groups.delete(&group.id).unwrap();
    let restored = target
        .restore(
            &report.snapshot_id,
            &dir.path().join("restored"),
            &groups,
            Stamp::new(1_791_244_800_000, 0),
        )
        .unwrap();
    assert!(restored.check.passed(), "往返检查：{:?}", restored.check);
    assert_eq!(restored.groups.len(), 1);
    let copy = groups.get(&restored.groups[0].id).unwrap();
    assert_eq!(copy.members[0].source, group.members[0].source);
    let file = groups
        .capture_path(&copy.id, &copy.members[0].id)
        .expect("恢复出的成员仍是组内截图");
    assert_eq!(std::fs::read(file).unwrap(), bytes, "截图按字节恢复");
}

#[test]
fn the_backup_estimate_counts_group_captures_as_new_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let groups = ReferenceGroups::open(&dir.path().join("reference-groups")).unwrap();
    let (group, bytes) = group_with_capture(dir.path(), &groups);
    let json = groups.snapshot(&group.id).unwrap().len() as u64;
    let target = BackupTarget::new(&dir.path().join("backup"));
    std::fs::create_dir_all(dir.path().join("backup")).unwrap();
    let scope = compute_scope(&[], &groups.list().unwrap(), &ScopeSelection::All);
    let sources = BackupSources {
        libraries: &[],
        groups: &groups,
    };
    let estimate = target.estimate(&scope, &sources).unwrap();
    let expected = json + bytes.len() as u64;
    assert_eq!(
        (estimate.total_bytes, estimate.new_bytes),
        (expected, expected)
    );
}

#[test]
fn a_group_whose_capture_file_is_missing_leaves_the_backup_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let groups = ReferenceGroups::open(&dir.path().join("reference-groups")).unwrap();
    let (group, _) = group_with_capture(dir.path(), &groups);
    std::fs::remove_file(
        groups
            .capture_path(&group.id, &group.members[0].id)
            .unwrap(),
    )
    .unwrap();
    let target = BackupTarget::new(&dir.path().join("backup"));
    std::fs::create_dir_all(dir.path().join("backup")).unwrap();
    let report = backup(&groups, &target);
    assert!(!report.complete);
    assert!(
        report.problems.iter().any(|p| p.contains("一次性")),
        "{:?}",
        report.problems
    );
}

#[test]
fn a_package_capture_name_that_escapes_the_group_is_refused_before_anything_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let groups = ReferenceGroups::open(&dir.path().join("source")).unwrap();
    let (group, _) = group_with_capture(dir.path(), &groups);
    let package = dir.path().join("p.kinshoko-group");
    struct NoLibraries;
    impl kinshoko_core::reference_groups::ReferenceSource for NoLibraries {
        fn lens(
            &self,
            _: &str,
        ) -> Result<
            kinshoko_core::library::ReferenceLens,
            kinshoko_core::reference_groups::UnavailableReason,
        > {
            Err(kinshoko_core::reference_groups::UnavailableReason::LibraryNotRegistered)
        }
    }
    groups
        .export_package(&group.id, &NoLibraries, &package)
        .unwrap();

    // 篡改：清单里多一张成员不用的截图，文件名跳出参考组目录。
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&package).unwrap()).unwrap();
    let mut entries = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).unwrap();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        entries.push((entry.name().to_owned(), bytes));
    }
    let evil = b"not a screenshot".to_vec();
    let sha = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(&evil));
    for (name, bytes) in &mut entries {
        if name == "manifest.json" {
            let mut manifest: serde_json::Value = serde_json::from_slice(bytes).unwrap();
            manifest["captures"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!({
                    "file": "../../escaped.png", "size": evil.len(), "sha256": sha,
                }));
            *bytes = serde_json::to_vec(&manifest).unwrap();
        }
    }
    entries.push(("captures/../../escaped.png".into(), evil));
    let tampered = dir.path().join("tampered.kinshoko-group");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&tampered).unwrap());
    for (name, bytes) in &entries {
        zip.start_file(name.as_str(), zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();

    let elsewhere = ReferenceGroups::open(&dir.path().join("elsewhere").join("groups")).unwrap();
    let library = Library::create(&dir.path().join("library"), "资料库").unwrap();
    let result = elsewhere.import_package(&tampered, &library);
    assert!(
        matches!(result, Err(GroupError::PackageDamaged(_))),
        "{result:?}"
    );
    assert!(!dir.path().join("elsewhere").join("escaped.png").exists());
    assert!(!dir.path().join("escaped.png").exists());
    assert!(elsewhere.list().unwrap().is_empty());
}
