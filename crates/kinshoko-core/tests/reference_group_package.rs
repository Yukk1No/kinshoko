//! 参考组包（#68，ADR-0002）：把参考组连同所用原图与标签、备注、来源、分级的快照导出成一个文件，
//! 在别的电脑上导入后直接可用。#8 中参考组包的往返检查改写为这里的核心 crate 测试：
//! 原文件 SHA-256 一致、同一原图只带一次、不带来源库其他素材、带上整理信息快照、
//! 另存为新组时生成新身份而成员与布局逐字一致。用临时目录里的真资料库，经对外接口。

#[allow(dead_code)]
#[path = "support/eagle.rs"]
mod eagle;

use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use image::RgbaImage;
use kinshoko_core::desktop::{Placement, Region, SavedPin, Turn};
use kinshoko_core::library::{
    ContentRating, FactSource, ImageEdit, ImportOutcome, ImportSource, ReferenceLens, TagEdit,
    TagNamespace, TagRef,
};
use kinshoko_core::reference_groups::{
    DetachedLenses, GroupError, MemberState, ReferenceGroup, ReferenceGroups, References, resolve,
};
use kinshoko_core::{Library, RegisteredLibrary};
use sha2::{Digest, Sha256};

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn import(library: &Library, dir: &Path, seed: u8, n: u8) -> Vec<String> {
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

fn registered(library: &Library) -> RegisteredLibrary {
    RegisteredLibrary {
        id: library.info().id.clone(),
        name: library.info().name.clone(),
        root: library.info().root.clone(),
    }
}

fn pin(lens: &ReferenceLens, image_id: &str, crop: Option<Region>, x: i32) -> SavedPin {
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
struct Studio {
    dir: tempfile::TempDir,
    a: Library,
    a_lens: ReferenceLens,
    a_images: Vec<String>,
    b_images: Vec<String>,
    registry: Vec<RegisteredLibrary>,
    groups: ReferenceGroups,
    group: ReferenceGroup,
    detached: DetachedLenses,
}

impl Studio {
    fn new() -> Studio {
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

    fn refs(&self) -> References<'_> {
        References {
            current: Some(self.a_lens.clone()),
            registry: &self.registry,
            detached: &self.detached,
            safe_mode: true,
        }
    }

    fn package_path(&self) -> PathBuf {
        self.dir.path().join("导出").join("眼睛参考.kinshoko-group")
    }

    fn export(&self) -> PathBuf {
        let out = self.package_path();
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        self.groups
            .export_package(&self.group.id, &self.refs(), &out)
            .unwrap();
        self.detached.clear();
        out
    }

    fn original_sha(&self, library: &str, image_id: &str) -> String {
        let refs = self.refs();
        let lens = kinshoko_core::reference_groups::ReferenceSource::lens(&refs, library).unwrap();
        let sha = sha256(&std::fs::read(lens.original_path(image_id).unwrap()).unwrap());
        self.detached.clear();
        sha
    }
}

/// 另一台电脑：一个全新的资料库与参考组目录，不认识画师电脑上的任何资料库。
struct OtherComputer {
    _dir: tempfile::TempDir,
    library: Library,
    lens: ReferenceLens,
    registry: Vec<RegisteredLibrary>,
    groups: ReferenceGroups,
    detached: DetachedLenses,
}

impl OtherComputer {
    fn new() -> OtherComputer {
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

    fn refs(&self) -> References<'_> {
        References {
            current: Some(self.lens.clone()),
            registry: &self.registry,
            detached: &self.detached,
            safe_mode: true,
        }
    }
}

fn zip_entries(path: &Path) -> Vec<(String, Vec<u8>)> {
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

#[test]
fn imported_package_group_is_usable_elsewhere_with_identical_originals_and_layout() {
    let studio = Studio::new();
    let package = studio.export();

    let other = OtherComputer::new();
    let imported = other
        .groups
        .import_package(&package, &other.library)
        .unwrap();

    // 另存为新组：新身份；成员、局部与摆放逐字一致，只是改指向导入它的资料库。
    assert_ne!(imported.id, studio.group.id);
    assert_eq!(imported.name, studio.group.name);
    assert_eq!(imported.members.len(), studio.group.members.len());
    for (new, old) in imported.members.iter().zip(&studio.group.members) {
        assert_eq!(new.id, old.id);
        assert_eq!(new.crop, old.crop);
        assert_eq!(new.placement, old.placement);
        assert_eq!(
            (new.source_width, new.source_height),
            (old.source_width, old.source_height)
        );
        assert_eq!(new.library_id, other.library.info().id);
        // 原图 SHA-256 与导出前一致。
        let after =
            sha256(&std::fs::read(other.lens.original_path(&new.image_id).unwrap()).unwrap());
        assert_eq!(after, studio.original_sha(&old.library_id, &old.image_id));
    }
    // 同一张图的两块局部仍指向同一张参考图。
    assert_eq!(imported.members[0].image_id, imported.members[1].image_id);
    // 导入记录 imported_from_package。
    let provenance = imported.imported_from_package.as_ref().unwrap();
    assert_eq!(provenance.group_id, studio.group.id);
    // 参考组存进了本机的参考组目录，每个成员都能显示（分级随快照带来，安全模式下原位遮蔽）。
    let reread = other.groups.get(&imported.id).unwrap();
    assert_eq!(reread, imported);
    let states: Vec<MemberState> = resolve(&reread, &other.refs())
        .into_iter()
        .map(|m| m.state)
        .collect();
    assert_eq!(
        states,
        vec![
            MemberState::Available { sealed: true },
            MemberState::Available { sealed: true },
            MemberState::Available { sealed: false },
            MemberState::Available { sealed: false },
        ]
    );
    assert_eq!(reread.pins().len(), 4);
}

fn image_count(library: &Library) -> u32 {
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

#[test]
fn package_carries_only_used_originals_once_with_snapshots_of_their_organisation() {
    let studio = Studio::new();
    let package = studio.export();

    let entries = zip_entries(&package);
    let used = [
        studio.original_sha(&studio.a.info().id, &studio.a_images[0]),
        studio.original_sha(&studio.a.info().id, &studio.a_images[1]),
        studio.original_sha(&studio.registry[1].id, &studio.b_images[0]),
    ];
    // 4 个成员、3 张原图：同一原图只带一次；原文件逐字节放进包里。
    let originals: BTreeSet<String> = entries
        .iter()
        .filter(|(n, _)| n != "manifest.json")
        .map(|(n, bytes)| {
            assert!(n.starts_with("originals/"), "包里只有清单与原图：{n}");
            sha256(bytes)
        })
        .collect();
    assert_eq!(entries.len(), 4);
    assert_eq!(originals, used.iter().cloned().collect());
    // 不带来源库的其他素材。
    for unused in [
        studio.original_sha(&studio.a.info().id, &studio.a_images[2]),
        studio.original_sha(&studio.registry[1].id, &studio.b_images[1]),
    ] {
        assert!(!originals.contains(&unused));
    }

    let manifest = kinshoko_core::reference_groups::read_package(&package).unwrap();
    assert_eq!(manifest.group, studio.group);
    assert_eq!(manifest.images.len(), 3);
    let snap = |image_id: &str| {
        manifest
            .images
            .iter()
            .find(|i| i.image_id == image_id)
            .unwrap()
            .snapshot
            .clone()
    };
    // 画师的人工备注、人工标签、人工分级，以及 Eagle 来源的标签。
    let first = snap(&studio.a_images[0]);
    assert_eq!(first.note.as_deref(), Some("左眼的高光"));
    assert_eq!(first.rating, Some(ContentRating::Explicit));
    assert!(
        first
            .tags
            .iter()
            .any(|t| t.namespace == TagNamespace::Character
                && t.names.iter().any(|n| n.name == "初音未来"))
    );
    assert!(
        first
            .tags
            .iter()
            .any(|t| t.names.iter().any(|n| n.name == "蓝发"))
    );
    // Eagle 来源的备注、链接与模型标签。
    let second = snap(&studio.a_images[1]);
    assert_eq!(second.note.as_deref(), Some("看高光1"));
    assert_eq!(
        second.source_links,
        vec!["https://example.com/1".to_owned()]
    );
    assert!(
        second
            .tags
            .iter()
            .any(|t| t.external == vec!["blue_eyes".to_owned()])
    );
    assert_eq!(second.original_name, "图0001");
}

#[test]
fn importing_writes_the_snapshot_as_a_package_source_layer_and_reimport_does_not_duplicate() {
    let studio = Studio::new();
    let package = studio.export();
    let other = OtherComputer::new();
    other.library.set_safe_mode(false);

    let first = other
        .groups
        .import_package(&package, &other.library)
        .unwrap();
    let again = other
        .groups
        .import_package(&package, &other.library)
        .unwrap();

    // 重新导入同一个包：另存为另一个参考组，但原图合并到已进库的参考图上，不重复建图。
    assert_ne!(first.id, again.id);
    let ids = |g: &ReferenceGroup| {
        g.members
            .iter()
            .map(|m| m.image_id.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&first), ids(&again));
    assert_eq!(image_count(&other.library), 3);

    let eye = &first.members[0].image_id;
    let detail = other.library.image(eye).unwrap();
    assert_eq!(detail.note.manual, None);
    assert_eq!(detail.note.sources.len(), 1);
    assert_eq!(detail.note.sources[0].text, "左眼的高光");
    assert!(detail.note.sources[0].source.starts_with("package:"));
    assert_eq!(detail.original_name, "图0000");
    assert_eq!(
        other.library.image_rating(eye).unwrap().effective,
        Some(ContentRating::Explicit)
    );
    let tags = other.library.image_tags(eye, "zh-CN").unwrap();
    assert!(
        tags.tags
            .iter()
            .any(|t| t.tag.name == "初音未来" && t.tag.namespace == TagNamespace::Character)
    );

    let hair = &first.members[2].image_id;
    let detail = other.library.image(hair).unwrap();
    assert_eq!(
        detail.source_links,
        vec!["https://example.com/1".to_owned()]
    );
    let tags = other.library.image_tags(hair, "zh-CN").unwrap();
    assert!(tags.tags.iter().any(|t| t.tag.has_external));
}

#[test]
fn importing_merges_into_an_existing_identical_original_without_touching_manual_organisation() {
    let studio = Studio::new();
    let package = studio.export();
    let other = OtherComputer::new();
    other.library.set_safe_mode(false);
    // 另一台电脑上已经有 B 的第 0 张（字节相同），画师在那里写过备注。
    let copy = studio.dir.path().join("copy.png");
    {
        let refs = studio.refs();
        let b_lens =
            kinshoko_core::reference_groups::ReferenceSource::lens(&refs, &studio.registry[1].id)
                .unwrap();
        std::fs::copy(b_lens.original_path(&studio.b_images[0]).unwrap(), &copy).unwrap();
        studio.detached.clear();
    }
    let report = other
        .library
        .import(ImportSource { paths: vec![copy] })
        .wait();
    let existing = match &report.items[0].outcome {
        ImportOutcome::Imported { image_id } => image_id.clone(),
        other => panic!("{other:?}"),
    };
    other
        .library
        .edit(
            std::slice::from_ref(&existing),
            &[ImageEdit::SetNote {
                text: "本机的备注".into(),
            }],
        )
        .unwrap();

    let group = other
        .groups
        .import_package(&package, &other.library)
        .unwrap();

    assert_eq!(group.members[3].image_id, existing);
    assert_eq!(image_count(&other.library), 3);
    let detail = other.library.image(&existing).unwrap();
    assert_eq!(detail.note.manual.as_deref(), Some("本机的备注"));
}

#[test]
fn damaged_package_is_refused_before_anything_is_written() {
    let studio = Studio::new();
    let package = studio.export();
    // 把包里的一张原图换成别的字节，清单不变。
    let tampered = studio.dir.path().join("坏包.kinshoko-group");
    {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&tampered).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let mut tampered_one = false;
        for (name, mut bytes) in zip_entries(&package) {
            if name.starts_with("originals/") && !tampered_one {
                let at = bytes.len() - 20;
                bytes[at] ^= 0xff;
                tampered_one = true;
            }
            zip.start_file(name, options).unwrap();
            std::io::Write::write_all(&mut zip, &bytes).unwrap();
        }
        zip.finish().unwrap();
    }
    let other = OtherComputer::new();
    other.library.set_safe_mode(false);

    let result = other.groups.import_package(&tampered, &other.library);

    assert!(
        matches!(result, Err(GroupError::PackageDamaged(_))),
        "{result:?}"
    );
    assert!(other.groups.list().unwrap().is_empty());
    assert_eq!(image_count(&other.library), 0);
    // 不是参考组包的文件。
    let not_a_package = studio.dir.path().join("随便.png");
    std::fs::write(&not_a_package, b"not a zip").unwrap();
    assert_eq!(
        other.groups.import_package(&not_a_package, &other.library),
        Err(GroupError::NotAPackage)
    );
}

#[test]
fn export_is_refused_when_a_member_original_is_unavailable() {
    let studio = Studio::new();
    // B 不在本设备的登记中：B 的成员取不到原图。
    let registry = vec![studio.registry[0].clone()];
    let refs = References {
        current: Some(studio.a_lens.clone()),
        registry: &registry,
        detached: &studio.detached,
        safe_mode: true,
    };
    let out = studio.package_path();
    std::fs::create_dir_all(out.parent().unwrap()).unwrap();

    let result = studio.groups.export_package(&studio.group.id, &refs, &out);

    match result {
        Err(GroupError::MembersUnavailable(members)) => {
            assert_eq!(members.len(), 1, "{members:?}");
            assert!(members[0].contains(&studio.group.members[3].id));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        std::fs::read_dir(out.parent().unwrap()).unwrap().count(),
        0,
        "不写包，也不留临时文件"
    );
}

#[test]
fn package_import_uses_the_bound_destination_for_every_member_original() {
    use kinshoko_core::library::{BrowseQuery, BrowseScope, SaveDestination};
    let studio = Studio::new();
    let package = studio.export();
    let other = OtherComputer::new();
    other.library.set_safe_mode(false);
    let folder = other.library.create_folder("包的最终位置", None).unwrap();
    let destination = SaveDestination {
        library_id: other.library.info().id.clone(),
        folder_id: Some(folder.clone()),
    };
    let bound = other.library.for_destination(&destination).unwrap();
    let group = other.groups.import_package(&package, &bound).unwrap();
    assert!(
        group
            .members
            .iter()
            .all(|m| m.library_id == other.library.info().id)
    );
    let page = other
        .library
        .browse(&BrowseQuery {
            scope: BrowseScope::Folder { id: folder },
            conditions: Default::default(),
            cursor: None,
            limit: 100,
            thumbnail_px: 256,
        })
        .unwrap();
    assert_eq!(page.total, 3);
    assert_eq!(image_count(&other.library), 3);
}

/// Package snapshots and cross-library copy both merge suggested ratings into existing content.
/// The app's final clipboard commit uses the same gate as this real destination library.
fn assert_rating_publication_waits_for_final_commit(copy: bool) {
    use std::sync::{Arc, Barrier, Mutex, mpsc};
    use std::time::Duration;

    let studio = Studio::new();
    let package = studio.export();
    let other = OtherComputer::new();
    other.library.set_safe_mode(false);
    let source_id = &studio.a_images[0];
    let original = studio.a_lens.original_path(source_id).unwrap();
    let report = other
        .library
        .import(ImportSource {
            paths: vec![original],
        })
        .wait();
    let target_id = report.items[0].outcome.image_id().unwrap().to_owned();
    assert_eq!(
        other.library.image_rating(&target_id).unwrap().effective,
        None
    );

    let gate = Arc::new(Mutex::new(()));
    other.library.use_package_publication_gate(gate.clone());
    let ready = Arc::new(Barrier::new(2));
    let (done_tx, done_rx) = mpsc::channel();
    let permit = gate.lock().unwrap();
    let (finished_while_held, rating_while_held) = std::thread::scope(|scope| {
        let worker_ready = ready.clone();
        let target = &other;
        let source = &studio.a;
        let package = &package;
        let worker = scope.spawn(move || {
            worker_ready.wait();
            if copy {
                target.library.copy_from(source, source_id).unwrap();
            } else {
                target
                    .groups
                    .import_package(package, &target.library)
                    .unwrap();
            }
            let _ = done_tx.send(());
        });
        ready.wait();
        let finished = done_rx.recv_timeout(Duration::from_millis(300)).is_ok();
        let rating = other.library.image_rating(&target_id).unwrap().effective;
        drop(permit);
        worker.join().unwrap();
        (finished, rating)
    });
    assert_eq!(
        other.library.image_rating(&target_id).unwrap().effective,
        Some(ContentRating::Explicit)
    );
    assert!(
        !finished_while_held,
        "rating publication completed while final commit held the gate; effective while held: {rating_while_held:?}"
    );
    assert_eq!(
        rating_while_held, None,
        "existing content became sealed during another authorized final commit"
    );
}

#[test]
fn package_rating_publication_waits_for_the_final_visibility_commit() {
    assert_rating_publication_waits_for_final_commit(false);
}

#[test]
fn copied_rating_publication_waits_for_the_final_visibility_commit() {
    assert_rating_publication_waits_for_final_commit(true);
}

#[test]
fn imported_content_waits_for_definition_publication_before_saving_a_new_group() {
    let studio = Studio::new();
    let package = studio.export();
    let other = OtherComputer::new();
    other.library.set_safe_mode(false);
    let prepared = other
        .groups
        .prepare_package_import(&package, &other.library, None)
        .unwrap();
    assert!(other.groups.list().unwrap().is_empty());
    assert_eq!(
        other
            .library
            .browse(&kinshoko_core::library::BrowseQuery {
                scope: Default::default(),
                conditions: Default::default(),
                cursor: None,
                limit: 100,
                thumbnail_px: 100,
            })
            .unwrap()
            .total,
        3
    );
    // A failed application-definition publication drops this opaque result. Content remains
    // available for retry; no group file was saved prematurely.
    drop(prepared);
    assert!(other.groups.list().unwrap().is_empty());
    let imported = other
        .groups
        .prepare_package_import(&package, &other.library, None)
        .unwrap()
        .finish()
        .unwrap();
    assert_eq!(other.groups.list().unwrap().len(), 1);
    assert_eq!(imported.members.len(), studio.group.members.len());
}
