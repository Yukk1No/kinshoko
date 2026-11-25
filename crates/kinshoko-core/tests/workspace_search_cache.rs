//! 工作区 Search 缓存：resolve 与 candidates 的槽位、内置近似表与词表修订号边界。
use super::*;

fn catalog_tag_id(catalog: &TagCatalog, external: &str) -> String {
    catalog
        .inspect()
        .unwrap()
        .tags
        .iter()
        .find(|tag| {
            tag.external
                .iter()
                .any(|entry| entry.vocabulary == "danbooru" && entry.name == external)
        })
        .unwrap_or_else(|| panic!("missing catalog tag {external}"))
        .id
        .clone()
}

fn text_similar_ids(tree: &kinshoko_core::search::ConditionTree) -> Vec<String> {
    use kinshoko_core::search::Term;

    match &tree.conditions[0].any[0] {
        Term::Text { similar, .. } => similar.iter().map(|s| s.tag.id.clone()).collect(),
        other => panic!("expected text term: {other:?}"),
    }
}

#[test]
fn workspace_resolve_without_unattached_presets_reuses_search_when_builtin_returns() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let library = device.create(&dir.path().join("a"), "A").unwrap();
    let image = files(dir.path(), &[&library], 18);
    tag(&library, &image[0], &["alpha_eyes"]);
    let mut catalog = TagCatalog::open(&app).unwrap();
    catalog.create_group("我的", None).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let input = SearchInput {
        conditions: vec![ConditionInput {
            any: vec![TermInput::Text {
                text: "alpha eyes".into(),
                dismissed: vec![],
            }],
            negate: false,
        }],
        exact: true,
    };
    let first = BuiltinApproxTable::default();
    let second = BuiltinApproxTable::from_pairs(1, [("unused_a", "unused_b")]);

    workspace
        .resolve(&device, &mut catalog, &input, "en", true, &first)
        .unwrap();
    assert_eq!(workspace.search_builds(), 1);
    workspace
        .candidates(&device, &mut catalog, "alpha", "en", 10, true, &second)
        .unwrap();
    assert_eq!(workspace.search_builds(), 2);
    workspace
        .resolve(&device, &mut catalog, &input, "en", true, &first)
        .unwrap();
    assert_eq!(workspace.search_builds(), 2);
}

#[test]
fn workspace_resolve_and_candidates_cache_separately_when_preset_tags_are_unattached() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let device = DeviceLibraries::open(&app).unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    workspace
        .tag_groups(&device, &mut catalog, "", "zh-CN", true)
        .unwrap();
    let blue = catalog_tag_id(&catalog, "blue_hair");
    let input = SearchInput {
        conditions: vec![ConditionInput {
            any: vec![TermInput::Tag {
                id: blue,
                dismissed: vec![],
            }],
            negate: false,
        }],
        exact: false,
    };
    let builtin = BuiltinApproxTable::default();

    workspace
        .resolve(&device, &mut catalog, &input, "en", true, &builtin)
        .unwrap();
    assert_eq!(workspace.search_builds(), 1);
    workspace
        .resolve(&device, &mut catalog, &input, "en", true, &builtin)
        .unwrap();
    assert_eq!(workspace.search_builds(), 1);
    assert!(
        workspace
            .candidates(&device, &mut catalog, "blue", "en", 10, true, &builtin)
            .unwrap()
            .is_empty()
    );
    assert_eq!(workspace.search_builds(), 2);
    workspace
        .candidates(&device, &mut catalog, "blue", "en", 10, true, &builtin)
        .unwrap();
    assert_eq!(workspace.search_builds(), 2);
}

#[test]
fn workspace_search_rebuilds_when_builtin_approx_table_changes() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let library = device.create(&dir.path().join("a"), "A").unwrap();
    let alpha_image = files(dir.path(), &[&library], 18);
    let beta_image = files(dir.path(), &[&library], 19);
    tag(&library, &alpha_image[0], &["alpha_eyes"]);
    tag(&library, &beta_image[0], &["beta_eyes"]);
    let mut catalog = TagCatalog::open(&app).unwrap();
    catalog.create_group("我的", None).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let input = SearchInput {
        conditions: vec![ConditionInput {
            any: vec![TermInput::Text {
                text: "alpha eyes".into(),
                dismissed: vec![],
            }],
            negate: false,
        }],
        exact: false,
    };
    let empty = BuiltinApproxTable::default();
    let paired = BuiltinApproxTable::from_pairs(1, [("alpha_eyes", "beta_eyes")]);

    let plain = workspace
        .resolve(&device, &mut catalog, &input, "en", true, &empty)
        .unwrap();
    assert!(text_similar_ids(&plain).is_empty());
    let builds = workspace.search_builds();
    let expanded = workspace
        .resolve(&device, &mut catalog, &input, "en", true, &paired)
        .unwrap();
    assert_eq!(
        text_similar_ids(&expanded),
        [catalog_tag_id(&catalog, "beta_eyes")]
    );
    assert_eq!(workspace.search_builds(), builds + 1);
    workspace
        .resolve(&device, &mut catalog, &input, "en", true, &paired)
        .unwrap();
    assert_eq!(workspace.search_builds(), builds + 1);
}

#[test]
fn workspace_search_rebuilds_after_personal_approx_changes_catalog_revision() {
    use kinshoko_core::approx::{ApproxRelation, PersonalApprox};
    use kinshoko_core::tag_catalog::CatalogApproxEdit;

    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let library = device.create(&dir.path().join("a"), "A").unwrap();
    let alpha_image = files(dir.path(), &[&library], 18);
    let beta_image = files(dir.path(), &[&library], 19);
    tag(&library, &alpha_image[0], &["alpha_eyes"]);
    tag(&library, &beta_image[0], &["beta_eyes"]);
    let mut catalog = TagCatalog::open(&app).unwrap();
    catalog.create_group("我的", None).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let input = SearchInput {
        conditions: vec![ConditionInput {
            any: vec![TermInput::Text {
                text: "alpha eyes".into(),
                dismissed: vec![],
            }],
            negate: false,
        }],
        exact: false,
    };
    let builtin = BuiltinApproxTable::default();

    let plain = workspace
        .resolve(&device, &mut catalog, &input, "en", true, &builtin)
        .unwrap();
    assert!(text_similar_ids(&plain).is_empty());
    let builds = workspace.search_builds();
    let alpha = catalog_tag_id(&catalog, "alpha_eyes");
    let beta = catalog_tag_id(&catalog, "beta_eyes");
    workspace
        .edit_approx(
            &device,
            &mut catalog,
            &CatalogApproxEdit::Set {
                rules: vec![PersonalApprox {
                    a: alpha,
                    b: beta.clone(),
                    relation: ApproxRelation::Similar,
                }],
            },
            true,
        )
        .unwrap();
    let expanded = workspace
        .resolve(&device, &mut catalog, &input, "en", true, &builtin)
        .unwrap();
    assert_eq!(text_similar_ids(&expanded), [beta]);
    assert_eq!(workspace.search_builds(), builds + 1);
    workspace
        .resolve(&device, &mut catalog, &input, "en", true, &builtin)
        .unwrap();
    assert_eq!(workspace.search_builds(), builds + 1);
}
