use image::{Rgba, RgbaImage};
use kinshoko_core::approx::BuiltinApproxTable;
use kinshoko_core::library::{FactSource, ImportSource, SourceTag, TagNamespace, TagRef};
use kinshoko_core::search::{ConditionInput, SearchInput, TermInput};
use kinshoko_core::tag_catalog::TagCatalog;
use kinshoko_core::workspace::{Workspace, WorkspaceQuery, WorkspaceScope};
use kinshoko_core::{DeviceLibraries, Library};

fn import(library: &Library, path: &std::path::Path) -> String {
    library
        .import(ImportSource {
            paths: vec![path.into()],
        })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned()
}
fn tag(library: &Library, id: &str, names: &[&str]) {
    library
        .replace_source_tags(
            &FactSource::model("test"),
            id,
            &names
                .iter()
                .map(|name| SourceTag {
                    tag: TagRef::External {
                        namespace: TagNamespace::General,
                        name: (*name).into(),
                    },
                    score: None,
                })
                .collect::<Vec<_>>(),
        )
        .unwrap();
}
#[test]
fn each_source_must_match_all_conditions_before_identical_bytes_are_aggregated() {
    let dir = tempfile::tempdir().unwrap();
    let mut device = DeviceLibraries::open(&dir.path().join("app")).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    let file = dir.path().join("same.png");
    RgbaImage::from_pixel(4, 3, Rgba([12, 34, 56, 255]))
        .save(&file)
        .unwrap();
    let ai = import(&a, &file);
    let bi = import(&b, &file);
    tag(&a, &ai, &["blue_eyes"]);
    tag(&b, &bi, &["short_hair"]);
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    let mut workspace = Workspace::open(&dir.path().join("app")).unwrap();
    let builtin = BuiltinApproxTable::default();
    let all = WorkspaceQuery {
        scope: WorkspaceScope::All,
        conditions: Default::default(),
        cursor: None,
        limit: 1,
        thumbnail_px: 240,
    };
    let page = workspace.browse(&device, &mut catalog, &all, true).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.cards[0].sources.len(), 2);
    assert_eq!(device.current().unwrap().info().id, b.info().id);
    let search = SearchInput {
        conditions: ["blue eyes", "short hair"]
            .iter()
            .map(|text| ConditionInput {
                any: vec![TermInput::Text {
                    text: (*text).into(),
                    dismissed: vec![],
                }],
                negate: false,
            })
            .collect(),
        exact: true,
    };
    let tree = workspace
        .resolve(&device, &mut catalog, &search, "en", true, &builtin)
        .unwrap();
    assert_eq!(
        workspace
            .browse(
                &device,
                &mut catalog,
                &WorkspaceQuery {
                    conditions: tree,
                    ..all.clone()
                },
                true
            )
            .unwrap()
            .total,
        0
    );
    tag(&a, &ai, &["blue_eyes", "short_hair"]);
    let tree = workspace
        .resolve(&device, &mut catalog, &search, "en", true, &builtin)
        .unwrap();
    let page = workspace
        .browse(
            &device,
            &mut catalog,
            &WorkspaceQuery {
                conditions: tree,
                ..all
            },
            true,
        )
        .unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.cards[0].sources.len(), 2);
    assert_eq!(
        page.cards[0].sources.iter().filter(|s| s.matches).count(),
        1
    );
}
use kinshoko_core::library::{ContentRating, ImageEdit, TagEdit};
use kinshoko_core::search::Condition;
use kinshoko_core::tag_catalog::CatalogCorrection;
fn query() -> WorkspaceQuery {
    WorkspaceQuery {
        scope: WorkspaceScope::All,
        conditions: Default::default(),
        cursor: None,
        limit: 1,
        thumbnail_px: 240,
    }
}
fn files(dir: &std::path::Path, libraries: &[&Library], red: u8) -> Vec<String> {
    let path = dir.join(format!("{red}.png"));
    RgbaImage::from_pixel(4, 3, Rgba([red, 34, 56, 255]))
        .save(&path)
        .unwrap();
    libraries.iter().map(|l| import(l, &path)).collect()
}
#[test]
fn adult_in_nonmatching_out_of_scope_source_vetoes_cards_counts_and_candidates_without_changing_active_lens()
 {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    let ids = files(dir.path(), &[&a, &b], 20);
    let unknown = files(dir.path(), &[&a], 40)[0].clone();
    tag(&a, &ids[0], &["private_blue"]);
    b.set_safe_mode(false);
    b.edit(
        &[ids[1].clone()],
        &[ImageEdit::SetRating {
            rating: ContentRating::Explicit,
        }],
    )
    .unwrap();
    b.set_safe_mode(true);
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let builtin = BuiltinApproxTable::default();
    let q = WorkspaceQuery {
        scope: WorkspaceScope::Library {
            library_id: a.info().id.clone(),
            scope: Default::default(),
        },
        ..query()
    };
    let open = workspace.browse(&device, &mut catalog, &q, false).unwrap();
    assert_eq!(open.total, 2);
    assert!(b.safe_mode());
    assert!(
        b.image(&ids[1]).is_err(),
        "detached workspace reads must not release active library"
    );
    let page = workspace.browse(&device, &mut catalog, &q, true).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(
        page.cards[0].image_id, unknown,
        "unrated content remains visible"
    );
    assert!(
        workspace
            .candidates(&device, &mut catalog, "private", "en", 20, true, &builtin)
            .unwrap()
            .is_empty()
    );
    assert!(
        !workspace
            .contains(&device, &mut catalog, &a.info().id, &ids[0], true)
            .unwrap()
    );
    b.set_safe_mode(false);
    b.edit(
        &[ids[1].clone()],
        &[ImageEdit::SetRating {
            rating: ContentRating::General,
        }],
    )
    .unwrap();
    assert_eq!(
        workspace
            .browse(&device, &mut catalog, &q, true)
            .unwrap()
            .total,
        2
    );
    assert_eq!(
        workspace
            .candidates(&device, &mut catalog, "private", "en", 20, true, &builtin)
            .unwrap()[0]
            .count,
        1
    );
}
#[test]
fn unavailable_known_adult_source_keeps_veto_after_restart_until_refresh_or_explicit_unregister() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    let ids = files(dir.path(), &[&a, &b], 25);
    tag(&b, &ids[1], &["offline_secret"]);
    b.set_safe_mode(false);
    b.edit(
        &[ids[1].clone()],
        &[ImageEdit::SetRating {
            rating: ContentRating::Explicit,
        }],
    )
    .unwrap();
    let b_id = b.info().id.clone();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    assert_eq!(
        workspace
            .browse(&device, &mut catalog, &query(), true)
            .unwrap()
            .total,
        0
    );
    drop(a);
    drop(b);
    drop(device);
    drop(workspace);
    std::fs::rename(dir.path().join("b"), dir.path().join("offline-b")).unwrap();
    let mut device = DeviceLibraries::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let safe = workspace
        .browse(&device, &mut catalog, &query(), true)
        .unwrap();
    assert_eq!(safe.total, 0);
    assert_eq!(
        safe.status
            .libraries
            .iter()
            .filter(|l| l.unavailable.is_some())
            .count(),
        1
    );
    assert!(
        workspace
            .candidates(
                &device,
                &mut catalog,
                "offline",
                "en",
                20,
                false,
                &BuiltinApproxTable::default()
            )
            .unwrap()
            .is_empty(),
        "cached unavailable tags must never be search definitions"
    );
    let open = workspace
        .browse(&device, &mut catalog, &query(), false)
        .unwrap();
    assert_eq!(open.cards[0].sources.len(), 2);
    assert!(
        open.cards[0]
            .sources
            .iter()
            .any(|s| s.unavailable.is_some())
    );
    std::fs::rename(dir.path().join("offline-b"), dir.path().join("b")).unwrap();
    let b = Library::open(&dir.path().join("b")).unwrap();
    b.set_safe_mode(false);
    b.edit(
        &[ids[1].clone()],
        &[ImageEdit::SetRating {
            rating: ContentRating::General,
        }],
    )
    .unwrap();
    assert_eq!(
        workspace
            .browse(&device, &mut catalog, &query(), true)
            .unwrap()
            .total,
        1
    );
    b.edit(
        &[ids[1].clone()],
        &[ImageEdit::SetRating {
            rating: ContentRating::Explicit,
        }],
    )
    .unwrap();
    assert_eq!(
        workspace
            .browse(&device, &mut catalog, &query(), true)
            .unwrap()
            .total,
        0
    );
    drop(b);
    std::fs::rename(dir.path().join("b"), dir.path().join("offline-b")).unwrap();
    device.unregister(&b_id).unwrap();
    assert_eq!(
        workspace
            .browse(&device, &mut catalog, &query(), true)
            .unwrap()
            .total,
        1
    );
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
        &[bi.clone()],
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
#[test]
fn real_multiple_directories_reuse_visible_safety_facts_and_report_action_timings() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    let paths = (0..48u8)
        .map(|red| {
            let path = dir.path().join(format!("sample-{red}.png"));
            RgbaImage::from_pixel(4, 3, Rgba([red, 34, 56, 255]))
                .save(&path)
                .unwrap();
            path
        })
        .collect::<Vec<_>>();
    let images = [&a, &b].map(|library| {
        library
            .import(ImportSource {
                paths: paths.clone(),
            })
            .wait()
            .items
            .into_iter()
            .map(|item| item.outcome.image_id().unwrap().to_owned())
            .collect::<Vec<_>>()
    });
    let folders = (0..12)
        .map(|i| {
            let folder = a.create_folder(&format!("folder {i}"), None).unwrap();
            a.edit(
                &images[0][i * 4..i * 4 + 4],
                &[ImageEdit::AddToFolder {
                    folder_id: folder.clone(),
                }],
            )
            .unwrap();
            folder
        })
        .collect::<Vec<_>>();
    b.set_safe_mode(false);
    b.edit(
        &[images[1][0].clone()],
        &[ImageEdit::SetRating {
            rating: ContentRating::Explicit,
        }],
    )
    .unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let started = std::time::Instant::now();
    let page = workspace
        .browse(
            &device,
            &mut catalog,
            &WorkspaceQuery {
                limit: 100,
                ..query()
            },
            true,
        )
        .unwrap();
    let browse_ms = started.elapsed().as_millis();
    assert_eq!(page.total, 47);
    let started = std::time::Instant::now();
    let sidebar = workspace
        .sidebar(&device, &mut catalog, &a.info().id, true)
        .unwrap();
    let sidebar_ms = started.elapsed().as_millis();
    assert_eq!(sidebar.all, 47);
    assert_eq!(sidebar.folders.len(), 12);
    assert_eq!(
        sidebar
            .folders
            .iter()
            .find(|f| f.id == folders[0])
            .unwrap()
            .count,
        3
    );
    assert_eq!(sidebar.folders.iter().filter(|f| f.count == 4).count(), 11);
    let started = std::time::Instant::now();
    for (i, image) in images[0].iter().enumerate() {
        assert_eq!(
            workspace
                .contains(&device, &mut catalog, &a.info().id, image, true)
                .unwrap(),
            i != 0
        );
    }
    println!(
        "T07 real 2-provider/96-source/48-byte-identities/12-folder actions: browse={browse_ms}ms sidebar={sidebar_ms}ms 48 authorizations={}ms",
        started.elapsed().as_millis()
    );
}
