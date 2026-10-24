//! Portable package checks cross public Library and TagCatalog actions, backed by real files.

#[path = "support/portable_library.rs"]
mod portable_library;

use portable_library::*;

use kinshoko_core::RegisteredLibrary;
use kinshoko_core::desktop::{Placement, SavedPin};
use kinshoko_core::library::{LocalizedName, TagAlias};
use kinshoko_core::library::{TagEdit, TagNamespace, TagRef};
use kinshoko_core::reference_groups::{DetachedLenses, ReferenceGroups, References};
use kinshoko_core::tag_catalog::CatalogCorrection;
use kinshoko_core::{Library, tag_catalog::TagCatalog};
use std::path::Path;

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
        .image_tags(imported.members[0].image_id().unwrap(), "zh-CN")
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

#[test]
fn publishing_a_sealed_dependency_keeps_current_raw_definition_without_exposing_its_mapping() {
    let dir = tempfile::tempdir().unwrap();
    let (known, _, _) = named_library(dir.path(), "known");
    let mut definition = known
        .tag_definition_dependencies()
        .unwrap()
        .remove(0)
        .definition;
    definition.aliases.push(TagAlias {
        name: "雪".into(),
        lang: None,
    });
    definition
        .external
        .push(kinshoko_core::tag_catalog::ExternalTagIdentity {
            vocabulary: "custom-provider".into(),
            name: "portable-white".into(),
        });
    let known_local = known.vocabulary().unwrap().tags[0].id.clone();
    known
        .publish_tag_definitions(&[kinshoko_core::portable_tags::PortableTagBinding {
            local_tag_id: known_local,
            definition: definition.clone(),
            authoritative: true,
        }])
        .unwrap();
    let mut app = TagCatalog::open(&dir.path().join("application")).unwrap();
    app.synchronize(&known).unwrap();
    app.remove_alias(
        &definition.id,
        &TagAlias {
            name: "雪".into(),
            lang: None,
        },
    )
    .unwrap();
    let (target, image, local) = named_library(dir.path(), "sealed-target");
    target
        .publish_tag_definitions(&[kinshoko_core::portable_tags::PortableTagBinding {
            local_tag_id: local,
            definition: definition.clone(),
            authoritative: true,
        }])
        .unwrap();
    target
        .edit(
            &[image],
            &[kinshoko_core::library::ImageEdit::SetRating {
                rating: kinshoko_core::library::ContentRating::Explicit,
            }],
        )
        .unwrap();
    target.set_safe_mode(true);
    let id = target.info().id.clone();
    let root = target.info().root.clone();
    app.publish_library_definitions(&target).unwrap();
    assert!(
        !app.inspect()
            .unwrap()
            .mappings
            .iter()
            .any(|mapping| mapping.library_id == id)
    );
    assert!(target.vocabulary().unwrap().tags.is_empty());
    drop(target);
    let copy = dir.path().join("copied-sealed-target");
    copy_tree(&root, &copy);
    let provider = Library::open_read_only(&copy, &id).unwrap();
    provider.set_safe_mode(false);
    let mut fresh = TagCatalog::open(&dir.path().join("fresh-app")).unwrap();
    let catalog = fresh.synchronize(&provider).unwrap();
    let carried = catalog
        .tags
        .iter()
        .find(|tag| tag.id == definition.id)
        .unwrap();
    assert!(
        !carried.aliases.iter().any(|alias| alias.name == "雪"),
        "raw portable definitions must carry current alias deletions even when all uses are sealed"
    );
    assert_eq!(carried.external, definition.external);
}

#[test]
fn modern_package_without_its_explicit_source_local_mapping_is_rejected_before_writing() {
    let dir = tempfile::tempdir().unwrap();
    let package = one_image_package(dir.path());
    let damaged = dir.path().join("missing-local.kinshoko-group");
    rewrite_manifest(&package, &damaged, |manifest| {
        manifest["images"][0]["snapshot"]["tags"][0]
            .as_object_mut()
            .unwrap()
            .remove("localTagId");
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
    assert!(target.tag_definition_dependencies().unwrap().is_empty());
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
