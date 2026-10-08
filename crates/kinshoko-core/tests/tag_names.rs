//! Name rules exercise public actions with two SQLite libraries and real images.
use image::{Rgba, RgbaImage};
use kinshoko_core::library::{
    FactSource, ImportOutcome, ImportSource, LocalizedName, SourceTag, TagNamespace, TagRef,
    TagTranslation, TagTranslations,
};
use kinshoko_core::{Library, tag_catalog::TagCatalog};
use kinshoko_core::{approx::BuiltinApproxTable, search::Search};
use std::collections::BTreeMap;
use std::path::Path;

fn library(dir: &Path, name: &str) -> (Library, String) {
    let lib = Library::create(&dir.join(name), name).unwrap();
    let path = dir.join(format!("{name}.png"));
    RgbaImage::from_pixel(3, 3, Rgba([18, 28, 38, 255]))
        .save(&path)
        .unwrap();
    let report = lib.import(ImportSource { paths: vec![path] }).wait();
    let ImportOutcome::Imported { image_id } = &report.items[0].outcome else {
        panic!("image not imported")
    };
    (lib, image_id.clone())
}
fn table(zh: &str) -> TagTranslations {
    TagTranslations {
        entries: vec![TagTranslation {
            external: "parted_hair".into(),
            names: BTreeMap::from([
                ("zh-CN".into(), zh.into()),
                ("en".into(), "Parted hair".into()),
            ]),
            aliases: vec![],
        }],
    }
}
fn attach(lib: &Library, image: &str) {
    lib.use_translations_for_new_tags(table("分发"));
    lib.replace_source_tags(
        &FactSource::model("test"),
        image,
        &[SourceTag {
            tag: TagRef::External {
                namespace: TagNamespace::General,
                name: "parted_hair".into(),
            },
            score: Some(0.9),
        }],
    )
    .unwrap();
}
fn label(catalog: &mut TagCatalog, lib: &Library, image: &str, lang: &str) -> String {
    catalog.image_tags(lib, image, lang).unwrap().image.tags[0]
        .tag
        .name
        .clone()
}
#[test]
fn preference_is_shared_by_identity_and_language_and_survives_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let (a, image_a) = library(dir.path(), "a");
    let (b, image_b) = library(dir.path(), "b");
    let app = dir.path().join("app");
    let mut catalog = TagCatalog::open(&app).unwrap();
    catalog.synchronize(&a).unwrap();
    catalog.synchronize(&b).unwrap();
    attach(&a, &image_a);
    attach(&b, &image_b);
    catalog.synchronize(&a).unwrap();
    let before = catalog.synchronize(&b).unwrap();
    assert_ne!(
        before.mappings[0].local_tag_id,
        before.mappings[1].local_tag_id
    );
    let id = before.tags[0].id.clone();
    catalog
        .set_name_preference(
            &id,
            &LocalizedName {
                lang: "zh-CN".into(),
                name: "分开的发丝".into(),
            },
        )
        .unwrap();
    assert_eq!(label(&mut catalog, &a, &image_a, "zh-CN"), "分开的发丝");
    assert_eq!(label(&mut catalog, &b, &image_b, "zh-CN"), "分开的发丝");
    assert_eq!(label(&mut catalog, &a, &image_a, "en"), "Parted hair");
    catalog
        .set_name_preference(
            &id,
            &LocalizedName {
                lang: "en".into(),
                name: "Natural part".into(),
            },
        )
        .unwrap();
    assert_eq!(label(&mut catalog, &b, &image_b, "en"), "Natural part");
    assert_eq!(label(&mut catalog, &a, &image_a, "zh-CN"), "分开的发丝");
    let view = catalog.search_vocabulary(&b).unwrap();
    let search = Search::new(&view, &BuiltinApproxTable::default());
    assert_eq!(
        search.candidates("分开的发丝", "zh-CN", 10)[0].tag.name,
        "分开的发丝"
    );
    assert!(catalog.inspect().unwrap().revision > before.revision);
    drop(catalog);
    let mut catalog = TagCatalog::open(&app).unwrap();
    assert_eq!(label(&mut catalog, &b, &image_b, "zh-CN"), "分开的发丝");
}

#[test]
fn default_updates_keep_equal_default_preferences_and_reset_deletes_the_override() {
    let dir = tempfile::tempdir().unwrap();
    let (a, image_a) = library(dir.path(), "a");
    let (b, image_b) = library(dir.path(), "b");
    let app = dir.path().join("app");
    let mut catalog = TagCatalog::open(&app).unwrap();
    catalog.synchronize(&a).unwrap();
    catalog.synchronize(&b).unwrap();
    attach(&a, &image_a);
    attach(&b, &image_b);
    catalog.synchronize(&a).unwrap();
    let id = catalog.synchronize(&b).unwrap().tags[0].id.clone();
    catalog
        .set_name_preference(
            &id,
            &LocalizedName {
                lang: "zh-CN".into(),
                name: "分发".into(),
            },
        )
        .unwrap();
    catalog.update_name_defaults(&table("分缝发型")).unwrap();
    assert_eq!(label(&mut catalog, &a, &image_a, "zh-CN"), "分发");
    let snapshot = catalog.inspect().unwrap();
    assert_eq!(snapshot.tags[0].name_preferences[0].name, "分发");
    assert!(
        snapshot.tags[0]
            .default_names
            .iter()
            .any(|n| n.name == "分缝发型")
    );
    catalog.reset_name_preference(&id, "zh-CN").unwrap();
    assert!(
        catalog.inspect().unwrap().tags[0]
            .name_preferences
            .is_empty()
    );
    for (lib, image) in [(&a, &image_a), (&b, &image_b)] {
        assert_eq!(label(&mut catalog, lib, image, "zh-CN"), "分缝发型");
        assert_eq!(
            Search::new(
                &catalog.search_vocabulary(lib).unwrap(),
                &BuiltinApproxTable::default()
            )
            .candidates("分发", "zh-CN", 10)[0]
                .tag
                .name,
            "分缝发型"
        );
    }
    catalog
        .remove_alias(
            &id,
            &kinshoko_core::library::TagAlias {
                name: "分发".into(),
                lang: Some("zh-CN".into()),
            },
        )
        .unwrap();
    drop(catalog);
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut updated = table("分缝发型");
    updated.entries[0]
        .aliases
        .push(kinshoko_core::library::TagAlias {
            name: "分发".into(),
            lang: Some("zh-CN".into()),
        });
    catalog.update_name_defaults(&updated).unwrap();
    for lib in [&a, &b] {
        assert!(
            Search::new(
                &catalog.search_vocabulary(lib).unwrap(),
                &BuiltinApproxTable::default()
            )
            .candidates("分发", "zh-CN", 10)
            .is_empty()
        );
    }
    catalog.update_name_defaults(&table("自然分缝")).unwrap();
    assert_eq!(label(&mut catalog, &b, &image_b, "zh-CN"), "自然分缝");
}

#[test]
fn legacy_names_remain_pending_until_an_explicit_global_preference_choice() {
    let dir = tempfile::tempdir().unwrap();
    let (a, image_a) = library(dir.path(), "legacy-a");
    let (b, image_b) = library(dir.path(), "legacy-b");
    attach(&a, &image_a);
    attach(&b, &image_b);
    let local_b = b.vocabulary().unwrap().tags[0].id.clone();
    b.rename_tag(&local_b, "zh-CN", "分开的头发").unwrap();
    let app = dir.path().join("app");
    let mut catalog = TagCatalog::open(&app).unwrap();
    catalog.synchronize(&a).unwrap();
    let snapshot = catalog.synchronize(&b).unwrap();
    let id = snapshot.tags[0].id.clone();
    assert!(
        snapshot
            .mappings
            .iter()
            .all(|m| m.name_provenance == kinshoko_core::tag_catalog::TagNameProvenance::Pending)
    );
    catalog.update_name_defaults(&table("分缝发型")).unwrap();
    assert_eq!(label(&mut catalog, &a, &image_a, "zh-CN"), "分发");
    assert_eq!(label(&mut catalog, &b, &image_b, "zh-CN"), "分开的头发");
    catalog
        .set_name_preference(
            &id,
            &LocalizedName {
                lang: "zh-CN".into(),
                name: "自然分缝".into(),
            },
        )
        .unwrap();
    assert_eq!(label(&mut catalog, &a, &image_a, "zh-CN"), "自然分缝");
    assert_eq!(label(&mut catalog, &b, &image_b, "zh-CN"), "自然分缝");
    let (new, image_new) = library(dir.path(), "new");
    catalog.synchronize(&new).unwrap();
    attach(&new, &image_new);
    assert_eq!(label(&mut catalog, &new, &image_new, "zh-CN"), "自然分缝");
    assert_eq!(label(&mut catalog, &a, &image_a, "zh-CN"), "自然分缝");
    assert_eq!(label(&mut catalog, &b, &image_b, "zh-CN"), "自然分缝");
    drop(catalog);
    let mut catalog = TagCatalog::open(&app).unwrap();
    assert_eq!(label(&mut catalog, &a, &image_a, "zh-CN"), "自然分缝");
    assert_eq!(label(&mut catalog, &b, &image_b, "zh-CN"), "自然分缝");
}

#[test]
fn bundled_defaults_use_the_accepted_names_and_keep_the_replaced_names_as_aliases() {
    let table = TagTranslations::bundled();
    for (external, name, old) in [
        ("long_hair_between_eyes", "两眼间长发", "长眼间发"),
        ("parted_hair", "分缝发型", "分发"),
    ] {
        let entry = table
            .entries
            .iter()
            .find(|entry| entry.external == external)
            .unwrap();
        assert_eq!(entry.names["zh-CN"], name);
        assert!(
            entry
                .aliases
                .iter()
                .any(|alias| alias.name == old && alias.lang.as_deref() == Some("zh-CN"))
        );
    }
}

#[test]
fn aliases_are_global_search_words_without_becoming_display_preferences() {
    let dir = tempfile::tempdir().unwrap();
    let (a, image_a) = library(dir.path(), "a");
    let (b, image_b) = library(dir.path(), "b");
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.synchronize(&a).unwrap();
    catalog.synchronize(&b).unwrap();
    attach(&a, &image_a);
    attach(&b, &image_b);
    catalog.synchronize(&a).unwrap();
    let id = catalog.synchronize(&b).unwrap().tags[0].id.clone();
    let alias = kinshoko_core::library::TagAlias {
        name: "从中间分开的头发".into(),
        lang: Some("zh-CN".into()),
    };
    catalog.add_alias(&id, &alias).unwrap();
    for (lib, image) in [(&a, &image_a), (&b, &image_b)] {
        assert_eq!(label(&mut catalog, lib, image, "zh-CN"), "分发");
        assert_eq!(
            Search::new(
                &catalog.search_vocabulary(lib).unwrap(),
                &BuiltinApproxTable::default()
            )
            .candidates(&alias.name, "zh-CN", 10)
            .len(),
            1
        );
    }
    assert!(
        catalog.inspect().unwrap().tags[0]
            .name_preferences
            .is_empty()
    );
    catalog.remove_alias(&id, &alias).unwrap();
    catalog.add_alias(&id, &alias).unwrap();
    assert_eq!(
        Search::new(
            &catalog.search_vocabulary(&b).unwrap(),
            &BuiltinApproxTable::default()
        )
        .candidates(&alias.name, "zh-CN", 10)
        .len(),
        1
    );
}

#[test]
fn installed_defaults_apply_to_later_tags_and_hidden_legacy_tags_keep_pending_provenance() {
    let dir = tempfile::tempdir().unwrap();
    let (old, old_image) = library(dir.path(), "old");
    attach(&old, &old_image);
    old.set_safe_mode(false);
    old.edit(
        std::slice::from_ref(&old_image),
        &[kinshoko_core::library::ImageEdit::SetRating {
            rating: kinshoko_core::library::ContentRating::Explicit,
        }],
    )
    .unwrap();
    old.set_safe_mode(true);
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.install_name_defaults(table("分缝发型")).unwrap();
    assert!(catalog.synchronize(&old).unwrap().mappings.is_empty());
    old.set_safe_mode(false);
    let old_snapshot = catalog.synchronize(&old).unwrap();
    assert_eq!(
        old_snapshot.mappings[0].name_provenance,
        kinshoko_core::tag_catalog::TagNameProvenance::Pending
    );
    assert_eq!(label(&mut catalog, &old, &old_image, "zh-CN"), "分发");
    catalog
        .follow_catalog_names(&old, &old_snapshot.mappings[0].local_tag_id)
        .unwrap();
    assert_eq!(label(&mut catalog, &old, &old_image, "zh-CN"), "分缝发型");
    let (new, new_image) = library(dir.path(), "new");
    catalog.synchronize(&new).unwrap();
    attach(&new, &new_image);
    assert_eq!(label(&mut catalog, &new, &new_image, "zh-CN"), "分缝发型");
}

#[test]
fn group_labels_refresh_from_shared_names_without_changing_local_membership_or_counts() {
    let dir = tempfile::tempdir().unwrap();
    let (a, image_a) = library(dir.path(), "a");
    let (b, image_b) = library(dir.path(), "b");
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.synchronize(&a).unwrap();
    catalog.synchronize(&b).unwrap();
    attach(&a, &image_a);
    attach(&b, &image_b);
    catalog.synchronize(&a).unwrap();
    let snapshot = catalog.synchronize(&b).unwrap();
    let id = snapshot.tags[0].id.clone();
    let groups = [&a, &b].map(|lib| {
        let local = snapshot
            .mappings
            .iter()
            .find(|mapping| mapping.library_id == lib.info().id)
            .unwrap()
            .local_tag_id
            .clone();
        let group = lib.create_tag_group("发型", None).unwrap();
        lib.add_to_tag_group(&group, &[local]).unwrap();
        group
    });
    catalog
        .set_name_preference(
            &id,
            &LocalizedName {
                lang: "zh-CN".into(),
                name: "自然分缝".into(),
            },
        )
        .unwrap();
    for (lib, group) in [(&a, &groups[0]), (&b, &groups[1])] {
        let view = catalog.tag_groups(lib, "zh-CN").unwrap();
        let view = view.iter().find(|view| view.id == *group).unwrap();
        assert_eq!(view.tags.len(), 1);
        assert_eq!(view.tags[0].tag.name, "自然分缝");
        assert_eq!(view.tags[0].count, 1);
    }
}

#[test]
fn a_corrected_legacy_mapping_adopts_the_existing_explicit_global_choice() {
    let dir = tempfile::tempdir().unwrap();
    let (a, image_a) = library(dir.path(), "a");
    let (b, image_b) = library(dir.path(), "b");
    for (lib, image, name) in [(&a, &image_a, "分发"), (&b, &image_b, "分开的头发")] {
        lib.edit_tags(
            std::slice::from_ref(image),
            &[kinshoko_core::library::TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: name.into(),
                    lang: "zh-CN".into(),
                },
            }],
        )
        .unwrap();
    }
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.synchronize(&a).unwrap();
    let snapshot = catalog.synchronize(&b).unwrap();
    let target = snapshot
        .mappings
        .iter()
        .find(|m| m.library_id == a.info().id)
        .unwrap()
        .catalog_id
        .clone();
    let local_b = snapshot
        .mappings
        .iter()
        .find(|m| m.library_id == b.info().id)
        .unwrap()
        .local_tag_id
        .clone();
    catalog
        .set_name_preference(
            &target,
            &LocalizedName {
                lang: "zh-CN".into(),
                name: "自然分缝".into(),
            },
        )
        .unwrap();
    catalog
        .correct(
            &b,
            &local_b,
            kinshoko_core::tag_catalog::CatalogCorrection::Use {
                catalog_id: target.clone(),
            },
        )
        .unwrap();
    assert_eq!(label(&mut catalog, &b, &image_b, "zh-CN"), "自然分缝");
    catalog.synchronize(&a).unwrap();
    catalog.synchronize(&b).unwrap();
    assert_eq!(
        catalog
            .inspect()
            .unwrap()
            .tags
            .iter()
            .find(|t| t.id == target)
            .unwrap()
            .name_preferences[0]
            .name,
        "自然分缝"
    );
}
