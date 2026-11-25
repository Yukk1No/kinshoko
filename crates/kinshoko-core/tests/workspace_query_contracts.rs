//! 工作区查询契约：分页、稳定 id、修订号与空条件组。
use super::*;

#[test]
fn paging_counts_stable_hash_ids_and_stale_provider_catalog_scope_and_safe_revisions_agree() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    let same = files(dir.path(), &[&a, &b], 55);
    files(dir.path(), &[&b], 66);
    files(dir.path(), &[&a], 77);
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let first = workspace
        .browse(&device, &mut catalog, &query(), true)
        .unwrap();
    let second = workspace
        .browse(
            &device,
            &mut catalog,
            &WorkspaceQuery {
                cursor: first.next_cursor.clone(),
                ..query()
            },
            true,
        )
        .unwrap();
    let third = workspace
        .browse(
            &device,
            &mut catalog,
            &WorkspaceQuery {
                cursor: second.next_cursor.clone(),
                ..query()
            },
            true,
        )
        .unwrap();
    assert_eq!([first.total, second.total, third.total], [3, 3, 3]);
    assert!(third.next_cursor.is_none());
    assert_eq!(
        [&first.cards[0].id, &second.cards[0].id, &third.cards[0].id]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        3
    );
    let cursor = first.next_cursor.clone();
    assert!(
        workspace
            .browse(
                &device,
                &mut catalog,
                &WorkspaceQuery {
                    cursor: cursor.clone(),
                    ..query()
                },
                false
            )
            .is_err()
    );
    let scoped = WorkspaceQuery {
        scope: WorkspaceScope::Library {
            library_id: a.info().id.clone(),
            scope: Default::default(),
        },
        cursor: cursor.clone(),
        ..query()
    };
    assert!(
        workspace
            .browse(&device, &mut catalog, &scoped, true)
            .is_err()
    );
    tag(&a, &same[0], &["blue_eyes"]);
    assert!(
        workspace
            .browse(
                &device,
                &mut catalog,
                &WorkspaceQuery { cursor, ..query() },
                true
            )
            .is_err()
    );
    let first = workspace
        .browse(&device, &mut catalog, &query(), true)
        .unwrap();
    let same_id = workspace
        .browse(
            &device,
            &mut catalog,
            &WorkspaceQuery {
                limit: 10,
                ..query()
            },
            true,
        )
        .unwrap()
        .cards
        .into_iter()
        .find(|c| c.sources.len() == 2)
        .unwrap()
        .id;
    device.switch(&a.info().id).unwrap();
    assert_eq!(
        workspace
            .browse(
                &device,
                &mut catalog,
                &WorkspaceQuery {
                    limit: 10,
                    ..query()
                },
                true
            )
            .unwrap()
            .cards
            .into_iter()
            .find(|c| c.sources.len() == 2)
            .unwrap()
            .id,
        same_id
    );
    let local = a.vocabulary().unwrap().tags[0].id.clone();
    catalog
        .correct(&a, &local, CatalogCorrection::Separate)
        .unwrap();
    assert!(
        workspace
            .browse(
                &device,
                &mut catalog,
                &WorkspaceQuery {
                    cursor: first.next_cursor,
                    ..query()
                },
                true
            )
            .is_err()
    );
}

#[test]
fn an_explicit_empty_any_group_never_becomes_an_unconditional_workspace_query() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    files(dir.path(), &[&a], 150);
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let mut input = SearchInput {
        conditions: vec![ConditionInput {
            any: vec![],
            negate: false,
        }],
        exact: true,
    };
    let tree = workspace
        .resolve(
            &device,
            &mut catalog,
            &input,
            "en",
            true,
            &BuiltinApproxTable::default(),
        )
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
    input.conditions[0].negate = true;
    let tree = workspace
        .resolve(
            &device,
            &mut catalog,
            &input,
            "en",
            true,
            &BuiltinApproxTable::default(),
        )
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
        1
    );
}
