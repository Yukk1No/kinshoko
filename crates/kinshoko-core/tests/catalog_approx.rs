//! T06: application-wide personal approximate search through real providers.
use image::{Rgba, RgbaImage};
use kinshoko_core::approx::{ApproxRelation, BuiltinApproxTable};
use kinshoko_core::library::{FactSource, ImportSource, SourceTag, TagNamespace, TagRef};
use kinshoko_core::search::{ConditionInput, SearchInput, Term, TermInput};
use kinshoko_core::tag_catalog::TagCatalog;
use kinshoko_core::workspace::{Workspace, WorkspaceQuery};
use kinshoko_core::{DeviceLibraries, Library};
use std::path::Path;

fn image(library: &Library, root: &Path, name: &str, red: u8, external: &str) -> String {
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
    library
        .vocabulary()
        .unwrap()
        .tags
        .into_iter()
        .find(|t| t.external.contains(&external.to_owned()))
        .unwrap()
        .id
}
fn input(id: &str) -> SearchInput {
    SearchInput {
        conditions: vec![ConditionInput {
            any: vec![TermInput::Tag {
                id: id.into(),
                dismissed: vec![],
            }],
            negate: false,
        }],
        exact: false,
    }
}
fn shared(catalog: &TagCatalog, external: &str) -> String {
    catalog
        .inspect()
        .unwrap()
        .tags
        .into_iter()
        .find(|t| t.external.iter().any(|e| e.name == external))
        .unwrap()
        .id
}

#[test]
fn legacy_not_similar_applies_to_every_library_and_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    let blue_a = image(&a, dir.path(), "a-blue", 10, "blue_eyes");
    let aqua_a = image(&a, dir.path(), "a-aqua", 20, "aqua_eyes");
    let blue_b = image(&b, dir.path(), "b-blue", 30, "blue_eyes");
    image(&b, dir.path(), "b-aqua", 40, "aqua_eyes");
    assert_ne!(blue_a, blue_b);
    a.set_tag_approx(&blue_a, &aqua_a, ApproxRelation::NotSimilar)
        .unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    workspace.status(&device, &mut catalog, true).unwrap();
    let blue = shared(&catalog, "blue_eyes");
    let tree = workspace
        .resolve(
            &device,
            &mut catalog,
            &input(&blue),
            "en",
            true,
            &BuiltinApproxTable::bundled(),
        )
        .unwrap();
    let Term::Tag { similar, .. } = &tree.conditions[0].any[0] else {
        panic!("tag condition")
    };
    assert!(
        similar.is_empty(),
        "A's personal rejection must override the built-in pair for B too"
    );
    let result = workspace
        .browse(
            &device,
            &mut catalog,
            &WorkspaceQuery {
                conditions: tree,
                scope: Default::default(),
                cursor: None,
                limit: 100,
                thumbnail_px: 256,
            },
            true,
        )
        .unwrap();
    assert_eq!(result.total, 2);
    drop(catalog);
    drop(workspace);
    device.switch(&a.info().id).unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let tree = workspace
        .resolve(
            &device,
            &mut catalog,
            &input(&blue),
            "en",
            true,
            &BuiltinApproxTable::bundled(),
        )
        .unwrap();
    let result = workspace
        .browse(
            &device,
            &mut catalog,
            &WorkspaceQuery {
                conditions: tree,
                scope: Default::default(),
                cursor: None,
                limit: 100,
                thumbnail_px: 256,
            },
            true,
        )
        .unwrap();
    assert_eq!(result.total, 2);
}

#[test]
fn opposite_legacy_rules_wait_for_a_choice_in_either_registration_order() {
    for reverse in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("app");
        let mut device = DeviceLibraries::open(&app).unwrap();
        let a = device.create(&dir.path().join("a"), "A").unwrap();
        let b = device.create(&dir.path().join("b"), "B").unwrap();
        let blue_a = image(&a, dir.path(), "a-blue", 10, "blue_eyes");
        let aqua_a = image(&a, dir.path(), "a-aqua", 20, "aqua_eyes");
        let blue_b = image(&b, dir.path(), "b-blue", 30, "blue_eyes");
        let aqua_b = image(&b, dir.path(), "b-aqua", 40, "aqua_eyes");
        a.set_tag_approx(&blue_a, &aqua_a, ApproxRelation::Similar)
            .unwrap();
        b.set_tag_approx(&blue_b, &aqua_b, ApproxRelation::NotSimilar)
            .unwrap();
        let mut catalog = TagCatalog::open(&app).unwrap();
        let mut workspace = Workspace::open(&app).unwrap();
        // Materialize the first provider before registering the other one, to test temporal order.
        device
            .unregister(if reverse { &a.info().id } else { &b.info().id })
            .unwrap();
        workspace.status(&device, &mut catalog, true).unwrap();
        device
            .register(if reverse {
                &a.info().root
            } else {
                &b.info().root
            })
            .unwrap();
        let blue = shared(&catalog, "blue_eyes");
        let tree = workspace
            .resolve(
                &device,
                &mut catalog,
                &input(&blue),
                "en",
                true,
                &BuiltinApproxTable::bundled(),
            )
            .unwrap();
        let Term::Tag { similar, .. } = &tree.conditions[0].any[0] else {
            panic!("tag condition")
        };
        assert!(
            similar.is_empty(),
            "an unresolved opposite legacy judgment must not silently expand by order or built-in fallback"
        );
    }
}

use kinshoko_core::library::TagEdit;
use kinshoko_core::tag_catalog::CatalogApproxEdit;

#[test]
fn plus_supports_no_external_mapping_and_once_does_not_change_the_saved_rule() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    image(&a, dir.path(), "a-blue", 10, "blue_eyes");
    image(&b, dir.path(), "b-blue", 20, "blue_eyes");
    let path = dir.path().join("sky.png");
    RgbaImage::from_pixel(4, 3, Rgba([55, 56, 57, 255]))
        .save(&path)
        .unwrap();
    let sky_image = b.import(ImportSource { paths: vec![path] }).wait().items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();
    b.edit_tags(
        std::slice::from_ref(&sky_image),
        &[TagEdit::Add {
            tag: TagRef::Named {
                namespace: TagNamespace::General,
                name: "天空色".into(),
                lang: "zh-CN".into(),
            },
        }],
    )
    .unwrap();
    let before = b.image_tags(&sky_image, "zh-CN").unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    workspace.status(&device, &mut catalog, true).unwrap();
    let blue = shared(&catalog, "blue_eyes");
    let sky = catalog
        .inspect()
        .unwrap()
        .tags
        .into_iter()
        .find(|t| t.names.iter().any(|n| n.name == "天空色"))
        .unwrap()
        .id;
    workspace
        .edit_approx(
            &device,
            &mut catalog,
            &CatalogApproxEdit::Set {
                rules: vec![kinshoko_core::approx::PersonalApprox {
                    a: blue.clone(),
                    b: sky.clone(),
                    relation: ApproxRelation::Similar,
                }],
            },
            true,
        )
        .unwrap();
    let resolved = |workspace: &mut Workspace, catalog: &mut TagCatalog, search: &SearchInput| {
        let tree = workspace
            .resolve(
                &device,
                catalog,
                search,
                "zh-CN",
                true,
                &BuiltinApproxTable::bundled(),
            )
            .unwrap();
        workspace
            .browse(
                &device,
                catalog,
                &WorkspaceQuery {
                    conditions: tree,
                    scope: Default::default(),
                    cursor: None,
                    limit: 100,
                    thumbnail_px: 256,
                },
                true,
            )
            .unwrap()
            .total
    };
    assert_eq!(resolved(&mut workspace, &mut catalog, &input(&blue)), 3);
    let once = SearchInput {
        conditions: vec![ConditionInput {
            any: vec![TermInput::Tag {
                id: blue.clone(),
                dismissed: vec![sky.clone()],
            }],
            negate: false,
        }],
        exact: false,
    };
    assert_eq!(resolved(&mut workspace, &mut catalog, &once), 2);
    assert_eq!(
        resolved(&mut workspace, &mut catalog, &input(&blue)),
        3,
        "once must not erase a saved rule"
    );
    assert_eq!(
        b.image_tags(&sky_image, "zh-CN").unwrap(),
        before,
        "approximate search must not merge tag granularity or image decisions"
    );
    drop(catalog);
    let mut catalog = TagCatalog::open(&app).unwrap();
    assert_eq!(resolved(&mut workspace, &mut catalog, &input(&blue)), 3);
}

#[test]
fn legacy_conflict_has_named_sources_and_ignore_is_remembered_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "旧判断 A").unwrap();
    let b = device.create(&dir.path().join("b"), "旧判断 B").unwrap();
    let ba = image(&a, dir.path(), "a-blue", 10, "blue_eyes");
    let aa = image(&a, dir.path(), "a-aqua", 20, "aqua_eyes");
    let bb = image(&b, dir.path(), "b-blue", 30, "blue_eyes");
    let ab = image(&b, dir.path(), "b-aqua", 40, "aqua_eyes");
    a.set_tag_approx(&ba, &aa, ApproxRelation::Similar).unwrap();
    b.set_tag_approx(&bb, &ab, ApproxRelation::NotSimilar)
        .unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let view = workspace
        .personal_approx(&device, &mut catalog, "en", true)
        .unwrap();
    assert!(
        view.entries.is_empty(),
        "a conflict is not a saved personal NotSimilar rule"
    );
    assert_eq!(view.conflicts.len(), 1);
    let conflict = &view.conflicts[0];
    let mut names = conflict
        .sources
        .iter()
        .map(|s| s.library_name.as_str())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, ["旧判断 A", "旧判断 B"]);
    assert!(
        conflict
            .sources
            .iter()
            .any(|s| s.relation == ApproxRelation::Similar)
    );
    assert!(
        conflict
            .sources
            .iter()
            .any(|s| s.relation == ApproxRelation::NotSimilar)
    );
    let (blue, aqua) = (shared(&catalog, "blue_eyes"), shared(&catalog, "aqua_eyes"));
    workspace
        .edit_approx(
            &device,
            &mut catalog,
            &CatalogApproxEdit::ResolveConflict {
                a: conflict.a.id.clone(),
                b: conflict.b.id.clone(),
                revision: view.revision,
                relation: None,
            },
            true,
        )
        .unwrap();
    assert!(
        workspace
            .personal_approx(&device, &mut catalog, "en", true)
            .unwrap()
            .conflicts
            .is_empty()
    );
    assert!(
        catalog
            .approx_migrations()
            .unwrap()
            .iter()
            .all(|s| s.confirmed)
    );
    assert!(
        catalog
            .approx_decisions()
            .unwrap()
            .iter()
            .any(|d| d.explicit && d.relation.is_none())
    );
    drop(workspace);
    drop(catalog);
    let mut workspace = Workspace::open(&app).unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let view = workspace
        .personal_approx(&device, &mut catalog, "en", true)
        .unwrap();
    assert!(view.conflicts.is_empty());
    assert!(view.entries.is_empty());
    let tree = workspace
        .resolve(
            &device,
            &mut catalog,
            &input(&blue),
            "en",
            true,
            &BuiltinApproxTable::bundled(),
        )
        .unwrap();
    let Term::Tag { similar, .. } = &tree.conditions[0].any[0] else {
        panic!("tag")
    };
    assert_eq!(similar.len(), 1);
    assert_eq!(similar[0].tag.id, aqua);
    assert_eq!(
        similar[0].source,
        kinshoko_core::approx::ApproxSource::Builtin
    );
}

#[test]
fn deleting_a_migrated_rule_restores_builtin_without_reimporting_the_old_judgment() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let blue_local = image(&a, dir.path(), "blue", 10, "blue_eyes");
    let aqua_local = image(&a, dir.path(), "aqua", 20, "aqua_eyes");
    a.set_tag_approx(&blue_local, &aqua_local, ApproxRelation::NotSimilar)
        .unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let view = workspace
        .personal_approx(&device, &mut catalog, "en", true)
        .unwrap();
    assert_eq!(view.entries.len(), 1);
    let blue = shared(&catalog, "blue_eyes");
    let aqua = shared(&catalog, "aqua_eyes");
    workspace
        .edit_approx(
            &device,
            &mut catalog,
            &CatalogApproxEdit::Remove {
                a: blue.clone(),
                b: aqua.clone(),
            },
            true,
        )
        .unwrap();
    drop(catalog);
    drop(workspace);
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let view = workspace
        .personal_approx(&device, &mut catalog, "en", true)
        .unwrap();
    assert!(view.entries.is_empty());
    assert!(view.conflicts.is_empty());
    let tree = workspace
        .resolve(
            &device,
            &mut catalog,
            &input(&blue),
            "en",
            true,
            &BuiltinApproxTable::from_pairs(99, [("blue_eyes", "aqua_eyes")]),
        )
        .unwrap();
    let Term::Tag { similar, .. } = &tree.conditions[0].any[0] else {
        panic!("tag")
    };
    assert_eq!(similar.len(), 1);
    assert_eq!(similar[0].tag.id, aqua);
    assert_eq!(
        a.personal_approx("en").unwrap().len(),
        1,
        "legacy provider rows stay unchanged as provenance"
    );
    assert!(
        catalog
            .approx_migrations()
            .unwrap()
            .iter()
            .all(|m| m.confirmed)
    );
    assert!(
        catalog
            .approx_decisions()
            .unwrap()
            .iter()
            .any(|d| d.explicit && d.relation.is_none())
    );
}

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
                thumbnail_px: 256,
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
