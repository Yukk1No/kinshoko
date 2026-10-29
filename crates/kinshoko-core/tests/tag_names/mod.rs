//! Name rules exercise public actions with two SQLite libraries and real images.
use image::{Rgba, RgbaImage};
use kinshoko_core::library::{
    FactSource, ImportOutcome, ImportSource, LocalizedName, SourceTag, TagAlias, TagNamespace,
    TagRef, TagTranslation, TagTranslations,
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
fn replacing_a_preferred_name_preserves_the_old_name_as_a_searchable_alias() {
    let dir = tempfile::tempdir().unwrap();
    let (a, image_a) = library(dir.path(), "a");
    let (b, image_b) = library(dir.path(), "b");
    attach(&a, &image_a);
    attach(&b, &image_b);
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.synchronize(&a).unwrap();
    let id = catalog.synchronize(&b).unwrap().tags[0].id.clone();
    let old = LocalizedName {
        lang: "zh-CN".into(),
        name: "自选旧名甲".into(),
    };
    catalog.set_name_preference(&id, &old).unwrap();
    let next = LocalizedName {
        lang: "zh-CN".into(),
        name: "自选新名乙".into(),
    };
    let inspection = catalog.set_name_preference(&id, &next).unwrap();
    let alias = TagAlias {
        name: old.name.clone(),
        lang: Some(old.lang.clone()),
    };
    assert!(inspection.tags[0].aliases.contains(&alias));
    for lib in [&a, &b] {
        assert_eq!(
            Search::new(
                &catalog.search_vocabulary(lib).unwrap(),
                &BuiltinApproxTable::default()
            )
            .candidates("自选旧名甲", "zh-CN", 10)[0]
                .tag
                .name,
            "自选新名乙"
        );
    }
    assert_eq!(label(&mut catalog, &a, &image_a, "en"), "Parted hair");
    catalog.remove_alias(&id, &alias).unwrap();
    catalog.set_name_preference(&id, &old).unwrap();
    catalog.set_name_preference(&id, &next).unwrap();
    assert!(!catalog.inspect().unwrap().tags[0].aliases.contains(&alias));
    assert!(
        Search::new(
            &catalog.search_vocabulary(&b).unwrap(),
            &BuiltinApproxTable::default()
        )
        .candidates("自选旧名甲", "zh-CN", 10)
        .is_empty()
    );
}

#[test]
fn resetting_a_preferred_name_preserves_a_removable_alias_and_its_deletion_memory() {
    let dir = tempfile::tempdir().unwrap();
    let (a, image_a) = library(dir.path(), "a");
    attach(&a, &image_a);
    let app = dir.path().join("app");
    let mut catalog = TagCatalog::open(&app).unwrap();
    let id = catalog.synchronize(&a).unwrap().tags[0].id.clone();
    let old = LocalizedName {
        lang: "zh-CN".into(),
        name: "重置前自选旧名".into(),
    };
    catalog.set_name_preference(&id, &old).unwrap();
    let inspection = catalog.reset_name_preference(&id, "zh-CN").unwrap();
    let alias = TagAlias {
        name: old.name.clone(),
        lang: Some(old.lang.clone()),
    };
    assert!(inspection.tags[0].aliases.contains(&alias));
    assert_eq!(label(&mut catalog, &a, &image_a, "zh-CN"), "分发");
    assert_eq!(
        Search::new(
            &catalog.search_vocabulary(&a).unwrap(),
            &BuiltinApproxTable::default()
        )
        .candidates("重置前自选旧名", "zh-CN", 10)[0]
            .tag
            .name,
        "分发"
    );
    catalog.remove_alias(&id, &alias).unwrap();
    catalog.set_name_preference(&id, &old).unwrap();
    catalog.reset_name_preference(&id, "zh-CN").unwrap();
    catalog
        .update_name_defaults(&table("新的默认名称"))
        .unwrap();
    drop(catalog);
    let mut catalog = TagCatalog::open(&app).unwrap();
    assert!(!catalog.inspect().unwrap().tags[0].aliases.contains(&alias));
    assert!(
        Search::new(
            &catalog.search_vocabulary(&a).unwrap(),
            &BuiltinApproxTable::default()
        )
        .candidates("重置前自选旧名", "zh-CN", 10)
        .is_empty()
    );
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

mod legacy_and_defaults;
