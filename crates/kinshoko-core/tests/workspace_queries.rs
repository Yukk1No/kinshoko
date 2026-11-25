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

#[test]
fn narrow_browse_and_single_card_keep_offline_adult_veto_and_all_sources_via_sha256_index() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let a_dir = dir.path().join("a");
    let b_dir = dir.path().join("b");
    let b_moved = dir.path().join("b-offline");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&a_dir, "A").unwrap();
    let b = device.create(&b_dir, "B").unwrap();

    // 导入多张无关参考图，确保窄查询不会退化或漏算。
    for seed in 0..20u8 {
        let p = dir.path().join(format!("noise-{seed}.png"));
        RgbaImage::from_pixel(2, 2, Rgba([seed, 10, 20, 255]))
            .save(&p)
            .unwrap();
        let target = if seed % 2 == 0 { &a } else { &b };
        target.import(ImportSource { paths: vec![p] }).wait();
    }

    let shared_file = dir.path().join("shared.png");
    RgbaImage::from_pixel(3, 3, Rgba([200, 100, 50, 255]))
        .save(&shared_file)
        .unwrap();
    let a_shared = a
        .import(ImportSource {
            paths: vec![shared_file.clone()],
        })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();
    let b_shared = b
        .import(ImportSource {
            paths: vec![shared_file],
        })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();

    let focus = a.create_folder("focus", None).unwrap();
    a.edit(
        std::slice::from_ref(&a_shared),
        &[ImageEdit::AddToFolder {
            folder_id: focus.clone(),
        }],
    )
    .unwrap();
    b.set_safe_mode(false);
    b.edit(
        &[b_shared],
        &[ImageEdit::SetRating {
            rating: ContentRating::Explicit,
        }],
    )
    .unwrap();

    let a_id = a.info().id.clone();
    let b_id = b.info().id.clone();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();

    // 先刷新一次记录跨库事实，再释放所有只读/可写句柄并使 B 下线。
    let initial = workspace
        .browse(&device, &mut catalog, &query(), false)
        .unwrap();
    assert_eq!(initial.total, 21);

    drop(a);
    drop(b);
    drop(device);
    workspace.release_readers();
    std::fs::rename(&b_dir, &b_moved).unwrap();

    let device = DeviceLibraries::open(&app).unwrap();
    let folder_query = WorkspaceQuery {
        scope: WorkspaceScope::Library {
            library_id: a_id.clone(),
            scope: kinshoko_core::library::BrowseScope::Folder { id: focus },
        },
        ..query()
    };

    // 安全模式开启：即使只查 A 的单文件夹或单卡，仍因离线库 B 的成人标记被否决隐藏。
    let safe_page = workspace
        .browse(&device, &mut catalog, &folder_query, true)
        .unwrap();
    assert_eq!(safe_page.total, 0);
    assert!(matches!(
        workspace.card(&device, &mut catalog, &a_id, &a_shared, true),
        Err(kinshoko_core::tag_catalog::CatalogError::Library(
            kinshoko_core::library::Error::UnknownImage
        ))
    ));

    // 安全模式关闭：窄查询与单卡均返回 A 与离线库 B 的完整来源列表。
    let unsafe_page = workspace
        .browse(&device, &mut catalog, &folder_query, false)
        .unwrap();
    assert_eq!(unsafe_page.total, 1);
    let page_card = &unsafe_page.cards[0];
    assert_eq!(page_card.sources.len(), 2);
    assert!(
        page_card
            .sources
            .iter()
            .any(|s| s.library_id == a_id && s.matches && s.unavailable.is_none())
    );
    assert!(
        page_card
            .sources
            .iter()
            .any(|s| s.library_id == b_id && !s.matches && s.unavailable.is_some())
    );

    let single = workspace
        .card(&device, &mut catalog, &a_id, &a_shared, false)
        .unwrap();
    assert_eq!(single.sources.len(), 2);
    assert!(
        single
            .sources
            .iter()
            .any(|s| s.library_id == a_id && s.matches && s.unavailable.is_none())
    );
    assert!(
        single
            .sources
            .iter()
            .any(|s| s.library_id == b_id && !s.matches && s.unavailable.is_some())
    );
}
