//! 工作区查找：同义标签的全局条件、分页修订号与多目录。
use super::*;

#[test]
fn selected_tag_keeps_its_name_when_its_only_image_is_trashed() {
    use kinshoko_core::search::Term;

    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let library = device.create(&dir.path().join("a"), "A").unwrap();
    let image = files(dir.path(), &[&library], 18);
    tag(&library, &image[0], &["blue_eyes"]);
    files(dir.path(), &[&library], 19);
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let builtin = BuiltinApproxTable::default();
    let candidates = workspace
        .candidates(&device, &mut catalog, "blue eyes", "en", 10, true, &builtin)
        .unwrap();
    let candidate = &candidates[0];
    assert_eq!(candidate.count, 1);
    let input = SearchInput {
        conditions: vec![ConditionInput {
            any: vec![TermInput::Tag {
                id: candidate.tag.id.clone(),
                dismissed: vec![],
            }],
            negate: false,
        }],
        exact: true,
    };
    let mut observe = |state| {
        let conditions = workspace
            .resolve(&device, &mut catalog, &input, "en", true, &builtin)
            .unwrap();
        let resolved = match conditions.conditions[0].any.as_slice() {
            [Term::Tag { tag, .. }] => Some(tag.clone()),
            [] => None,
            other => panic!("unexpected resolved terms: {other:?}"),
        };
        let page = workspace
            .browse(
                &device,
                &mut catalog,
                &WorkspaceQuery {
                    conditions,
                    ..query()
                },
                true,
            )
            .unwrap();
        let candidates = workspace
            .candidates(&device, &mut catalog, "blue eyes", "en", 10, true, &builtin)
            .unwrap();
        assert_eq!(candidates.len(), page.total as usize);
        println!(
            "{state}: resolved tag = {:?}, results = {}",
            resolved.as_ref().map(|tag| tag.name.as_str()),
            page.total
        );
        (resolved, page.total)
    };

    assert_eq!(observe("active"), (Some(candidate.tag.clone()), 1));
    library.edit(&image, &[ImageEdit::Delete]).unwrap();
    assert_eq!(observe("trashed"), (Some(candidate.tag.clone()), 0));
    library.edit(&image, &[ImageEdit::Restore]).unwrap();
    assert_eq!(observe("restored"), (Some(candidate.tag.clone()), 1));
}

#[test]
fn a_large_any_tag_search_still_browses_after_most_tags_lose_their_only_live_image() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let library = device.create(&dir.path().join("a"), "A").unwrap();
    let active = files(dir.path(), &[&library], 18);
    let trashed = files(dir.path(), &[&library], 19);
    let names: Vec<String> = (0..1_100).map(|i| format!("bulk-tag-{i}")).collect();
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    tag(&library, &active[0], &names[..1]);
    tag(&library, &trashed[0], &names);
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let builtin = BuiltinApproxTable::default();
    let candidates = workspace
        .candidates(
            &device,
            &mut catalog,
            "bulk-tag-",
            "en",
            names.len(),
            true,
            &builtin,
        )
        .unwrap();
    assert_eq!(candidates.len(), names.len());
    let input = SearchInput {
        conditions: vec![ConditionInput {
            any: candidates
                .into_iter()
                .map(|candidate| TermInput::Tag {
                    id: candidate.tag.id,
                    dismissed: vec![],
                })
                .collect(),
            negate: false,
        }],
        exact: true,
    };
    library.edit(&trashed, &[ImageEdit::Delete]).unwrap();
    let conditions = workspace
        .resolve(&device, &mut catalog, &input, "en", true, &builtin)
        .unwrap();
    assert_eq!(conditions.conditions[0].any.len(), names.len());
    let page = workspace
        .browse(
            &device,
            &mut catalog,
            &WorkspaceQuery {
                conditions,
                ..query()
            },
            true,
        )
        .unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.cards[0].image_id, active[0]);
}

#[test]
fn mapped_local_synonyms_are_or_within_one_global_condition_and_and_between_conditions() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    let ai = files(dir.path(), &[&a], 30)[0].clone();
    let bi = files(dir.path(), &[&b], 60)[0].clone();
    tag(&a, &ai, &["blue_eyes", "short_hair"]);
    b.edit_tags(
        std::slice::from_ref(&bi),
        &[TagEdit::Add {
            tag: TagRef::Named {
                namespace: TagNamespace::General,
                name: "azure".into(),
                lang: "en".into(),
            },
        }],
    )
    .unwrap();
    let local = b.vocabulary().unwrap().tags[0].id.clone();
    let mut catalog = TagCatalog::open(&app).unwrap();
    catalog.synchronize(&a).unwrap();
    catalog.synchronize(&b).unwrap();
    let blue_local = a
        .vocabulary()
        .unwrap()
        .tags
        .into_iter()
        .find(|t| t.external.contains(&"blue_eyes".into()))
        .unwrap()
        .id;
    let blue = catalog
        .inspect()
        .unwrap()
        .mappings
        .iter()
        .find(|m| m.local_tag_id == blue_local)
        .unwrap()
        .catalog_id
        .clone();
    catalog
        .correct(
            &b,
            &local,
            CatalogCorrection::Use {
                catalog_id: blue.clone(),
            },
        )
        .unwrap();
    let extra = files(dir.path(), &[&b], 90)[0].clone();
    tag(&b, &extra, &["blue_eyes"]);
    let mut workspace = Workspace::open(&app).unwrap();
    let builtin = BuiltinApproxTable::default();
    let input = SearchInput {
        conditions: vec![ConditionInput {
            any: vec![TermInput::Tag {
                id: blue.clone(),
                dismissed: vec![],
            }],
            negate: false,
        }],
        exact: true,
    };
    let tree = workspace
        .resolve(&device, &mut catalog, &input, "en", true, &builtin)
        .unwrap();
    assert_eq!(
        workspace
            .browse(
                &device,
                &mut catalog,
                &WorkspaceQuery {
                    conditions: tree.clone(),
                    ..query()
                },
                true
            )
            .unwrap()
            .total,
        3
    );
    let missing = SearchInput {
        conditions: vec![ConditionInput {
            any: vec![TermInput::Tag {
                id: "not-a-global-tag".into(),
                dismissed: vec![],
            }],
            negate: false,
        }],
        exact: true,
    };
    let missing_tree = workspace
        .resolve(&device, &mut catalog, &missing, "en", true, &builtin)
        .unwrap();
    assert!(missing_tree.conditions[0].any.is_empty());
    assert_eq!(
        workspace
            .browse(
                &device,
                &mut catalog,
                &WorkspaceQuery {
                    conditions: missing_tree.clone(),
                    ..query()
                },
                true
            )
            .unwrap()
            .total,
        0
    );
    let mut any_tree = tree.clone();
    any_tree.conditions[0]
        .any
        .extend(missing_tree.conditions[0].any.clone());
    assert_eq!(
        workspace
            .browse(
                &device,
                &mut catalog,
                &WorkspaceQuery {
                    conditions: any_tree,
                    ..query()
                },
                true
            )
            .unwrap()
            .total,
        3
    );
    let mut empty = tree;
    empty.conditions.push(Condition {
        any: vec![],
        negate: false,
    });
    assert_eq!(
        workspace
            .browse(
                &device,
                &mut catalog,
                &WorkspaceQuery {
                    conditions: empty.clone(),
                    ..query()
                },
                true
            )
            .unwrap()
            .total,
        0
    );
    empty.conditions[1].negate = true;
    assert_eq!(
        workspace
            .browse(
                &device,
                &mut catalog,
                &WorkspaceQuery {
                    conditions: empty,
                    ..query()
                },
                true
            )
            .unwrap()
            .total,
        3
    );
    let mut exclude = input;
    exclude.conditions[0].negate = true;
    let tree = workspace
        .resolve(&device, &mut catalog, &exclude, "en", true, &builtin)
        .unwrap();
    assert_eq!(
        workspace
            .browse(
                &device,
                &mut catalog,
                &WorkspaceQuery {
                    conditions: tree,
                    ..query()
                },
                true
            )
            .unwrap()
            .total,
        0
    );
}
