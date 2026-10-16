//! Shared identity is tested through public core actions and real libraries/files.
use image::{Rgba, RgbaImage};
use kinshoko_core::library::{
    FactSource, ImportOutcome, ImportSource, SourceTag, TagNamespace, TagRef,
};
use kinshoko_core::{Library, tag_catalog::TagCatalog};
use std::path::Path;

fn library(dir: &Path, name: &str) -> (Library, String) {
    let library = Library::create(&dir.join(name), name).unwrap();
    let path = dir.join(format!("{name}.png"));
    RgbaImage::from_pixel(3, 3, Rgba([18, 28, 38, 255]))
        .save(&path)
        .unwrap();
    let report = library.import(ImportSource { paths: vec![path] }).wait();
    let ImportOutcome::Imported { image_id } = &report.items[0].outcome else {
        panic!("image not imported")
    };
    (library, image_id.clone())
}

fn external(library: &Library, image: &str, namespace: TagNamespace, name: &str) -> String {
    library
        .replace_source_tags(
            &FactSource::model("test"),
            image,
            &[SourceTag {
                tag: TagRef::External {
                    namespace,
                    name: name.into(),
                },
                score: Some(0.9),
            }],
        )
        .unwrap();
    library
        .vocabulary()
        .unwrap()
        .tags
        .into_iter()
        .find(|tag| tag.external.contains(&name.to_owned()))
        .unwrap()
        .id
}

#[test]
fn different_library_local_ids_share_an_explicit_external_identity_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let (first, image_a) = library(dir.path(), "first");
    let (second, image_b) = library(dir.path(), "second");
    let local_a = external(&first, &image_a, TagNamespace::General, "blue_eyes");
    let local_b = external(&second, &image_b, TagNamespace::General, "blue_eyes");
    assert_ne!(local_a, local_b);
    let app_dir = dir.path().join("app");
    let mut catalog = TagCatalog::open(&app_dir).unwrap();
    let a = catalog.synchronize(&first).unwrap();
    let b = catalog.synchronize(&second).unwrap();
    let shared = a.mappings[0].catalog_id.clone();
    assert_eq!(b.mappings[0].catalog_id, shared);
    assert_eq!(b.tags.len(), 1);
    assert_eq!(b.tags[0].external[0].vocabulary, "danbooru");
    assert_eq!(b.tags[0].external[0].name, "blue_eyes");
    drop(catalog);
    let catalog = TagCatalog::open(&app_dir).unwrap();
    assert_eq!(
        catalog.local_tag_ids(&first.info().id, &shared).unwrap(),
        [local_a]
    );
    assert_eq!(
        catalog.local_tag_ids(&second.info().id, &shared).unwrap(),
        [local_b]
    );
}

use kinshoko_core::approx::BuiltinApproxTable;
use kinshoko_core::library::{TagAlias, TagEdit};
use kinshoko_core::search::Search;
use kinshoko_core::tag_catalog::CatalogCorrection;

fn named(library: &Library, image: &str, namespace: TagNamespace, name: &str) -> String {
    library
        .edit_tags(
            &[image.into()],
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace,
                    name: name.into(),
                    lang: "zh-CN".into(),
                },
            }],
        )
        .unwrap();
    library
        .vocabulary()
        .unwrap()
        .tags
        .into_iter()
        .find(|tag| tag.namespace == namespace && tag.names.iter().any(|n| n.name == name))
        .unwrap()
        .id
}

#[test]
fn ambiguous_aliases_stay_separate_until_correction_and_manual_decisions_stay_local() {
    let dir = tempfile::tempdir().unwrap();
    let (first, image_a) = library(dir.path(), "first");
    let (second, image_b) = library(dir.path(), "second");
    let blue = named(&first, &image_a, TagNamespace::General, "蓝发");
    let purple = named(&first, &image_a, TagNamespace::General, "紫发");
    let azure = named(&second, &image_b, TagNamespace::General, "青丝");
    for (lib, id) in [(&first, &blue), (&first, &purple), (&second, &azure)] {
        lib.add_tag_alias(
            id,
            &TagAlias {
                name: "染发".into(),
                lang: None,
            },
        )
        .unwrap();
    }
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.synchronize(&first).unwrap();
    let inspection = catalog.synchronize(&second).unwrap();
    assert_eq!(inspection.tags.len(), 3);
    assert!(inspection.tags.iter().all(|tag| tag.external.is_empty()));
    let target = inspection
        .mappings
        .iter()
        .find(|m| m.local_tag_id == blue)
        .unwrap()
        .catalog_id
        .clone();
    let before = second.image_tags(&image_b, "zh-CN").unwrap();
    assert!(
        Search::new(
            &catalog.search_vocabulary(&second).unwrap(),
            &BuiltinApproxTable::default()
        )
        .candidates("蓝发", "zh-CN", 10)
        .is_empty()
    );
    catalog
        .correct(
            &second,
            &azure,
            CatalogCorrection::Use {
                catalog_id: target.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        catalog.local_tag_ids(&second.info().id, &target).unwrap(),
        std::slice::from_ref(&azure)
    );
    let candidates = Search::new(
        &catalog.search_vocabulary(&second).unwrap(),
        &BuiltinApproxTable::default(),
    )
    .candidates("蓝发", "zh-CN", 10);
    assert_eq!(candidates[0].tag.id, azure);
    assert_eq!(candidates[0].tag.name, "青丝");
    assert_eq!(second.image_tags(&image_b, "zh-CN").unwrap(), before);
    first
        .edit_tags(
            std::slice::from_ref(&image_a),
            &[TagEdit::Reject {
                tag: TagRef::Id { id: blue },
            }],
        )
        .unwrap();
    assert_eq!(second.image_tags(&image_b, "zh-CN").unwrap(), before);
    drop(catalog);
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    let reopened = catalog.synchronize(&second).unwrap();
    assert_eq!(
        reopened
            .mappings
            .iter()
            .find(|m| m.local_tag_id == azure)
            .unwrap()
            .catalog_id,
        target
    );
    assert_eq!(
        catalog
            .image_tags(&second, &image_b, "zh-CN")
            .unwrap()
            .identities[0]
            .catalog_id,
        target
    );
}

#[test]
fn explicit_external_correspondences_extend_a_shared_identity_without_relying_on_names() {
    let dir = tempfile::tempdir().unwrap();
    let (first, a) = library(dir.path(), "first");
    let (second, b) = library(dir.path(), "second");
    let (third, c) = library(dir.path(), "third");
    external(&first, &a, TagNamespace::General, "blue_eyes");
    let local_b = external(&second, &b, TagNamespace::General, "blue_eyes");
    second.add_tag_external(&local_b, "azure_eyes").unwrap();
    external(&third, &c, TagNamespace::General, "azure_eyes");
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.synchronize(&first).unwrap();
    catalog.synchronize(&second).unwrap();
    let inspection = catalog.synchronize(&third).unwrap();
    assert_eq!(
        inspection.tags.len(),
        1,
        "all explicit correspondences describe one identity"
    );
    assert_eq!(
        inspection.tags[0]
            .external
            .iter()
            .map(|e| e.name.as_str())
            .collect::<Vec<_>>(),
        ["azure_eyes", "blue_eyes"]
    );
}

use kinshoko_core::{DeviceLibraries, tag_catalog::CatalogError};

#[test]
fn catalog_can_inspect_registered_libraries_without_switching_or_changing_local_data() {
    let dir = tempfile::tempdir().unwrap();
    let (first, a) = library(dir.path(), "first");
    let (second, b) = library(dir.path(), "second");
    named(&first, &a, TagNamespace::General, "旧名称");
    named(&second, &b, TagNamespace::General, "同名异义");
    let before = first.image_tags(&a, "zh-CN").unwrap();
    let mut device = DeviceLibraries::open(&dir.path().join("device")).unwrap();
    device.register(&first.info().root).unwrap();
    device.register(&second.info().root).unwrap();
    let reader = device.read(&first.info().id).unwrap();
    assert_eq!(device.current().unwrap().info().id, second.info().id);
    assert_eq!(reader.image_tags(&a, "zh-CN").unwrap(), before);
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    let workspace = catalog.inspect_libraries(&device, true).unwrap();
    assert_eq!(workspace.catalog.mappings.len(), 2);
    assert_eq!(workspace.libraries.len(), 2);
    assert!(
        workspace
            .libraries
            .iter()
            .all(|entry| entry.unavailable.is_none())
    );
    assert_eq!(first.image_tags(&a, "zh-CN").unwrap(), before);
    assert!(
        reader
            .edit_tags(
                std::slice::from_ref(&a),
                &[TagEdit::Add {
                    tag: TagRef::Named {
                        namespace: TagNamespace::General,
                        name: "不应写入".into(),
                        lang: "zh-CN".into()
                    }
                }]
            )
            .is_err()
    );
    assert_eq!(first.image_tags(&a, "zh-CN").unwrap(), before);
}

#[test]
fn namespaces_remain_distinct_and_an_explicit_split_survives_external_reattachment() {
    let dir = tempfile::tempdir().unwrap();
    let (first, a) = library(dir.path(), "first");
    let (second, b) = library(dir.path(), "second");
    let general = external(&first, &a, TagNamespace::General, "white");
    let artist = external(&second, &b, TagNamespace::Artist, "white");
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.synchronize(&first).unwrap();
    let inspection = catalog.synchronize(&second).unwrap();
    let target = inspection
        .mappings
        .iter()
        .find(|m| m.local_tag_id == general)
        .unwrap()
        .catalog_id
        .clone();
    assert_eq!(inspection.tags.len(), 2);
    assert!(matches!(
        catalog.correct(
            &second,
            &artist,
            CatalogCorrection::Use {
                catalog_id: target.clone()
            }
        ),
        Err(CatalogError::NamespaceMismatch)
    ));
    let before = second.image_tags(&b, "zh-CN").unwrap();
    let split = catalog
        .correct(&second, &artist, CatalogCorrection::Separate)
        .unwrap();
    let new_id = split
        .mappings
        .iter()
        .find(|m| m.local_tag_id == artist)
        .unwrap()
        .catalog_id
        .clone();
    drop(catalog);
    let mut reopened = TagCatalog::open(&dir.path().join("app")).unwrap();
    let inspection = reopened.synchronize(&second).unwrap();
    assert_eq!(
        inspection
            .mappings
            .iter()
            .find(|m| m.local_tag_id == artist)
            .unwrap()
            .catalog_id,
        new_id
    );
    assert_eq!(second.image_tags(&b, "zh-CN").unwrap(), before);
    assert!(
        reopened
            .local_tag_ids(&second.info().id, &target)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn attaching_legacy_tags_keeps_untranslated_display_until_name_provenance_is_migrated() {
    let dir = tempfile::tempdir().unwrap();
    let (legacy, image) = library(dir.path(), "legacy");
    external(&legacy, &image, TagNamespace::General, "blue_eyes");
    let before = legacy.image_tags(&image, "zh-CN").unwrap();
    assert_eq!(before.tags[0].tag.name, "blue eyes");
    legacy.use_translations_for_new_tags(kinshoko_core::library::TagTranslations::bundled());
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    let inspection = catalog.synchronize(&legacy).unwrap();
    assert_eq!(legacy.image_tags(&image, "zh-CN").unwrap(), before);
    assert_eq!(inspection.mappings[0].legacy.names.len(), 0);
    assert_eq!(
        inspection.mappings[0].name_provenance,
        kinshoko_core::tag_catalog::TagNameProvenance::Pending
    );
    let (fresh, image) = library(dir.path(), "fresh");
    fresh.use_translations_for_new_tags(kinshoko_core::library::TagTranslations::bundled());
    external(&fresh, &image, TagNamespace::General, "blue_eyes");
    assert_eq!(
        fresh.image_tags(&image, "zh-CN").unwrap().tags[0].tag.name,
        "蓝瞳"
    );
}

#[test]
fn adding_an_external_correspondence_after_attachment_is_available_to_the_next_library() {
    let dir = tempfile::tempdir().unwrap();
    let (first, a) = library(dir.path(), "first");
    let (second, b) = library(dir.path(), "second");
    let local_a = named(&first, &a, TagNamespace::General, "蓝瞳");
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    let initial = catalog.synchronize(&first).unwrap().mappings[0]
        .catalog_id
        .clone();
    first.add_tag_external(&local_a, "blue_eyes").unwrap();
    catalog.synchronize(&first).unwrap();
    external(&second, &b, TagNamespace::General, "blue_eyes");
    let inspection = catalog.synchronize(&second).unwrap();
    assert_eq!(inspection.tags.len(), 1);
    assert!(inspection.mappings.iter().all(|m| m.catalog_id == initial));
}

#[test]
fn same_named_tags_without_external_correspondence_remain_independent_across_libraries() {
    let dir = tempfile::tempdir().unwrap();
    let (first, a) = library(dir.path(), "first");
    let (second, b) = library(dir.path(), "second");
    named(&first, &a, TagNamespace::General, "白");
    named(&second, &b, TagNamespace::General, "白");
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.synchronize(&first).unwrap();
    let inspection = catalog.synchronize(&second).unwrap();
    assert_eq!(inspection.tags.len(), 2);
    assert_ne!(
        inspection.mappings[0].catalog_id,
        inspection.mappings[1].catalog_id
    );
}

#[test]
fn a_late_explicit_external_correspondence_uses_an_existing_identity_unless_user_corrected() {
    let dir = tempfile::tempdir().unwrap();
    let (first, a) = library(dir.path(), "first");
    let (second, b) = library(dir.path(), "second");
    external(&first, &a, TagNamespace::General, "blue_eyes");
    let local_b = named(&second, &b, TagNamespace::General, "蓝瞳");
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    let target = catalog.synchronize(&first).unwrap().mappings[0]
        .catalog_id
        .clone();
    catalog.synchronize(&second).unwrap();
    first.image_tags(&a, "zh-CN").unwrap();
    second.add_tag_external(&local_b, "blue_eyes").unwrap();
    let inspection = catalog.synchronize(&second).unwrap();
    assert_eq!(
        inspection
            .mappings
            .iter()
            .find(|m| m.local_tag_id == local_b)
            .unwrap()
            .catalog_id,
        target
    );
    let split = catalog
        .correct(&second, &local_b, CatalogCorrection::Separate)
        .unwrap();
    let split_id = split
        .mappings
        .iter()
        .find(|m| m.local_tag_id == local_b)
        .unwrap()
        .catalog_id
        .clone();
    assert_ne!(split_id, target);
    let reattached = catalog.synchronize(&second).unwrap();
    assert_eq!(
        reattached
            .mappings
            .iter()
            .find(|m| m.local_tag_id == local_b)
            .unwrap()
            .catalog_id,
        split_id
    );
}

#[test]
fn conflicting_external_correspondences_are_inspectable_and_require_an_explicit_choice() {
    let dir = tempfile::tempdir().unwrap();
    let (first, a) = library(dir.path(), "first");
    let (second, b) = library(dir.path(), "second");
    let (ambiguous, c) = library(dir.path(), "ambiguous");
    external(&first, &a, TagNamespace::General, "blue_eyes");
    external(&second, &b, TagNamespace::General, "purple_eyes");
    let local_c = external(&ambiguous, &c, TagNamespace::General, "blue_eyes");
    ambiguous.add_tag_external(&local_c, "purple_eyes").unwrap();
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    let blue = catalog.synchronize(&first).unwrap().mappings[0]
        .catalog_id
        .clone();
    catalog.synchronize(&second).unwrap();
    let inspection = catalog.synchronize(&ambiguous).unwrap();
    let mapping = inspection
        .mappings
        .iter()
        .find(|m| m.local_tag_id == local_c)
        .unwrap();
    assert_eq!(inspection.tags.len(), 3);
    assert_eq!(
        mapping.basis,
        kinshoko_core::tag_catalog::CatalogMatchBasis::ConflictingExternal
    );
    assert_eq!(mapping.legacy.external, ["blue_eyes", "purple_eyes"]);
    assert_ne!(mapping.catalog_id, blue);
    catalog
        .correct(
            &ambiguous,
            &local_c,
            CatalogCorrection::Use {
                catalog_id: blue.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        catalog.local_tag_ids(&ambiguous.info().id, &blue).unwrap(),
        [local_c]
    );
}

#[test]
fn inspecting_an_unsafe_snapshot_never_changes_the_active_library_safe_mode() {
    use kinshoko_core::library::{ContentRating, ImageEdit};
    let dir = tempfile::tempdir().unwrap();
    let (library, image) = library(dir.path(), "provider");
    named(
        &library,
        &image,
        TagNamespace::General,
        "只在封印图上的标签",
    );
    library
        .edit(
            std::slice::from_ref(&image),
            &[ImageEdit::SetRating {
                rating: ContentRating::Explicit,
            }],
        )
        .unwrap();
    let mut device = DeviceLibraries::open(&dir.path().join("device")).unwrap();
    let active = device.register(&library.info().root).unwrap();
    active.set_safe_mode(true);
    assert!(active.image(&image).is_err());
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    let unsafe_snapshot = catalog.inspect_libraries(&device, false).unwrap();
    assert_eq!(unsafe_snapshot.catalog.mappings.len(), 1);
    assert!(
        active.safe_mode(),
        "inspection must not replace the active library's mode with an older request's mode"
    );
    assert!(
        active.image(&image).is_err(),
        "the sealed image stays unavailable through the active handle"
    );
    assert!(
        catalog
            .inspect_libraries(&device, true)
            .unwrap()
            .catalog
            .mappings
            .is_empty()
    );
    let reader = device.read(&active.info().id).unwrap();
    assert!(
        reader
            .edit(
                std::slice::from_ref(&image),
                &[ImageEdit::SetNote {
                    text: "must remain read-only".into()
                }]
            )
            .is_err()
    );
}
