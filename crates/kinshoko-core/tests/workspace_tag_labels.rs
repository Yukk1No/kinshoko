//! 工作区候选标签在原图删除或失去可用来源后的名称保留。
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
