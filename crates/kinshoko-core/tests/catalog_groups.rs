//! T05 shared groups: public core actions, real SQLite and files.
use image::{Rgba, RgbaImage};
use kinshoko_core::library::{FactSource, ImportSource, SourceTag, TagNamespace, TagRef};
use kinshoko_core::tag_catalog::TagCatalog;
use kinshoko_core::workspace::Workspace;
use kinshoko_core::{DeviceLibraries, Library};
use std::path::Path;

fn image(library: &Library, root: &Path, name: &str, red: u8, external: &str) -> (String, String) {
    let path = root.join(format!("{name}.png"));
    RgbaImage::from_pixel(4, 3, Rgba([red, 34, 56, 255]))
        .save(&path)
        .unwrap();
    let id = library
        .import(ImportSource { paths: vec![path] })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();
    library
        .replace_source_tags(
            &FactSource::model("test"),
            &id,
            &[SourceTag {
                tag: TagRef::External {
                    namespace: TagNamespace::General,
                    name: external.into(),
                },
                score: None,
            }],
        )
        .unwrap();
    let tag = library
        .vocabulary()
        .unwrap()
        .tags
        .into_iter()
        .find(|t| t.external.contains(&external.to_owned()))
        .unwrap()
        .id;
    (id, tag)
}

#[test]
fn legacy_group_is_shared_across_libraries_and_restart_without_rewriting_image_tags() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    let (ai, blue_a) = image(&a, dir.path(), "a", 10, "blue_hair");
    let (bi, purple_b) = image(&b, dir.path(), "b", 20, "purple_hair");
    let (_, purple_a) = image(&a, dir.path(), "a2", 30, "purple_hair");
    assert_ne!(purple_a, purple_b);
    let old_group = a.create_tag_group("发色", None).unwrap();
    a.set_tag_group_tags(&old_group, &[blue_a, purple_a])
        .unwrap();
    let before_a = a.image_tags(&ai, "zh-CN").unwrap();
    let before_b = b.image_tags(&bi, "zh-CN").unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let groups = workspace
        .tag_groups(&device, &mut catalog, &b.info().id, "en", true)
        .unwrap();
    assert_eq!(groups.len(), 1, "A's group is available while B is active");
    assert_eq!(groups[0].name, "发色");
    assert_eq!(groups[0].tags.len(), 2);
    let global_ids = groups[0]
        .tags
        .iter()
        .map(|t| t.tag.id.clone())
        .collect::<Vec<_>>();
    drop(workspace);
    drop(catalog);
    device.switch(&a.info().id).unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let groups = workspace
        .tag_groups(&device, &mut catalog, &a.info().id, "en", true)
        .unwrap();
    assert_eq!(
        groups[0]
            .tags
            .iter()
            .map(|t| t.tag.id.clone())
            .collect::<Vec<_>>(),
        global_ids
    );
    assert_eq!(a.image_tags(&ai, "zh-CN").unwrap(), before_a);
    assert_eq!(b.image_tags(&bi, "zh-CN").unwrap(), before_b);
}
#[test]
fn new_group_can_be_created_without_an_active_library_and_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let mut catalog = TagCatalog::open(dir.path()).unwrap();
    let id = catalog.create_group("  发色  ", None).unwrap();
    drop(catalog);
    let catalog = TagCatalog::open(dir.path()).unwrap();
    let groups = catalog.group_definitions().unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].id, id);
    assert_eq!(groups[0].name, "发色");
    assert!(groups[0].members.is_empty());
    assert!(groups[0].sources.is_empty());
}
use kinshoko_core::tag_catalog::CatalogGroupEdit;

#[test]
fn artist_can_rename_reorder_and_organize_shared_members_without_changing_images() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    let (ai, _) = image(&a, dir.path(), "blue", 40, "blue_hair");
    let (bi, _) = image(&b, dir.path(), "purple", 50, "purple_hair");
    let before_a = a.image_tags(&ai, "en").unwrap();
    let before_b = b.image_tags(&bi, "en").unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    workspace.status(&device, &mut catalog, true).unwrap();
    let snapshot = catalog.inspect().unwrap();
    let blue = snapshot
        .tags
        .iter()
        .find(|t| t.external.iter().any(|e| e.name == "blue_hair"))
        .unwrap()
        .id
        .clone();
    let purple = snapshot
        .tags
        .iter()
        .find(|t| t.external.iter().any(|e| e.name == "purple_hair"))
        .unwrap()
        .id
        .clone();
    let group = catalog.create_group("发色", None).unwrap();
    let second = catalog
        .create_group("作品", Some(TagNamespace::Work))
        .unwrap();
    workspace
        .edit_group(
            &device,
            &mut catalog,
            &CatalogGroupEdit::AddMembers {
                group_id: group.clone(),
                tag_ids: vec![blue.clone(), purple.clone(), blue.clone()],
            },
            true,
        )
        .unwrap();
    workspace
        .edit_group(
            &device,
            &mut catalog,
            &CatalogGroupEdit::Rename {
                group_id: group.clone(),
                name: "头发颜色".into(),
            },
            true,
        )
        .unwrap();
    workspace
        .edit_group(
            &device,
            &mut catalog,
            &CatalogGroupEdit::OrderMembers {
                group_id: group.clone(),
                tag_ids: vec![purple.clone(), blue.clone()],
            },
            true,
        )
        .unwrap();
    workspace
        .edit_group(
            &device,
            &mut catalog,
            &CatalogGroupEdit::OrderGroups {
                group_ids: vec![second.clone(), group.clone()],
            },
            true,
        )
        .unwrap();
    let groups = workspace
        .tag_groups(&device, &mut catalog, "", "en", true)
        .unwrap();
    assert_eq!(
        groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(),
        ["作品", "头发颜色"]
    );
    assert_eq!(
        groups[1]
            .tags
            .iter()
            .map(|t| t.tag.id.as_str())
            .collect::<Vec<_>>(),
        [purple.as_str(), blue.as_str()]
    );
    workspace
        .edit_group(
            &device,
            &mut catalog,
            &CatalogGroupEdit::RemoveMembers {
                group_id: group.clone(),
                tag_ids: vec![purple],
            },
            true,
        )
        .unwrap();
    assert_eq!(catalog.group_definitions().unwrap()[1].members, [blue]);
    workspace
        .edit_group(
            &device,
            &mut catalog,
            &CatalogGroupEdit::Delete { group_id: second },
            true,
        )
        .unwrap();
    assert_eq!(catalog.group_definitions().unwrap().len(), 1);
    assert_eq!(a.image_tags(&ai, "en").unwrap(), before_a);
    assert_eq!(b.image_tags(&bi, "en").unwrap(), before_b);
}
use kinshoko_core::approx::BuiltinApproxTable;
use kinshoko_core::library::{BrowseScope, ContentRating, ImageEdit, LocalizedName};
use kinshoko_core::search::{ConditionInput, SearchInput, TermInput};
use kinshoko_core::workspace::{WorkspaceQuery, WorkspaceScope};

#[test]
fn shared_group_query_is_visible_or_for_each_source_and_missing_mapping_is_not_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    let (_, blue) = image(&a, dir.path(), "blue", 61, "blue_hair");
    let (_, purple) = image(&b, dir.path(), "purple", 62, "purple_hair");
    let group = a.create_tag_group("发色", None).unwrap();
    a.set_tag_group_tags(&group, &[blue]).unwrap();
    let other = b.create_tag_group("紫色", None).unwrap();
    b.set_tag_group_tags(&other, &[purple]).unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut w = Workspace::open(&app).unwrap();
    let groups = w.tag_groups(&device, &mut catalog, "", "en", true).unwrap();
    let blue = groups.iter().find(|g| g.name == "发色").unwrap().tags[0]
        .tag
        .id
        .clone();
    let purple = groups.iter().find(|g| g.name == "紫色").unwrap().tags[0]
        .tag
        .id
        .clone();
    let group_id = groups.iter().find(|g| g.name == "发色").unwrap().id.clone();
    w.edit_group(
        &device,
        &mut catalog,
        &CatalogGroupEdit::AddMembers {
            group_id,
            tag_ids: vec![purple.clone()],
        },
        true,
    )
    .unwrap();
    let input = |ids: Vec<String>| SearchInput {
        conditions: vec![ConditionInput {
            any: ids
                .into_iter()
                .map(|id| TermInput::Tag {
                    id,
                    dismissed: vec![],
                })
                .collect(),
            negate: false,
        }],
        exact: true,
    };
    let or = w
        .resolve(
            &device,
            &mut catalog,
            &input(vec![blue.clone(), purple]),
            "en",
            true,
            &BuiltinApproxTable::default(),
        )
        .unwrap();
    assert_eq!(or.conditions.len(), 1);
    assert_eq!(or.conditions[0].any.len(), 2);
    let mut query = WorkspaceQuery {
        scope: WorkspaceScope::All,
        conditions: or,
        cursor: None,
        limit: 10,
        thumbnail_px: 240,
    };
    assert_eq!(
        w.browse(&device, &mut catalog, &query, true).unwrap().total,
        2
    );
    query.scope = WorkspaceScope::Library {
        library_id: b.info().id.clone(),
        scope: BrowseScope::All,
    };
    assert_eq!(
        w.browse(&device, &mut catalog, &query, true).unwrap().total,
        1
    );
    query.conditions = w
        .resolve(
            &device,
            &mut catalog,
            &input(vec![blue]),
            "en",
            true,
            &BuiltinApproxTable::default(),
        )
        .unwrap();
    assert_eq!(
        w.browse(&device, &mut catalog, &query, true).unwrap().total,
        0
    );
}

#[test]
fn same_named_legacy_groups_keep_distinct_members_and_sources_and_deleted_group_does_not_return() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    let (_, blue) = image(&a, dir.path(), "blue", 71, "blue_hair");
    let (_, red) = image(&b, dir.path(), "red", 72, "red_hair");
    let ga = a.create_tag_group("发色", None).unwrap();
    a.set_tag_group_tags(&ga, std::slice::from_ref(&blue))
        .unwrap();
    let gb = b.create_tag_group("发色", None).unwrap();
    b.set_tag_group_tags(&gb, std::slice::from_ref(&red))
        .unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut w = Workspace::open(&app).unwrap();
    w.tag_groups(&device, &mut catalog, "", "en", true).unwrap();
    let definitions = catalog.group_definitions().unwrap();
    assert_eq!(definitions.len(), 2);
    let from_a = definitions
        .iter()
        .find(|g| g.sources[0].library_id == a.info().id)
        .unwrap();
    let from_b = definitions
        .iter()
        .find(|g| g.sources[0].library_id == b.info().id)
        .unwrap();
    assert_eq!(from_a.sources[0].group.members, [blue]);
    assert_eq!(from_b.sources[0].group.members, [red]);
    assert_ne!(from_a.members, from_b.members);
    let deleted = from_a.id.clone();
    w.edit_group(
        &device,
        &mut catalog,
        &CatalogGroupEdit::Delete {
            group_id: deleted.clone(),
        },
        true,
    )
    .unwrap();
    drop(w);
    drop(catalog);
    drop(device);
    let device = DeviceLibraries::open(&app).unwrap();
    assert!(device.current().is_none());
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut w = Workspace::open(&app).unwrap();
    let groups = w.tag_groups(&device, &mut catalog, "", "en", true).unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].id, from_b.id);
    let history = catalog.group_migrations().unwrap();
    assert_eq!(history.len(), 2);
    assert!(
        history
            .iter()
            .any(|m| m.source.group.id == ga && m.target.is_none())
    );
    assert!(
        !catalog
            .group_definitions()
            .unwrap()
            .iter()
            .any(|g| g.id == deleted)
    );
}

#[test]
fn cross_source_adult_veto_hides_group_members_and_atomic_edit_preserves_them() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut d = DeviceLibraries::open(&app).unwrap();
    let a = d.create(&dir.path().join("a"), "A").unwrap();
    let b = d.create(&dir.path().join("b"), "B").unwrap();
    let (adult, _) = image(&a, dir.path(), "same", 81, "secret_marker");
    let (unknown, _) = image(&b, dir.path(), "same", 81, "secret_marker");
    let (_, _) = image(&b, dir.path(), "visible", 82, "blue_hair");
    a.edit(
        &[adult],
        &[ImageEdit::SetRating {
            rating: ContentRating::Explicit,
        }],
    )
    .unwrap();
    let mut c = TagCatalog::open(&app).unwrap();
    let mut w = Workspace::open(&app).unwrap();
    w.status(&d, &mut c, false).unwrap();
    let s = c.inspect().unwrap();
    let secret = s
        .tags
        .iter()
        .find(|t| t.external.iter().any(|e| e.name == "secret_marker"))
        .unwrap()
        .id
        .clone();
    let blue = s
        .tags
        .iter()
        .find(|t| t.external.iter().any(|e| e.name == "blue_hair"))
        .unwrap()
        .id
        .clone();
    let group = c.create_group("分组", None).unwrap();
    w.edit_group(
        &d,
        &mut c,
        &CatalogGroupEdit::AddMembers {
            group_id: group.clone(),
            tag_ids: vec![secret.clone(), blue.clone()],
        },
        false,
    )
    .unwrap();
    let visible = w.tag_groups(&d, &mut c, "", "en", true).unwrap();
    assert_eq!(
        visible[0]
            .tags
            .iter()
            .map(|t| t.tag.id.as_str())
            .collect::<Vec<_>>(),
        [blue.as_str()]
    );
    assert_eq!(visible[0].tags[0].count, 1);
    w.edit_group(
        &d,
        &mut c,
        &CatalogGroupEdit::OrderMembers {
            group_id: group.clone(),
            tag_ids: vec![blue.clone()],
        },
        true,
    )
    .unwrap();
    assert!(
        w.edit_group(
            &d,
            &mut c,
            &CatalogGroupEdit::RemoveMembers {
                group_id: group.clone(),
                tag_ids: vec![blue.clone(), secret.clone()]
            },
            true
        )
        .is_err()
    );
    assert_eq!(
        c.group_definitions().unwrap()[0].members,
        [blue.clone(), secret.clone()]
    );
    // Legitimate edits from the filtered management view must preserve invisible members.
    w.edit_group(
        &d,
        &mut c,
        &CatalogGroupEdit::Rename {
            group_id: group.clone(),
            name: "可见部分整理".into(),
        },
        true,
    )
    .unwrap();
    let (_, _) = image(&b, dir.path(), "extra-visible", 83, "red_hair");
    w.status(&d, &mut c, true).unwrap();
    let red = c
        .inspect()
        .unwrap()
        .tags
        .into_iter()
        .find(|tag| tag.external.iter().any(|e| e.name == "red_hair"))
        .unwrap()
        .id;
    w.edit_group(
        &d,
        &mut c,
        &CatalogGroupEdit::AddMembers {
            group_id: group.clone(),
            tag_ids: vec![red.clone()],
        },
        true,
    )
    .unwrap();
    w.edit_group(
        &d,
        &mut c,
        &CatalogGroupEdit::RemoveMembers {
            group_id: group.clone(),
            tag_ids: vec![blue.clone()],
        },
        true,
    )
    .unwrap();
    w.edit_group(
        &d,
        &mut c,
        &CatalogGroupEdit::OrderMembers {
            group_id: group.clone(),
            tag_ids: vec![red.clone()],
        },
        true,
    )
    .unwrap();
    w.edit_group(
        &d,
        &mut c,
        &CatalogGroupEdit::OrderGroups {
            group_ids: vec![group.clone()],
        },
        true,
    )
    .unwrap();
    let all = w.tag_groups(&d, &mut c, "", "en", false).unwrap();
    assert_eq!(all[0].name, "可见部分整理");
    assert_eq!(
        all[0]
            .tags
            .iter()
            .map(|t| t.tag.id.as_str())
            .collect::<Vec<_>>(),
        [red.as_str(), secret.as_str()]
    );
    let safe = w.shared_tag_groups(&d, &mut c, "en", true).unwrap();
    assert_eq!(
        safe[0]
            .tags
            .iter()
            .map(|t| t.tag.id.as_str())
            .collect::<Vec<_>>(),
        [red.as_str()]
    );
    assert!(a.safe_mode());
    assert!(b.safe_mode());
    assert_eq!(b.image_tags(&unknown, "en").unwrap().tags.len(), 1);
}

use kinshoko_core::library::TagEdit;

#[test]
fn namespace_groups_follow_new_members_and_current_shared_name_preferences() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut d = DeviceLibraries::open(&app).unwrap();
    let a = d.create(&dir.path().join("a"), "A").unwrap();
    let (ai, _) = image(&a, dir.path(), "a", 91, "blue_hair");
    a.edit_tags(
        &[ai],
        &[TagEdit::Add {
            tag: TagRef::Named {
                namespace: TagNamespace::Work,
                name: "星海".into(),
                lang: "zh-CN".into(),
            },
        }],
    )
    .unwrap();
    let mut c = TagCatalog::open(&app).unwrap();
    let mut w = Workspace::open(&app).unwrap();
    let group = c.create_group("作品", Some(TagNamespace::Work)).unwrap();
    let original = w.tag_groups(&d, &mut c, "", "zh-CN", true).unwrap();
    assert_eq!(original[0].tags.len(), 1);
    let work_id = original[0].tags[0].tag.id.clone();
    c.set_name_preference(
        &work_id,
        &LocalizedName {
            lang: "zh-CN".into(),
            name: "星海计划".into(),
        },
    )
    .unwrap();
    let b = d.create(&dir.path().join("b"), "B").unwrap();
    let (bi, _) = image(&b, dir.path(), "b", 92, "purple_hair");
    b.edit_tags(
        &[bi],
        &[TagEdit::Add {
            tag: TagRef::Named {
                namespace: TagNamespace::Work,
                name: "月岛".into(),
                lang: "zh-CN".into(),
            },
        }],
    )
    .unwrap();
    let groups = w.tag_groups(&d, &mut c, "", "zh-CN", true).unwrap();
    assert_eq!(groups[0].id, group);
    assert_eq!(
        groups[0]
            .tags
            .iter()
            .map(|t| t.tag.name.as_str())
            .collect::<Vec<_>>(),
        ["星海计划", "月岛"]
    );
    assert!(
        w.edit_group(
            &d,
            &mut c,
            &CatalogGroupEdit::AddMembers {
                group_id: group,
                tag_ids: vec![work_id]
            },
            true
        )
        .is_err()
    );
}
