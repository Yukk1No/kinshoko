//! 参考组包整理信息回归：经公共接口核对同字节去重后的各来源快照。

#[cfg(test)]
mod tests {
    use std::path::Path;

    use kinshoko_core::desktop::{Placement, SavedPin};
    use kinshoko_core::library::{
        ContentRating, ImageEdit, ImportSource, TagEdit, TagNamespace, TagRef,
    };
    use kinshoko_core::reference_groups::{
        DetachedLenses, ReferenceGroups, ReferenceSource, References,
    };
    use kinshoko_core::{Library, RegisteredLibrary};

    fn png(path: &Path, seed: u8) {
        image::RgbaImage::from_fn(8, 6, |x, y| image::Rgba([seed, x as u8, y as u8, 255]))
            .save(path)
            .unwrap();
    }

    fn import(library: &Library, path: &Path) -> String {
        library
            .import(ImportSource {
                paths: vec![path.to_owned()],
            })
            .wait()
            .items[0]
            .outcome
            .image_id()
            .unwrap()
            .to_owned()
    }

    fn registered(library: &Library) -> RegisteredLibrary {
        RegisteredLibrary {
            id: library.info().id.clone(),
            name: library.info().name.clone(),
            root: library.info().root.clone(),
        }
    }

    fn pin(library: &Library, image_id: &str, id: &str, x: i32) -> SavedPin {
        let registry = vec![registered(library)];
        let detached = DetachedLenses::default();
        let refs = References {
            current: None,
            registry: &registry,
            detached: &detached,
            safe_mode: false,
        };
        let lens = refs.lens(&library.info().id).unwrap();
        SavedPin::reference(
            id,
            &library.info().id,
            &lens.image(image_id).unwrap(),
            None,
            Placement {
                x,
                ..Placement::default()
            },
        )
        .unwrap()
    }

    fn named(name: &str) -> TagRef {
        TagRef::Named {
            namespace: TagNamespace::General,
            name: name.to_owned(),
            lang: "zh-CN".to_owned(),
        }
    }

    #[test]
    fn package_retains_each_library_snapshot_for_identical_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("same.png");
        png(&file, 3);
        let a = Library::create(&dir.path().join("a"), "A").unwrap();
        let b = Library::create(&dir.path().join("b"), "B").unwrap();
        a.set_safe_mode(false);
        b.set_safe_mode(false);
        let a_id = import(&a, &file);
        let b_id = import(&b, &file);
        for (lib, id, name, note, rating) in [
            (&a, &a_id, "A独有标签", "A备注", ContentRating::Explicit),
            (&b, &b_id, "B独有标签", "B备注", ContentRating::General),
        ] {
            lib.edit_tags(
                std::slice::from_ref(id),
                &[TagEdit::Add { tag: named(name) }],
            )
            .unwrap();
            lib.edit(
                std::slice::from_ref(id),
                &[
                    ImageEdit::SetNote {
                        text: note.to_owned(),
                    },
                    ImageEdit::SetRating { rating },
                ],
            )
            .unwrap();
        }
        let groups = ReferenceGroups::open(&dir.path().join("groups")).unwrap();
        let group = groups
            .create(
                "跨库同图",
                &mut [pin(&a, &a_id, "pin-a", 10), pin(&b, &b_id, "pin-b", 30)],
            )
            .unwrap();
        let registry = vec![registered(&a), registered(&b)];
        let detached = DetachedLenses::default();
        let refs = References {
            current: None,
            registry: &registry,
            detached: &detached,
            safe_mode: false,
        };
        let package = dir.path().join("same.kinshoko-group");
        let manifest = groups.export_package(&group.id, &refs, &package).unwrap();
        assert_eq!(manifest.images.len(), 2);
        assert_eq!(manifest.images[0].snapshot.note.as_deref(), Some("A备注"));
        assert_eq!(manifest.images[1].snapshot.note.as_deref(), Some("B备注"));

        let target = Library::create(&dir.path().join("target"), "Target").unwrap();
        target.set_safe_mode(false);
        let imported = groups.import_package(&package, &target).unwrap();
        assert_eq!(imported.members[0].image_id, imported.members[1].image_id);
        let id = &imported.members[0].image_id;
        let tags = target.image_tags(id, "zh-CN").unwrap();
        let names: Vec<_> = tags.tags.iter().map(|t| t.tag.name.as_str()).collect();
        let detail = target.image(id).unwrap();
        let notes: Vec<_> = detail
            .note
            .sources
            .iter()
            .map(|n| n.text.as_str())
            .collect();
        let rating = target.image_rating(id).unwrap().effective;
        assert!(
            names.contains(&"A独有标签") && names.contains(&"B独有标签"),
            "Both source snapshots must survive hash deduplication"
        );
        assert!(notes.contains(&"A备注") && notes.contains(&"B备注"));
        assert_eq!(rating, Some(ContentRating::Explicit));
    }

    #[test]
    fn package_retains_custom_localized_tag_names() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("one.png");
        png(&file, 9);
        let source = Library::create(&dir.path().join("source"), "Source").unwrap();
        source.set_safe_mode(false);
        let id = import(&source, &file);
        source
            .edit_tags(
                std::slice::from_ref(&id),
                &[TagEdit::Add {
                    tag: TagRef::External {
                        namespace: TagNamespace::General,
                        name: "blue_eyes".into(),
                    },
                }],
            )
            .unwrap();
        let tag_id = source.image_tags(&id, "en").unwrap().tags[0].tag.id.clone();
        source.rename_tag(&tag_id, "zh-CN", "我的蓝瞳名称").unwrap();
        source
            .add_tag_external(&tag_id, "custom_blue_eyes")
            .unwrap();
        let groups = ReferenceGroups::open(&dir.path().join("groups")).unwrap();
        let group = groups
            .create("自定名", &mut [pin(&source, &id, "pin", 0)])
            .unwrap();
        let registry = vec![registered(&source)];
        let detached = DetachedLenses::default();
        let refs = References {
            current: None,
            registry: &registry,
            detached: &detached,
            safe_mode: false,
        };
        let package = dir.path().join("custom.kinshoko-group");
        let manifest = groups.export_package(&group.id, &refs, &package).unwrap();
        assert!(
            manifest.images[0].snapshot.tags[0]
                .names
                .iter()
                .any(|n| n.name == "我的蓝瞳名称")
        );
        assert_eq!(manifest.images[0].snapshot.tags[0].external.len(), 2);
        let target = Library::create(&dir.path().join("target"), "Target").unwrap();
        target.set_safe_mode(false);
        let imported = groups.import_package(&package, &target).unwrap();
        let after = target
            .image_tags(&imported.members[0].image_id, "zh-CN")
            .unwrap();
        let vocab = target.vocabulary().unwrap();
        assert_eq!(
            after.tags[0].tag.name, "我的蓝瞳名称",
            "The exported localized name must survive import into a fresh library"
        );
        assert_eq!(vocab.tags[0].external.len(), 2);
    }
}
