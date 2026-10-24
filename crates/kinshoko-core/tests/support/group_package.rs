//! 参考组包测试的场景：画师的电脑（[`Studio`]）与另一台电脑（[`OtherComputer`]）。

#![allow(dead_code)]

use std::io::Read;
use std::path::{Path, PathBuf};

use image::RgbaImage;
use kinshoko_core::desktop::{Placement, Region, SavedPin, Turn};
use kinshoko_core::library::{
    ContentRating, FactSource, ImageEdit, ImportOutcome, ImportSource, ReferenceLens, TagEdit,
    TagNamespace, TagRef,
};
use kinshoko_core::reference_groups::{
    DetachedLenses, ReferenceGroup, ReferenceGroups, References,
};
use kinshoko_core::{Library, RegisteredLibrary};
use sha2::{Digest, Sha256};

use super::eagle;

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn import(library: &Library, dir: &Path, seed: u8, n: u8) -> Vec<String> {
    std::fs::create_dir_all(dir).unwrap();
    let paths: Vec<_> = (0..n)
        .map(|i| {
            let path = dir.join(format!("{seed}-{i}.png"));
            RgbaImage::from_fn(8, 6, |x, y| image::Rgba([seed, i, x as u8, y as u8]))
                .save(&path)
                .unwrap();
            path
        })
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

pub fn registered(library: &Library) -> RegisteredLibrary {
    RegisteredLibrary {
        id: library.info().id.clone(),
        name: library.info().name.clone(),
        root: library.info().root.clone(),
    }
}

pub fn pin(lens: &ReferenceLens, image_id: &str, crop: Option<Region>, x: i32) -> SavedPin {
    let image = lens.image(image_id).unwrap();
    let mut pin = SavedPin::reference(
        &format!("pin-{x}"),
        lens.library_id(),
        &image,
        crop,
        Placement {
            x,
            y: x / 2,
            scale: 1.5,
            ..Placement::default()
        },
    )
    .unwrap();
    pin.turn(Turn::FlipHorizontal);
    pin
}

/// 画师的电脑：活动资料库 A（Eagle 迁入，带标签、备注、来源链接），另有已关闭的资料库 B。
/// 参考组用了 A 的第 0 张两块局部、A 的第 1 张整图、B 的第 0 张；A 的第 2 张、B 的第 1 张没用到。
pub struct Studio {
    pub dir: tempfile::TempDir,
    pub a: Library,
    pub a_lens: ReferenceLens,
    pub a_images: Vec<String>,
    pub b_images: Vec<String>,
    pub registry: Vec<RegisteredLibrary>,
    pub groups: ReferenceGroups,
    pub group: ReferenceGroup,
    pub detached: DetachedLenses,
}

impl Studio {
    pub fn new() -> Studio {
        let dir = tempfile::tempdir().unwrap();
        let (b, b_images) = {
            let b = Library::create(&dir.path().join("lib-b"), "B").unwrap();
            b.set_safe_mode(false);
            let ids = import(&b, &dir.path().join("in-b"), 9, 2);
            (registered(&b), ids)
        };
        let fixture = eagle::build(&dir.path().join("主库.library"), "4.0.0", 3);
        let a = Library::create(&dir.path().join("lib-a"), "A").unwrap();
        a.set_safe_mode(false);
        let report = a
            .import(ImportSource {
                paths: vec![fixture.root.clone()],
            })
            .wait();
        let mut a_images: Vec<String> = report
            .items
            .iter()
            .map(|item| item.outcome.image_id().unwrap().to_owned())
            .collect();
        a_images.sort_by_key(|id| a.image(id).unwrap().original_name);
        // 画师在本库的整理：人工备注、人工标签、人工分级。
        a.edit(
            &a_images[..1],
            &[
                ImageEdit::SetNote {
                    text: "左眼的高光".into(),
                },
                ImageEdit::SetRating {
                    rating: ContentRating::Explicit,
                },
            ],
        )
        .unwrap();
        a.edit_tags(
            &a_images[..1],
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::Character,
                    name: "初音未来".into(),
                    lang: "zh-CN".into(),
                },
            }],
        )
        .unwrap();
        a.replace_source_tags(
            &FactSource::model("test"),
            &a_images[1],
            &[kinshoko_core::library::SourceTag {
                tag: TagRef::External {
                    namespace: TagNamespace::General,
                    name: "blue_eyes".into(),
                },
                score: Some(0.8),
            }],
        )
        .unwrap();
        let a_lens = a.take_reference_lens().unwrap();
        let registry = vec![registered(&a), b.clone()];
        let detached = DetachedLenses::default();
        let groups = ReferenceGroups::open(&dir.path().join("groups")).unwrap();
        let mut pins = {
            let refs = References {
                current: Some(a_lens.clone()),
                registry: &registry,
                detached: &detached,
                safe_mode: false,
            };
            let b_lens =
                kinshoko_core::reference_groups::ReferenceSource::lens(&refs, &b.id).unwrap();
            vec![
                pin(
                    &a_lens,
                    &a_images[0],
                    Some(Region {
                        x: 1,
                        y: 1,
                        width: 5,
                        height: 4,
                    }),
                    10,
                ),
                pin(
                    &a_lens,
                    &a_images[0],
                    Some(Region {
                        x: 6,
                        y: 2,
                        width: 4,
                        height: 3,
                    }),
                    40,
                ),
                pin(&a_lens, &a_images[1], None, 80),
                pin(&b_lens, &b_images[0], None, 120),
            ]
        };
        let group = groups.create("眼睛参考", &mut pins).unwrap();
        detached.clear();
        Studio {
            dir,
            a,
            a_lens,
            a_images,
            b_images,
            registry,
            groups,
            group,
            detached,
        }
    }

    pub fn refs(&self) -> References<'_> {
        References {
            current: Some(self.a_lens.clone()),
            registry: &self.registry,
            detached: &self.detached,
            safe_mode: true,
        }
    }

    pub fn package_path(&self) -> PathBuf {
        self.dir.path().join("导出").join("眼睛参考.kinshoko-group")
    }

    pub fn export(&self) -> PathBuf {
        let out = self.package_path();
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        self.groups
            .export_package(&self.group.id, &self.refs(), &out)
            .unwrap();
        self.detached.clear();
        out
    }

    pub fn original_sha(&self, library: &str, image_id: &str) -> String {
        let refs = self.refs();
        let lens = kinshoko_core::reference_groups::ReferenceSource::lens(&refs, library).unwrap();
        let sha = sha256(&std::fs::read(lens.original_path(image_id).unwrap()).unwrap());
        self.detached.clear();
        sha
    }
}

/// 另一台电脑：一个全新的资料库与参考组目录，不认识画师电脑上的任何资料库。
pub struct OtherComputer {
    pub _dir: tempfile::TempDir,
    pub library: Library,
    pub lens: ReferenceLens,
    pub registry: Vec<RegisteredLibrary>,
    pub groups: ReferenceGroups,
    pub detached: DetachedLenses,
}

impl OtherComputer {
    pub fn new() -> OtherComputer {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::create(&dir.path().join("lib-c"), "C").unwrap();
        let lens = library.take_reference_lens().unwrap();
        let registry = vec![registered(&library)];
        let groups = ReferenceGroups::open(&dir.path().join("groups")).unwrap();
        OtherComputer {
            _dir: dir,
            library,
            lens,
            registry,
            groups,
            detached: DetachedLenses::default(),
        }
    }

    pub fn refs(&self) -> References<'_> {
        References {
            current: Some(self.lens.clone()),
            registry: &self.registry,
            detached: &self.detached,
            safe_mode: true,
        }
    }
}

pub fn zip_entries(path: &Path) -> Vec<(String, Vec<u8>)> {
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    (0..archive.len())
        .map(|i| {
            let mut entry = archive.by_index(i).unwrap();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            (entry.name().to_owned(), bytes)
        })
        .collect()
}

pub fn image_count(library: &Library) -> u32 {
    library
        .browse(&kinshoko_core::library::BrowseQuery {
            scope: Default::default(),
            conditions: Default::default(),
            cursor: None,
            limit: 100,
            thumbnail_px: 100,
        })
        .unwrap()
        .total
}
