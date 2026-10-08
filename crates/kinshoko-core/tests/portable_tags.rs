//! Portable content crosses public Library and TagCatalog actions, backed by real files.
use image::{Rgba, RgbaImage};
use kinshoko_core::library::{ImportSource, TagEdit, TagNamespace, TagRef};
use kinshoko_core::{Library, tag_catalog::TagCatalog};
use std::path::Path;

fn named_library(dir: &Path, name: &str) -> (Library, String, String) {
    let library = Library::create(&dir.join(name), name).unwrap();
    let png = dir.join(format!("{name}.png"));
    RgbaImage::from_pixel(12, 10, Rgba([20, 40, 60, 255]))
        .save(&png)
        .unwrap();
    let report = library.import(ImportSource { paths: vec![png] }).wait();
    let image = report.items[0].outcome.image_id().unwrap().to_owned();
    library
        .edit_tags(
            std::slice::from_ref(&image),
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: "白".into(),
                    lang: "zh-CN".into(),
                },
            }],
        )
        .unwrap();
    let tag = library.vocabulary().unwrap().tags[0].id.clone();
    (library, image, tag)
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

#[test]
fn first_tag_write_carries_identity_when_the_library_is_copied_to_a_fresh_application() {
    let dir = tempfile::tempdir().unwrap();
    let (library, image, local) = named_library(dir.path(), "source");
    let library_id = library.info().id.clone();
    let root = library.info().root.clone();
    let mut source_app = TagCatalog::open(&dir.path().join("source-app")).unwrap();
    let before = source_app.synchronize(&library).unwrap();
    let identity = before
        .mappings
        .iter()
        .find(|m| m.local_tag_id == local)
        .unwrap()
        .catalog_id
        .clone();
    drop(library);
    let copied = dir.path().join("copied");
    copy_tree(&root, &copied);
    let provider = Library::open_read_only(&copied, &library_id).unwrap();
    let mut new_app = TagCatalog::open(&dir.path().join("fresh-app")).unwrap();
    let after = new_app.synchronize(&provider).unwrap();
    assert_eq!(
        after.mappings[0].catalog_id, identity,
        "copying ordinary content must not invent another application tag identity"
    );
    assert_eq!(
        provider.image_tags(&image, "zh-CN").unwrap().tags[0]
            .tag
            .name,
        "白"
    );
}

use kinshoko_core::library::{LocalizedName, TagAlias};
use kinshoko_core::tag_catalog::CatalogCorrection;

#[test]
fn published_split_identity_survives_copy_without_exporting_the_application_name_preference() {
    let dir = tempfile::tempdir().unwrap();
    let (library, image, local) = named_library(dir.path(), "source");
    let id = library.info().id.clone();
    let root = library.info().root.clone();
    let mut app = TagCatalog::open(&dir.path().join("app")).unwrap();
    let split = app
        .correct(&library, &local, CatalogCorrection::Separate)
        .unwrap();
    let identity = split.mappings[0].catalog_id.clone();
    app.set_name_preference(
        &identity,
        &LocalizedName {
            lang: "zh-CN".into(),
            name: "我的私人显示名称".into(),
        },
    )
    .unwrap();
    app.add_alias(
        &identity,
        &TagAlias {
            lang: Some("zh-CN".into()),
            name: "雪".into(),
        },
    )
    .unwrap();
    app.publish_library_definitions(&library).unwrap();
    drop(library);
    let copied = dir.path().join("copied");
    copy_tree(&root, &copied);
    let provider = Library::open_read_only(&copied, &id).unwrap();
    let mut fresh = TagCatalog::open(&dir.path().join("fresh")).unwrap();
    let after = fresh.synchronize(&provider).unwrap();
    assert_eq!(
        after.mappings[0].catalog_id, identity,
        "explicit split must be carried by ordinary library content"
    );
    let tag = after.tags.iter().find(|t| t.id == identity).unwrap();
    assert_eq!(
        tag.default_names,
        [LocalizedName {
            lang: "zh-CN".into(),
            name: "白".into()
        }]
    );
    assert!(tag.name_preferences.is_empty());
    assert!(tag.aliases.iter().any(|a| a.name == "雪"));
    assert_eq!(provider.image_tags(&image, "zh-CN").unwrap().tags.len(), 1);
}

use kinshoko_core::RegisteredLibrary;
use kinshoko_core::desktop::{Placement, Region, SavedPin, Turn};
use kinshoko_core::reference_groups::{DetachedLenses, ReferenceGroups, References};

#[test]
fn package_import_preserves_shared_identity_and_target_preferences_without_merging_same_names() {
    let dir = tempfile::tempdir().unwrap();
    let (library, image, local) = named_library(dir.path(), "source");
    let mut app = TagCatalog::open(&dir.path().join("source-app")).unwrap();
    let split = app
        .correct(&library, &local, CatalogCorrection::Separate)
        .unwrap();
    let identity = split.mappings[0].catalog_id.clone();
    app.set_name_preference(
        &identity,
        &LocalizedName {
            lang: "zh-CN".into(),
            name: "源程序偏好".into(),
        },
    )
    .unwrap();
    app.add_alias(
        &identity,
        &TagAlias {
            lang: None,
            name: "雪".into(),
        },
    )
    .unwrap();
    let lens = library.take_reference_lens().unwrap();
    let mut pin = SavedPin::reference(
        "pin",
        lens.library_id(),
        &lens.image(&image).unwrap(),
        Some(Region {
            x: 1,
            y: 2,
            width: 5,
            height: 4,
        }),
        Placement {
            x: 100,
            y: 200,
            scale: 1.5,
            ..Placement::default()
        },
    )
    .unwrap();
    pin.turn(Turn::FlipHorizontal);
    pin.turn(Turn::RotateClockwise);
    let groups = ReferenceGroups::open(&dir.path().join("groups")).unwrap();
    let group = groups.create("测试参考组", &mut [pin]).unwrap();
    let registry = vec![RegisteredLibrary {
        id: library.info().id.clone(),
        name: "source".into(),
        root: library.info().root.clone(),
    }];
    let detached = DetachedLenses::default();
    let refs = References {
        current: Some(lens),
        registry: &registry,
        detached: &detached,
        safe_mode: true,
    };
    let path = dir.path().join("portable.kinshoko-group");
    groups
        .export_package_with_catalog(&group.id, &refs, &path, &app)
        .unwrap();

    let (target, _target_image, target_local) = named_library(dir.path(), "target");
    let mut target_app = TagCatalog::open(&dir.path().join("target-app")).unwrap();
    let existing = target_app.synchronize(&target).unwrap().mappings[0]
        .catalog_id
        .clone();
    target_app
        .set_name_preference(
            &existing,
            &LocalizedName {
                lang: "zh-CN".into(),
                name: "目标程序偏好".into(),
            },
        )
        .unwrap();
    let target_groups = ReferenceGroups::open(&dir.path().join("target-groups")).unwrap();
    let imported = target_groups
        .import_package_with_catalog(&path, &target, &mut target_app)
        .unwrap();
    let after = target_app.synchronize(&target).unwrap();
    assert_eq!(
        target_app
            .local_tag_ids(&target.info().id, &identity)
            .unwrap()
            .len(),
        1,
        "package must preserve explicit identity, not infer by its name"
    );
    assert_eq!(
        target_app
            .local_tag_ids(&target.info().id, &existing)
            .unwrap(),
        [target_local]
    );
    let dependency = after.tags.iter().find(|t| t.id == identity).unwrap();
    assert!(dependency.name_preferences.is_empty());
    assert_eq!(dependency.default_names[0].name, "白");
    assert!(dependency.aliases.iter().any(|a| a.name == "雪"));
    assert_eq!(
        after.tags.iter().find(|t| t.id == existing).unwrap().names[0].name,
        "目标程序偏好"
    );
    assert_eq!(imported.members[0].crop, group.members[0].crop);
    assert_eq!(imported.members[0].placement, group.members[0].placement);
    assert_eq!(
        imported.imported_from_package.as_ref().unwrap().group_id,
        group.id
    );
    target_app
        .set_name_preference(
            &identity,
            &LocalizedName {
                lang: "zh-CN".into(),
                name: "我在目标显示".into(),
            },
        )
        .unwrap();
    target_app
        .remove_alias(
            &identity,
            &TagAlias {
                lang: None,
                name: "雪".into(),
            },
        )
        .unwrap();
    target_groups
        .import_package_with_catalog(&path, &target, &mut target_app)
        .unwrap();
    let reread = target_app.inspect().unwrap();
    let kept = reread.tags.iter().find(|tag| tag.id == identity).unwrap();
    assert_eq!(kept.names[0].name, "我在目标显示");
    assert!(
        !kept.aliases.iter().any(|alias| alias.name == "雪"),
        "content import must not resurrect a locally removed alias"
    );
}

fn one_image_package(dir: &Path) -> std::path::PathBuf {
    let (library, image, _) = named_library(dir, "package-source");
    let lens = library.take_reference_lens().unwrap();
    let pin = SavedPin::reference(
        "fixture",
        lens.library_id(),
        &lens.image(&image).unwrap(),
        None,
        Placement::default(),
    )
    .unwrap();
    let groups = ReferenceGroups::open(&dir.join("package-groups")).unwrap();
    let group = groups.create("包", &mut [pin]).unwrap();
    let registered = [RegisteredLibrary {
        id: library.info().id.clone(),
        name: "包来源".into(),
        root: library.info().root.clone(),
    }];
    let detached = DetachedLenses::default();
    let refs = References {
        current: Some(lens),
        registry: &registered,
        detached: &detached,
        safe_mode: true,
    };
    let path = dir.join("fixture.kinshoko-group");
    groups.export_package(&group.id, &refs, &path).unwrap();
    path
}

fn rewrite_manifest(path: &Path, output: &Path, change: impl FnOnce(&mut serde_json::Value)) {
    use std::io::{Read, Write};
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut entries = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).unwrap();
        let mut data = Vec::new();
        entry.read_to_end(&mut data).unwrap();
        entries.push((entry.name().to_owned(), data));
    }
    let (_, data) = entries
        .iter_mut()
        .find(|(name, _)| name == "manifest.json")
        .unwrap();
    let mut manifest: serde_json::Value = serde_json::from_slice(data).unwrap();
    change(&mut manifest);
    *data = serde_json::to_vec(&manifest).unwrap();
    let mut writer = zip::ZipWriter::new(std::fs::File::create(output).unwrap());
    for (name, data) in entries {
        writer
            .start_file(
                name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(&data).unwrap();
    }
    writer.finish().unwrap();
}

#[test]
fn modern_package_with_a_missing_identity_is_rejected_before_any_content_is_imported() {
    let dir = tempfile::tempdir().unwrap();
    let package = one_image_package(dir.path());
    let damaged = dir.path().join("damaged.kinshoko-group");
    rewrite_manifest(&package, &damaged, |manifest| {
        manifest["images"][0]["snapshot"]["tags"][0]
            .as_object_mut()
            .unwrap()
            .remove("definition");
    });
    let target = Library::create(&dir.path().join("target"), "目标").unwrap();
    let groups = ReferenceGroups::open(&dir.path().join("target-groups")).unwrap();
    let result = groups.import_package(&damaged, &target);
    assert!(
        matches!(
            result,
            Err(kinshoko_core::reference_groups::GroupError::PackageDamaged(
                _
            ))
        ),
        "{result:?}"
    );
    assert!(groups.list().unwrap().is_empty());
    assert_eq!(
        target
            .browse(&kinshoko_core::library::BrowseQuery {
                scope: Default::default(),
                conditions: Default::default(),
                cursor: None,
                limit: 10,
                thumbnail_px: 100
            })
            .unwrap()
            .total,
        0
    );
}

#[test]
fn old_version_one_package_still_imports_through_the_legacy_compatibility_flow() {
    let dir = tempfile::tempdir().unwrap();
    let package = one_image_package(dir.path());
    let old = dir.path().join("old.kinshoko-group");
    rewrite_manifest(&package, &old, |manifest| {
        manifest["formatVersion"] = serde_json::json!(1);
        for image in manifest["images"].as_array_mut().unwrap() {
            for tag in image["snapshot"]["tags"].as_array_mut().unwrap() {
                tag.as_object_mut().unwrap().remove("definition");
                tag.as_object_mut().unwrap().remove("localTagId");
            }
        }
    });
    let (target, _, local) = named_library(dir.path(), "target");
    let groups = ReferenceGroups::open(&dir.path().join("target-groups")).unwrap();
    let imported = groups.import_package(&old, &target).unwrap();
    assert_eq!(
        target.vocabulary().unwrap().tags.len(),
        1,
        "legacy package keeps its documented compatibility matching"
    );
    let tags = target
        .image_tags(&imported.members[0].image_id, "zh-CN")
        .unwrap();
    assert_eq!(tags.tags[0].tag.id, local);
    assert_eq!(tags.tags[0].tag.name, "白");
}

#[test]
fn definition_publication_failure_and_process_exit_preserve_the_whole_previous_library_batch() {
    for action in ["error", "exit"] {
        let dir = tempfile::tempdir().unwrap();
        let (library, image, _) = named_library(dir.path(), "source");
        library
            .edit_tags(
                &[image],
                &[TagEdit::Add {
                    tag: TagRef::Named {
                        namespace: TagNamespace::Character,
                        name: "白".into(),
                        lang: "zh-CN".into(),
                    },
                }],
            )
            .unwrap();
        let before = library.tag_definition_dependencies().unwrap();
        assert_eq!(before.len(), 2);
        drop(library);
        let exe = std::env::current_exe().unwrap();
        let run = |fault: bool| {
            let mut cmd = std::process::Command::new(&exe);
            cmd.args(["--ignored", "--exact", "publication_subprocess"])
                .env("KINSHOKO_T11_CHILD_ROOT", dir.path().join("source"));
            if fault {
                cmd.env("KINSHOKO_FAULT", "portable_tags_publish_row");
                if action == "error" {
                    cmd.env("KINSHOKO_FAULT_ACTION", "error");
                }
            }
            cmd.output().unwrap()
        };
        let failed = run(true);
        assert_eq!(
            failed.status.code(),
            Some(if action == "error" { 0 } else { 99 }),
            "{}",
            String::from_utf8_lossy(&failed.stderr)
        );
        let provider = Library::open_read_only(
            &dir.path().join("source"),
            &Library::inspect(&dir.path().join("source")).unwrap().id,
        )
        .unwrap();
        assert_eq!(
            provider.tag_definition_dependencies().unwrap(),
            before,
            "one row must not escape an aborted publication"
        );
        drop(provider);
        let retry = run(false);
        assert!(
            retry.status.success(),
            "{}",
            String::from_utf8_lossy(&retry.stderr)
        );
        let provider = Library::open(&dir.path().join("source")).unwrap();
        let mut app = TagCatalog::open(&dir.path().join("fresh-app")).unwrap();
        let after = app.synchronize(&provider).unwrap();
        for binding in before {
            assert_eq!(
                app.local_tag_ids(
                    &provider.info().id,
                    &format!("replacement-{}", binding.local_tag_id)
                )
                .unwrap(),
                [binding.local_tag_id]
            );
        }
        assert_eq!(after.mappings.len(), 2);
    }
}

#[test]
#[ignore = "parent public-action fault test runs this in an isolated process"]
fn publication_subprocess() {
    let root = std::env::var_os("KINSHOKO_T11_CHILD_ROOT").unwrap();
    let library = Library::open(Path::new(&root)).unwrap();
    let mut bindings = library.tag_definition_dependencies().unwrap();
    for binding in &mut bindings {
        binding.definition.id = format!("replacement-{}", binding.local_tag_id);
        binding.authoritative = true;
    }
    let result = library.publish_tag_definitions(&bindings);
    if std::env::var("KINSHOKO_FAULT_ACTION").as_deref() == Ok("error") {
        assert!(result.is_err());
    } else {
        result.unwrap();
    }
}

#[test]
fn read_only_registration_and_failed_publication_leave_provider_bytes_and_safe_mode_unchanged() {
    use sha2::{Digest, Sha256};
    let dir = tempfile::tempdir().unwrap();
    let (library, _, _) = named_library(dir.path(), "source");
    let root = library.info().root.clone();
    let id = library.info().id.clone();
    drop(library);
    let before = Sha256::digest(std::fs::read(root.join("library.sqlite")).unwrap());
    let provider = Library::open_read_only(&root, &id).unwrap();
    let mut app = TagCatalog::open(&dir.path().join("app")).unwrap();
    app.synchronize(&provider).unwrap();
    assert!(app.publish_library_definitions(&provider).is_err());
    assert!(provider.safe_mode());
    drop(provider);
    let after = Sha256::digest(std::fs::read(root.join("library.sqlite")).unwrap());
    assert_eq!(
        after, before,
        "read-only providers cannot silently publish or migrate"
    );
}

#[test]
fn an_existing_catalog_namespace_conflict_is_rejected_before_package_content_changes() {
    let dir = tempfile::tempdir().unwrap();
    let package = one_image_package(dir.path());
    let (target, image, _) = named_library(dir.path(), "target");
    target
        .edit_tags(
            std::slice::from_ref(&image),
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::Artist,
                    name: "白".into(),
                    lang: "zh-CN".into(),
                },
            }],
        )
        .unwrap();
    let artist = target
        .vocabulary()
        .unwrap()
        .tags
        .into_iter()
        .find(|t| t.namespace == TagNamespace::Artist)
        .unwrap()
        .id;
    let mut app = TagCatalog::open(&dir.path().join("app")).unwrap();
    let split = app
        .correct(&target, &artist, CatalogCorrection::Separate)
        .unwrap();
    let artist_identity = split
        .mappings
        .iter()
        .find(|m| m.local_tag_id == artist)
        .unwrap()
        .catalog_id
        .clone();
    let conflict = dir.path().join("conflict.kinshoko-group");
    rewrite_manifest(&package, &conflict, |manifest| {
        manifest["images"][0]["snapshot"]["tags"][0]["definition"]["id"] =
            serde_json::json!(artist_identity);
    });
    let before = target.image_tags(&image, "zh-CN").unwrap();
    let groups = ReferenceGroups::open(&dir.path().join("target-groups")).unwrap();
    assert!(
        groups
            .import_package_with_catalog(&conflict, &target, &mut app)
            .is_err()
    );
    assert_eq!(
        target.image_tags(&image, "zh-CN").unwrap(),
        before,
        "content import must validate the catalog's exact identity before changing the target"
    );
    assert!(groups.list().unwrap().is_empty());
}

#[test]
fn publishing_a_new_external_tag_carries_the_same_identity_already_used_by_another_library() {
    let dir = tempfile::tempdir().unwrap();
    let (first, _, a) = named_library(dir.path(), "first");
    let (second, image, b) = named_library(dir.path(), "second");
    first.add_tag_external(&a, "blue_eyes").unwrap();
    second.add_tag_external(&b, "blue_eyes").unwrap();
    let mut app = TagCatalog::open(&dir.path().join("app")).unwrap();
    let first_identity = app.synchronize(&first).unwrap().mappings[0]
        .catalog_id
        .clone();
    let second_view = app.synchronize(&second).unwrap();
    assert_eq!(
        second_view
            .mappings
            .iter()
            .find(|m| m.local_tag_id == b)
            .unwrap()
            .catalog_id,
        first_identity
    );
    app.publish_library_definitions(&second).unwrap();
    let root = second.info().root.clone();
    let id = second.info().id.clone();
    drop(second);
    let copy = dir.path().join("copy");
    copy_tree(&root, &copy);
    let provider = Library::open_read_only(&copy, &id).unwrap();
    let mut fresh = TagCatalog::open(&dir.path().join("fresh")).unwrap();
    fresh.synchronize(&provider).unwrap();
    assert_eq!(fresh.local_tag_ids(&id, &first_identity).unwrap(), [b]);
    assert_eq!(provider.image_tags(&image, "zh-CN").unwrap().tags.len(), 1);
}

#[test]
fn a_carried_seed_identity_can_attach_to_two_library_local_ids_in_one_application() {
    let dir = tempfile::tempdir().unwrap();
    let (first, _, first_local) = named_library(dir.path(), "first-seed");
    let (second, _, second_local) = named_library(dir.path(), "second-seed");
    let mut binding = first.tag_definition_dependencies().unwrap().remove(0);
    let identity = binding.definition.id.clone();
    assert!(!binding.authoritative);
    binding.local_tag_id = second_local.clone();
    second.publish_tag_definitions(&[binding]).unwrap();
    let mut app = TagCatalog::open(&dir.path().join("application")).unwrap();
    app.synchronize(&first).unwrap();
    app.set_name_preference(
        &identity,
        &LocalizedName {
            lang: "zh-CN".into(),
            name: "我的白色".into(),
        },
    )
    .unwrap();
    let catalog = app
        .synchronize(&second)
        .expect("one carried stable identity may be used by different library-local tags");
    assert_eq!(
        catalog
            .mappings
            .iter()
            .find(|m| m.local_tag_id == first_local)
            .unwrap()
            .catalog_id,
        identity
    );
    assert_eq!(
        catalog
            .mappings
            .iter()
            .find(|m| m.local_tag_id == second_local)
            .unwrap()
            .catalog_id,
        identity
    );
    assert_eq!(
        catalog
            .tags
            .iter()
            .find(|tag| tag.id == identity)
            .unwrap()
            .name_preferences[0]
            .name,
        "我的白色"
    );
}
