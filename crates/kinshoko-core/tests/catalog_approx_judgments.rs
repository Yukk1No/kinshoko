//! 统一近义判断：明确判断、内置更新与安全模式下的个人规则（从 catalog_approx.rs 原样搬出）。
use super::*;

#[test]
fn an_explicit_global_judgment_survives_a_later_opposite_source_and_ignoring_it() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    image(&a, dir.path(), "a-blue", 10, "blue_eyes");
    image(&a, dir.path(), "a-aqua", 20, "aqua_eyes");
    let b = Library::create(&dir.path().join("b"), "later B").unwrap();
    let blue_b = image(&b, dir.path(), "b-blue", 30, "blue_eyes");
    let aqua_b = image(&b, dir.path(), "b-aqua", 40, "aqua_eyes");
    b.set_tag_approx(&blue_b, &aqua_b, ApproxRelation::Similar)
        .unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    workspace.status(&device, &mut catalog, true).unwrap();
    let blue = shared(&catalog, "blue_eyes");
    let aqua = shared(&catalog, "aqua_eyes");
    workspace
        .edit_approx(
            &device,
            &mut catalog,
            &CatalogApproxEdit::Set {
                rules: vec![kinshoko_core::approx::PersonalApprox {
                    a: blue.clone(),
                    b: aqua.clone(),
                    relation: ApproxRelation::NotSimilar,
                }],
            },
            true,
        )
        .unwrap();
    device.register(&b.info().root).unwrap();
    let view = workspace
        .personal_approx(&device, &mut catalog, "en", true)
        .unwrap();
    assert_eq!(view.entries[0].relation, ApproxRelation::NotSimilar);
    assert_eq!(view.conflicts.len(), 1);
    assert_eq!(view.conflicts[0].current, Some(ApproxRelation::NotSimilar));
    workspace
        .edit_approx(
            &device,
            &mut catalog,
            &CatalogApproxEdit::ResolveConflict {
                a: blue.clone(),
                b: aqua.clone(),
                revision: view.revision,
                relation: None,
            },
            true,
        )
        .unwrap();
    let view = workspace
        .personal_approx(&device, &mut catalog, "en", true)
        .unwrap();
    assert!(view.conflicts.is_empty());
    assert_eq!(
        view.entries.len(),
        1,
        "ignore a new legacy source must retain the explicit global judgment"
    );
    assert_eq!(view.entries[0].relation, ApproxRelation::NotSimilar);
    let table = BuiltinApproxTable::from_pairs(999, [("blue_eyes", "aqua_eyes")]);
    let tree = workspace
        .resolve(&device, &mut catalog, &input(&blue), "en", true, &table)
        .unwrap();
    let Term::Tag { similar, .. } = &tree.conditions[0].any[0] else {
        panic!("tag")
    };
    assert!(similar.is_empty());
}

#[test]
fn builtin_updates_and_search_operators_preserve_explicit_judgments_and_atomic_edits() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    image(&a, dir.path(), "blue", 10, "blue_eyes");
    image(&a, dir.path(), "aqua", 20, "aqua_eyes");
    image(&a, dir.path(), "red", 30, "red_eyes");
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    workspace.status(&device, &mut catalog, true).unwrap();
    let blue = shared(&catalog, "blue_eyes");
    let aqua = shared(&catalog, "aqua_eyes");
    let red = shared(&catalog, "red_eyes");
    let rule =
        |a: String, b: String, relation| kinshoko_core::approx::PersonalApprox { a, b, relation };
    workspace
        .edit_approx(
            &device,
            &mut catalog,
            &CatalogApproxEdit::Set {
                rules: vec![
                    rule(blue.clone(), aqua.clone(), ApproxRelation::NotSimilar),
                    rule(blue.clone(), red.clone(), ApproxRelation::Similar),
                ],
            },
            true,
        )
        .unwrap();
    let builtin = BuiltinApproxTable::from_pairs(
        1000,
        [("blue_eyes", "aqua_eyes"), ("blue_eyes", "red_eyes")],
    );
    let found = |w: &mut Workspace, c: &mut TagCatalog, search: &SearchInput| {
        let tree = w.resolve(&device, c, search, "en", true, &builtin).unwrap();
        w.browse(
            &device,
            c,
            &WorkspaceQuery {
                conditions: tree,
                scope: Default::default(),
                cursor: None,
                limit: 100,
                known_placeholders: Vec::new(),
            },
            true,
        )
        .unwrap()
        .total
    };
    assert_eq!(found(&mut workspace, &mut catalog, &input(&blue)), 2);
    let mut exact = input(&blue);
    exact.exact = true;
    assert_eq!(found(&mut workspace, &mut catalog, &exact), 1);
    exact.conditions[0].any.push(TermInput::Tag {
        id: aqua.clone(),
        dismissed: vec![],
    });
    assert_eq!(found(&mut workspace, &mut catalog, &exact), 2);
    let mut excluded = input(&blue);
    excluded.conditions[0].negate = true;
    assert_eq!(found(&mut workspace, &mut catalog, &excluded), 1);
    let mut and = input(&blue);
    and.conditions.push(input(&aqua).conditions.remove(0));
    assert_eq!(found(&mut workspace, &mut catalog, &and), 0);
    let before = catalog.approx_definitions().unwrap();
    assert!(
        workspace
            .edit_approx(
                &device,
                &mut catalog,
                &CatalogApproxEdit::Set {
                    rules: vec![
                        rule(blue.clone(), red.clone(), ApproxRelation::NotSimilar),
                        rule(blue, "missing-id".into(), ApproxRelation::Similar)
                    ]
                },
                true
            )
            .is_err()
    );
    assert_eq!(
        catalog.approx_definitions().unwrap(),
        before,
        "a rejected batch cannot partly replace a valid judgment"
    );
}

#[test]
fn personal_rule_settings_share_all_source_adult_veto_and_keep_complete_backup_definitions() {
    use kinshoko_core::library::{ContentRating, ImageEdit};
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device
        .create(&dir.path().join("a"), "adult source")
        .unwrap();
    let b = device
        .create(&dir.path().join("b"), "unknown copy")
        .unwrap();
    image(&a, dir.path(), "adult-blue", 10, "blue_eyes");
    let blue_b = image(&b, dir.path(), "same-blue", 10, "blue_eyes");
    let aqua_b = image(&b, dir.path(), "public-aqua", 20, "aqua_eyes");
    b.set_tag_approx(&blue_b, &aqua_b, ApproxRelation::NotSimilar)
        .unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    assert_eq!(
        workspace
            .personal_approx(&device, &mut catalog, "en", false)
            .unwrap()
            .entries
            .len(),
        1
    );
    let blue = shared(&catalog, "blue_eyes");
    let aqua = shared(&catalog, "aqua_eyes");
    let adult_image = a
        .browse(&kinshoko_core::library::BrowseQuery {
            scope: Default::default(),
            conditions: Default::default(),
            cursor: None,
            limit: 10,
            thumbnail_px: 128,
        })
        .unwrap()
        .cards[0]
        .id
        .clone();
    a.set_safe_mode(false);
    a.edit(
        &[adult_image],
        &[ImageEdit::SetRating {
            rating: ContentRating::Explicit,
        }],
    )
    .unwrap();
    a.set_safe_mode(true);
    let safe = workspace
        .personal_approx(&device, &mut catalog, "en", true)
        .unwrap();
    assert!(safe.entries.is_empty());
    assert!(safe.conflicts.is_empty());
    assert!(
        workspace
            .edit_approx(
                &device,
                &mut catalog,
                &CatalogApproxEdit::Remove { a: blue, b: aqua },
                true
            )
            .is_err()
    );
    assert_eq!(catalog.approx_definitions().unwrap().len(), 1);
    assert_eq!(catalog.approx_migrations().unwrap().len(), 1);
    assert_eq!(
        workspace
            .personal_approx(&device, &mut catalog, "en", false)
            .unwrap()
            .entries
            .len(),
        1
    );
    assert!(a.safe_mode());
    assert!(
        b.safe_mode(),
        "detached settings inspection cannot switch the active provider's lens"
    );
}
