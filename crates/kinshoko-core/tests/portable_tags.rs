//! Portable content crosses public Library and TagCatalog actions, backed by real files.

#[path = "support/portable_library.rs"]
mod portable_library;

use portable_library::*;

use kinshoko_core::{Library, tag_catalog::TagCatalog};

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
    let target_id = target.info().id.clone();
    let target_root = target.info().root.clone();
    drop(target);
    let copied_root = dir.path().join("reimported-target-copy");
    copy_tree(&target_root, &copied_root);
    let provider = Library::open_read_only(&copied_root, &target_id).unwrap();
    let mut copied_app = TagCatalog::open(&dir.path().join("copied-target-app")).unwrap();
    let copied = copied_app.synchronize(&provider).unwrap();
    let carried = copied.tags.iter().find(|tag| tag.id == identity).unwrap();
    assert!(carried.name_preferences.is_empty());
    assert!(
        !carried.aliases.iter().any(|alias| alias.name == "雪"),
        "a content write must publish the destination application's current pure definitions before the library is carried away"
    );
}
