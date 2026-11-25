//! 工作区同义标签映射在全局“任一/同时”条件里的展开。
use super::*;

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
