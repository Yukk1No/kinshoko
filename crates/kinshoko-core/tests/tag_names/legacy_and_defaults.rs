//! 旧名称迁移、内置默认名称与别名：名称偏好之外的统一标签目录名称行为。

use super::*;

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
    // 安全模式开着也同步只在被封印的图上出现的标签（#335）：它早于登记，名称仍待迁移。
    let hidden = catalog.synchronize(&old).unwrap();
    old.set_safe_mode(false);
    let old_snapshot = catalog.synchronize(&old).unwrap();
    assert_eq!(old_snapshot, hidden);
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

#[test]
fn naming_an_untranslated_tag_is_a_preference_that_a_later_table_does_not_replace() {
    let dir = tempfile::tempdir().unwrap();
    let (lib, image) = library(dir.path(), "a");
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.synchronize(&lib).unwrap();
    lib.replace_source_tags(
        &FactSource::model("test"),
        &image,
        &[SourceTag {
            tag: TagRef::External {
                namespace: TagNamespace::General,
                name: "parted_hair".into(),
            },
            score: Some(0.9),
        }],
    )
    .unwrap();
    let before = catalog.image_tags(&lib, &image, "zh-CN").unwrap();
    assert!(before.image.tags[0].tag.untranslated);
    let id = before.identities[0].catalog_id.clone();

    catalog
        .set_name_preference(
            &id,
            &LocalizedName {
                lang: "zh-CN".into(),
                name: "中分".into(),
            },
        )
        .unwrap();
    catalog.update_name_defaults(&table("分缝发型")).unwrap();

    let after = catalog.image_tags(&lib, &image, "zh-CN").unwrap();
    assert_eq!(after.image.tags[0].tag.name, "中分");
    assert!(!after.image.tags[0].tag.untranslated);
}
