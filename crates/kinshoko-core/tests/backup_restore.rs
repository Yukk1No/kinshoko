//! 本地备份与恢复（#69）：快照、按哈希增量复制原文件、原文件租约、保留策略、恢复为独立副本与恢复后
//! 往返检查（#8 的“备份恢复”检查）。全部经 `kinshoko_core::backup` 与 Library、ReferenceGroups 的
//! 对外接口，用临时目录里的真库与真文件。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use image::RgbaImage;
use kinshoko_core::approx::ApproxRelation;
use kinshoko_core::backup::{
    BackupError, BackupSources, BackupTarget, ScopeSelection, Stamp, compute_scope,
};
use kinshoko_core::desktop::{Placement, Region, SavedPin};
use kinshoko_core::library::{
    ContentRating, ImageEdit, ImportOutcome, ImportSource, TagEdit, TagNamespace, TagRef,
};
use kinshoko_core::reference_groups::ReferenceGroups;
use kinshoko_core::{Library, RegisteredLibrary};

const ZH: &str = "zh-CN";
const DAY: i64 = 24 * 60 * 60 * 1000;
/// 2026-10-05（星期一）00:00 UTC。
const MONDAY: i64 = 1_791_158_400_000;

fn at(day: i64, hour: i64) -> Stamp {
    Stamp::new(MONDAY + day * DAY + hour * 60 * 60 * 1000, 8 * 60)
}

fn png(path: &Path, seed: u8) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    RgbaImage::from_fn(16, 9, |x, y| image::Rgba([seed, x as u8, y as u8, 255]))
        .save(path)
        .unwrap();
    path.to_path_buf()
}

fn import(library: &Library, dir: &Path, seeds: &[u8]) -> Vec<String> {
    let paths = seeds
        .iter()
        .map(|s| png(&dir.join(format!("in-{s}.png")), *s))
        .collect();
    library
        .import(ImportSource { paths })
        .wait()
        .items
        .into_iter()
        .map(|item| match item.outcome {
            ImportOutcome::Imported { image_id } => image_id,
            other => panic!("未导入：{other:?}"),
        })
        .collect()
}

fn general(name: &str) -> TagRef {
    TagRef::Named {
        namespace: TagNamespace::General,
        name: name.into(),
        lang: ZH.into(),
    }
}

/// 本设备：两个资料库（主库、旧库）与一个跨库参考组、一个只引用主库的参考组。
struct Device {
    dir: tempfile::TempDir,
    main: Library,
    old: Library,
    main_images: Vec<String>,
    old_images: Vec<String>,
    groups: ReferenceGroups,
}

impl Device {
    fn new() -> Device {
        let dir = tempfile::tempdir().unwrap();
        let main = Library::create(&dir.path().join("主库"), "主库").unwrap();
        let old = Library::create(&dir.path().join("旧库"), "旧库").unwrap();
        main.set_safe_mode(false);
        old.set_safe_mode(false);
        let main_images = import(&main, &dir.path().join("in"), &[1, 2, 3]);
        let old_images = import(&old, &dir.path().join("in"), &[7, 8]);
        let groups = ReferenceGroups::open(&dir.path().join("reference-groups")).unwrap();
        Device {
            dir,
            main,
            old,
            main_images,
            old_images,
            groups,
        }
    }

    fn registry(&self) -> Vec<RegisteredLibrary> {
        [&self.main, &self.old]
            .iter()
            .map(|l| RegisteredLibrary {
                id: l.info().id.clone(),
                name: l.info().name.clone(),
                root: l.info().root.clone(),
            })
            .collect()
    }

    fn pin(&self, library: &Library, image: &str, crop: Option<Region>, x: i32) -> SavedPin {
        let lens_image = kinshoko_core::library::ReferenceImage {
            id: image.into(),
            width: 16,
            height: 9,
            sealed: false,
        };
        SavedPin::reference(
            &format!("pin-{x}"),
            &library.info().id,
            &lens_image,
            crop,
            Placement {
                x,
                y: 20,
                scale: 2.0,
                flip_h: true,
                flip_v: false,
                rotation: 1,
            },
        )
        .unwrap()
    }

    /// 整理：文件夹、备注、标签决定、分级、个人近似对应表、回收站。
    fn curate(&self) {
        let folder = self.main.create_folder("眼睛", None).unwrap();
        self.main
            .edit(
                &self.main_images[..2],
                &[
                    ImageEdit::AddToFolder { folder_id: folder },
                    ImageEdit::SetNote {
                        text: "虹膜高光".into(),
                    },
                ],
            )
            .unwrap();
        self.main
            .edit_tags(
                &self.main_images[..1],
                &[TagEdit::Add {
                    tag: general("蓝瞳"),
                }],
            )
            .unwrap();
        self.main
            .edit_tags(
                &self.main_images[1..2],
                &[TagEdit::Add {
                    tag: general("水色瞳"),
                }],
            )
            .unwrap();
        let vocabulary = self.main.vocabulary().unwrap();
        let tag = |name: &str| {
            vocabulary
                .tags
                .iter()
                .find(|t| t.names.iter().any(|n| n.name == name))
                .unwrap()
                .id
                .clone()
        };
        self.main
            .set_tag_approx(&tag("蓝瞳"), &tag("水色瞳"), ApproxRelation::Similar)
            .unwrap();
        self.main
            .edit(
                &self.main_images[2..],
                &[
                    ImageEdit::SetRating {
                        rating: ContentRating::Sensitive,
                    },
                    ImageEdit::Delete,
                ],
            )
            .unwrap();
        let mut pins = [
            self.pin(&self.main, &self.main_images[0], Some(region()), 10),
            self.pin(&self.old, &self.old_images[0], None, 400),
        ];
        self.groups.create("眼睛参考", &mut pins).unwrap();
        let mut only_main = [self.pin(&self.main, &self.main_images[1], None, 30)];
        self.groups.create("光照", &mut only_main).unwrap();
    }

    fn backup(&self, target: &BackupTarget, when: Stamp) -> kinshoko_core::backup::BackupReport {
        let registry = self.registry();
        let scope = compute_scope(
            &registry,
            &self.groups.list().unwrap(),
            &ScopeSelection::All,
        );
        target
            .run(
                &scope,
                &BackupSources {
                    libraries: &registry,
                    groups: &self.groups,
                },
                when,
                &mut |_| {},
            )
            .unwrap()
    }
}

fn region() -> Region {
    Region {
        x: 2,
        y: 1,
        width: 8,
        height: 6,
    }
}

fn target(dir: &Path) -> BackupTarget {
    let path = dir.join("移动盘");
    std::fs::create_dir_all(&path).unwrap();
    BackupTarget::new(&path)
}

#[test]
fn a_group_that_outgrows_the_computed_scope_cannot_publish_a_complete_backup() {
    let device = Device::new();
    let group = device
        .groups
        .create(
            "范围会变化",
            &mut [device.pin(&device.main, &device.main_images[0], None, 10)],
        )
        .unwrap();
    let registry = device.registry();
    let selection = ScopeSelection::Libraries {
        ids: vec![device.main.info().id.clone()],
        include_linked: true,
    };
    let scope = compute_scope(&registry, &device.groups.list().unwrap(), &selection);
    assert_eq!(scope.libraries.len(), 1);
    device
        .groups
        .save_pins(
            &group.id,
            &mut [device.pin(&device.old, &device.old_images[0], None, 40)],
        )
        .unwrap();
    let backups = tempfile::tempdir().unwrap();
    let target = target(backups.path());
    let sources = BackupSources {
        libraries: &registry,
        groups: &device.groups,
    };
    let stale = target.run(&scope, &sources, at(0, 3), &mut |_| {}).unwrap();
    assert!(!stale.complete, "新增依赖未覆盖时不能发布完整快照");
    assert!(!stale.problems.is_empty());
    assert!(target.snapshots().unwrap().is_empty());
    let fresh = compute_scope(&registry, &device.groups.list().unwrap(), &selection);
    let retried = target.run(&fresh, &sources, at(0, 4), &mut |_| {}).unwrap();
    assert!(retried.complete, "重新计算范围后可正常备份");
    let restored = target
        .restore(
            &retried.snapshot_id,
            &device.dir.path().join("恢复"),
            &device.groups,
            at(1, 1),
        )
        .unwrap();
    assert!(restored.check.passed(), "{:?}", restored.check);
}

#[test]
fn editing_a_group_while_copying_keeps_the_backup_references_consistent() {
    let device = Device::new();
    let group = device
        .groups
        .create(
            "正在使用",
            &mut [device.pin(&device.main, &device.main_images[0], None, 10)],
        )
        .unwrap();
    let registry = device.registry();
    let scope = compute_scope(
        &registry,
        &device.groups.list().unwrap(),
        &ScopeSelection::All,
    );
    let target = target(device.dir.path());
    let mut changed = false;
    let report = target
        .run(
            &scope,
            &BackupSources {
                libraries: &registry,
                groups: &device.groups,
            },
            at(0, 3),
            &mut |_| {
                if changed {
                    return;
                }
                changed = true;
                let added = import(&device.main, &device.dir.path().join("later"), &[29]);
                device
                    .groups
                    .save_pins(
                        &group.id,
                        &mut [device.pin(&device.main, &added[0], None, 200)],
                    )
                    .unwrap();
            },
        )
        .unwrap();
    assert!(report.complete, "{:?}", report.problems);
    let restored = target
        .restore(
            &report.snapshot_id,
            &device.dir.path().join("restored"),
            &device.groups,
            at(1, 3),
        )
        .unwrap();
    assert!(restored.check.passed(), "{:?}", restored.check);
    let saved = device.groups.get(&restored.groups[0].id).unwrap();
    assert_eq!(saved.members.len(), 1);
    assert_eq!(saved.members[0].image_id, device.main_images[0]);
}

#[test]
fn a_restored_backup_is_an_independent_copy_and_passes_the_round_trip_check() {
    let device = Device::new();
    device.curate();
    let backups = tempfile::tempdir().unwrap();
    let target = target(backups.path());
    let report = device.backup(&target, at(0, 3));
    assert!(report.complete, "备份完成：{:?}", report.problems);

    let snapshots = target.snapshots().unwrap();
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].id, report.snapshot_id);

    let existing_groups: BTreeSet<_> = device
        .groups
        .list()
        .unwrap()
        .into_iter()
        .map(|g| g.id)
        .collect();
    let restored_into = device.dir.path().join("恢复");
    let restored = target
        .restore(
            &report.snapshot_id,
            &restored_into,
            &device.groups,
            at(1, 1),
        )
        .unwrap();

    // 恢复后自动运行的往返检查：原图哈希、整理信息、参考组都一致。
    assert!(restored.check.passed(), "往返检查：{:?}", restored.check);
    assert_eq!(restored.check.originals.checked, 5);
    assert_eq!(restored.check.groups.checked, 2);

    // 新的资料库身份，记录从哪个备份恢复；参考图身份不变。
    assert_eq!(restored.libraries.len(), 2);
    let main = restored
        .libraries
        .iter()
        .find(|l| l.old_id == device.main.info().id)
        .unwrap();
    assert_ne!(main.library.id, device.main.info().id);
    assert!(main.library.root.starts_with(&restored_into));
    let copy = Library::open(&main.library.root).unwrap();
    copy.set_safe_mode(false);
    let provenance = copy.restore_provenance().unwrap();
    assert_eq!(provenance.len(), 1);
    assert_eq!(provenance[0].old_library_id, device.main.info().id);
    assert_eq!(provenance[0].backup_id, report.snapshot_id);
    for id in &device.main_images {
        assert_eq!(copy.image(id).unwrap(), device.main.image(id).unwrap());
    }
    assert!(
        copy.image(&device.main_images[2])
            .unwrap()
            .deleted_at
            .is_some(),
        "回收站里的图也在备份中"
    );
    // 个人近似对应表一起往返。
    assert_eq!(
        copy.personal_approx(ZH).unwrap(),
        device.main.personal_approx(ZH).unwrap()
    );

    // 参考组是独立副本：新身份、记录恢复来源、成员改连恢复出的库，局部与摆放不变；现有参考组不动。
    let all = device.groups.list().unwrap();
    assert_eq!(all.len(), 4);
    for summary in all.iter().filter(|g| !existing_groups.contains(&g.id)) {
        let group = device.groups.get(&summary.id).unwrap();
        let from = group.restored_from.as_ref().expect("记录恢复来源");
        assert_eq!(from.backup_id, report.snapshot_id);
        let before = device.groups.get(&from.group_id).unwrap();
        assert_eq!(group.name, before.name);
        assert_eq!(group.members.len(), before.members.len());
        for (after, before) in group.members.iter().zip(&before.members) {
            let mapped = restored
                .libraries
                .iter()
                .find(|l| l.old_id == before.library_id)
                .unwrap();
            assert_eq!(after.library_id, mapped.library.id);
            assert_eq!(after.image_id, before.image_id);
            assert_eq!(after.crop, before.crop);
            assert_eq!(after.placement, before.placement);
        }
    }
}

#[test]
fn a_later_backup_copies_only_the_new_originals_and_holds_the_originals_lease_while_copying() {
    let device = Device::new();
    let backups = tempfile::tempdir().unwrap();
    let target = target(backups.path());
    let first = device.backup(&target, at(0, 3));
    assert_eq!((first.copied, first.reused), (5, 0));

    import(&device.main, &device.dir.path().join("in2"), &[4]);
    let registry = device.registry();
    let scope = compute_scope(
        &registry,
        &device.groups.list().unwrap(),
        &ScopeSelection::All,
    );
    let mut leased_during = Vec::new();
    let second = target
        .run(
            &scope,
            &BackupSources {
                libraries: &registry,
                groups: &device.groups,
            },
            at(1, 3),
            &mut |_| {
                leased_during.push((
                    device.main.originals_leased(),
                    device.old.originals_leased(),
                ))
            },
        )
        .unwrap();
    assert!(second.complete);
    assert_eq!((second.copied, second.reused), (1, 5), "只复制新增的原图");
    assert!(
        leased_during.iter().all(|&(a, b)| a && b),
        "复制原文件期间持有租约，原文件不会被清理"
    );
    assert!(!device.main.originals_leased(), "备份结束放下租约");
    assert_eq!(target.snapshots().unwrap().len(), 2);
}

/// 备份期间永久删除（#67）：参考图记录照常删掉，原文件留到租约放下之后再清除，快照完整。
#[test]
fn a_permanent_delete_during_a_backup_does_not_remove_the_original_until_the_backup_ends() {
    let device = Device::new();
    let backups = tempfile::tempdir().unwrap();
    let target = target(backups.path());
    let victim = device.main_images[0].clone();
    let original = device.main.original_path(&victim).unwrap();
    device
        .main
        .edit(std::slice::from_ref(&victim), &[ImageEdit::Delete])
        .unwrap();
    let registry = device.registry();
    let scope = compute_scope(
        &registry,
        &device.groups.list().unwrap(),
        &ScopeSelection::All,
    );
    let mut deleted = false;
    let report = target
        .run(
            &scope,
            &BackupSources {
                libraries: &registry,
                groups: &device.groups,
            },
            at(0, 3),
            &mut |progress| {
                if progress.done == 0 && !deleted {
                    deleted = true;
                    let ids = std::slice::from_ref(&victim);
                    let preview = device
                        .main
                        .preview_permanent_delete(ids, &device.groups)
                        .unwrap();
                    device
                        .main
                        .permanent_delete(ids, &preview.token, &device.groups)
                        .unwrap();
                    assert!(original.exists(), "租约期间原文件不清除");
                }
            },
        )
        .unwrap();
    assert!(deleted);
    assert!(report.complete, "{:?}", report.problems);
    assert_eq!(report.copied, 5, "快照里的原图都复制到了");
    drop(device.main);
    Library::open(&device.dir.path().join("主库")).unwrap();
    assert!(!original.exists(), "租约放下后清除");
}

#[test]
fn snapshots_are_kept_seven_daily_and_four_weekly() {
    let device = Device::new();
    let backups = tempfile::tempdir().unwrap();
    let target = target(backups.path());
    // 连续 40 天每天 11:00（东八区）备份，最后一天另外手动备份两次。
    for day in 0..40 {
        device.backup(&target, at(day, 3));
    }
    device.backup(&target, at(39, 5));
    let last = device.backup(&target, at(39, 7));

    let snapshots = target.snapshots().unwrap();
    let kept: Vec<String> = snapshots
        .iter()
        .map(|s| s.created_at.local_date())
        .collect();
    // 第 39 天是 2026-11-13（星期五）。每日：11-07…11-13 各一份（11-13 留最新那份）；
    // 每周：之前 4 周各留最新一份——11-01（周日）、10-25、10-18、10-11。
    assert_eq!(
        kept,
        [
            "2026-11-13",
            "2026-11-12",
            "2026-11-11",
            "2026-11-10",
            "2026-11-09",
            "2026-11-08",
            "2026-11-07",
            "2026-11-01",
            "2026-10-25",
            "2026-10-18",
            "2026-10-11",
        ]
    );
    assert_eq!(snapshots[0].id, last.snapshot_id, "同一天留最新的一份");
    assert!(!last.removed_snapshots.is_empty());
}

#[test]
fn an_original_changed_outside_kinshoko_leaves_the_backup_incomplete_and_unrestorable() {
    let device = Device::new();
    let backups = tempfile::tempdir().unwrap();
    let target = target(backups.path());
    let path = device.main.original_path(&device.main_images[0]).unwrap();
    let mut bytes = std::fs::read(&path).unwrap();
    let n = bytes.len();
    bytes[n - 20] ^= 0xff;
    std::fs::write(&path, bytes).unwrap();

    let report = device.backup(&target, at(0, 3));
    assert!(!report.complete);
    assert_eq!(report.problems.len(), 1, "{:?}", report.problems);
    assert!(target.snapshots().unwrap().is_empty(), "不完整的快照不列出");
    let err = target
        .restore(
            &report.snapshot_id,
            &device.dir.path().join("恢复"),
            &device.groups,
            at(1, 1),
        )
        .unwrap_err();
    assert!(matches!(err, BackupError::Incomplete(_)), "{err}");
}

#[test]
fn a_damaged_backup_is_refused_without_leaving_half_a_library() {
    let device = Device::new();
    device.curate();
    let backups = tempfile::tempdir().unwrap();
    let target = target(backups.path());
    let report = device.backup(&target, at(0, 3));
    // 备份目标里的原文件坏了。
    let store = backups.path().join("移动盘/kinshoko-backup/originals");
    for shard in std::fs::read_dir(&store).unwrap() {
        for file in std::fs::read_dir(shard.unwrap().path()).unwrap() {
            std::fs::write(file.unwrap().path(), b"broken").unwrap();
        }
    }

    let groups_before = device.groups.list().unwrap().len();
    let into = device.dir.path().join("恢复");
    assert!(
        target
            .restore(&report.snapshot_id, &into, &device.groups, at(1, 1))
            .is_err()
    );
    assert_eq!(device.groups.list().unwrap().len(), groups_before);
    let leftovers = std::fs::read_dir(&into).map(|d| d.count()).unwrap_or(0);
    assert_eq!(leftovers, 0, "恢复失败不留下半个资料库");
}

#[test]
fn a_missing_target_is_reported_and_a_library_on_an_unplugged_drive_is_skipped() {
    let device = Device::new();
    let backups = tempfile::tempdir().unwrap();
    let missing = BackupTarget::new(&backups.path().join("没插的移动盘"));
    let registry = device.registry();
    let scope = compute_scope(
        &registry,
        &device.groups.list().unwrap(),
        &ScopeSelection::All,
    );
    let sources = BackupSources {
        libraries: &registry,
        groups: &device.groups,
    };
    let err = missing
        .run(&scope, &sources, at(0, 3), &mut |_| {})
        .unwrap_err();
    assert!(matches!(err, BackupError::TargetUnavailable(_)));
    assert!(
        !backups.path().join("没插的移动盘").exists(),
        "不在别处建立目标"
    );

    let mut moved = registry.clone();
    moved[1].root = device.dir.path().join("拔掉的盘/旧库");
    let report = target(backups.path())
        .run(
            &scope,
            &BackupSources {
                libraries: &moved,
                groups: &device.groups,
            },
            at(0, 3),
            &mut |_| {},
        )
        .unwrap();
    assert!(report.complete);
    assert_eq!(report.skipped.len(), 1);
    assert_eq!(report.skipped[0].library.name, "旧库");
}

#[test]
fn the_capacity_estimate_counts_only_what_the_target_does_not_have_yet() {
    let device = Device::new();
    let backups = tempfile::tempdir().unwrap();
    let target = target(backups.path());
    let registry = device.registry();
    let scope = compute_scope(
        &registry,
        &device.groups.list().unwrap(),
        &ScopeSelection::All,
    );
    let sources = BackupSources {
        libraries: &registry,
        groups: &device.groups,
    };
    let before = target.estimate(&scope, &sources).unwrap();
    assert_eq!((before.originals, before.new_originals), (5, 5));
    assert!(before.total_bytes > 0 && before.new_bytes == before.total_bytes);
    device.backup(&target, at(0, 3));
    let after = target.estimate(&scope, &sources).unwrap();
    assert_eq!(after.new_originals, 0);
    assert!(after.new_bytes < before.new_bytes);
}
