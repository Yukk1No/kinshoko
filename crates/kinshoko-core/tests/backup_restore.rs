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
        .restore(&report.snapshot_id, &restored_into, &device.groups, at(1, 1))
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
        copy.image(&device.main_images[2]).unwrap().deleted_at.is_some(),
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
