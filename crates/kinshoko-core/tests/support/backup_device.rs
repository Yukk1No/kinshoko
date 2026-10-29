//! Shared fixtures for the `backup_restore` integration tests.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use image::RgbaImage;
use kinshoko_core::approx::ApproxRelation;
use kinshoko_core::backup::{BackupSources, BackupTarget, ScopeSelection, Stamp, compute_scope};
use kinshoko_core::desktop::{Placement, Region, SavedPin};
use kinshoko_core::library::{
    ContentRating, ImageEdit, ImportOutcome, ImportSource, TagEdit, TagNamespace, TagRef,
};
use kinshoko_core::reference_groups::ReferenceGroups;
use kinshoko_core::{Library, RegisteredLibrary};

pub const ZH: &str = "zh-CN";
pub const DAY: i64 = 24 * 60 * 60 * 1000;
/// 2026-10-05（星期一）00:00 UTC。
pub const MONDAY: i64 = 1_791_158_400_000;

pub fn at(day: i64, hour: i64) -> Stamp {
    Stamp::new(MONDAY + day * DAY + hour * 60 * 60 * 1000, 8 * 60)
}

pub fn png(path: &Path, seed: u8) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    RgbaImage::from_fn(16, 9, |x, y| image::Rgba([seed, x as u8, y as u8, 255]))
        .save(path)
        .unwrap();
    path.to_path_buf()
}

pub fn import(library: &Library, dir: &Path, seeds: &[u8]) -> Vec<String> {
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

pub fn general(name: &str) -> TagRef {
    TagRef::Named {
        namespace: TagNamespace::General,
        name: name.into(),
        lang: ZH.into(),
    }
}

/// 本设备：两个资料库（主库、旧库）与一个跨库参考组、一个只引用主库的参考组。
pub struct Device {
    pub dir: tempfile::TempDir,
    pub main: Library,
    pub old: Library,
    pub main_images: Vec<String>,
    pub old_images: Vec<String>,
    pub groups: ReferenceGroups,
}

impl Device {
    pub fn new() -> Device {
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

    pub fn registry(&self) -> Vec<RegisteredLibrary> {
        [&self.main, &self.old]
            .iter()
            .map(|l| RegisteredLibrary {
                id: l.info().id.clone(),
                name: l.info().name.clone(),
                root: l.info().root.clone(),
            })
            .collect()
    }

    pub fn pin(&self, library: &Library, image: &str, crop: Option<Region>, x: i32) -> SavedPin {
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
    pub fn curate(&self) {
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

    pub fn backup(
        &self,
        target: &BackupTarget,
        when: Stamp,
    ) -> kinshoko_core::backup::BackupReport {
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

pub fn region() -> Region {
    Region {
        x: 2,
        y: 1,
        width: 8,
        height: 6,
    }
}

pub fn target(dir: &Path) -> BackupTarget {
    let path = dir.join("移动盘");
    std::fs::create_dir_all(&path).unwrap();
    BackupTarget::new(&path)
}
