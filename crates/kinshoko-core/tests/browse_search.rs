//! 基础检索（#54）：Library 按 Search 给出的条件树分页返回整图候选，结果与计数一致。
//! 用临时目录里的真库，经 `Library` 与 `Search` 的对外接口。

use std::collections::BTreeSet;
use std::path::Path;

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::library::{
    BrowseQuery, ImportOutcome, ImportSource, TagEdit, TagNamespace, TagRef,
};
use kinshoko_core::search::{
    Condition, ConditionInput, ConditionTree, Search, SearchInput, TermInput,
};

const ZH: &str = "zh-CN";

/// 建库并按给出的文件名各导入一张内容不同的图，返回资料库与参考图 id（顺序同 `names`）。
fn library_with(dir: &Path, names: &[&str]) -> (Library, Vec<String>) {
    let library = Library::create(&dir.join("lib"), "库").unwrap();
    let paths: Vec<_> = names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let path = dir.join(format!("in/{i}/{name}"));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            RgbaImage::from_fn(4, 4, |x, y| image::Rgba([i as u8, x as u8, y as u8, 255]))
                .save(&path)
                .unwrap();
            path
        })
        .collect();
    let report = library.import(ImportSource { paths }).wait();
    let ids = report
        .items
        .into_iter()
        .map(|item| match item.outcome {
            ImportOutcome::Imported { image_id } => image_id,
            other => panic!("未导入：{other:?}"),
        })
        .collect();
    (library, ids)
}

fn tag(library: &Library, ids: &[&String], namespace: TagNamespace, name: &str) {
    let ids: Vec<String> = ids.iter().map(|s| (*s).clone()).collect();
    library
        .edit_tags(
            &ids,
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace,
                    name: name.into(),
                    lang: ZH.into(),
                },
            }],
        )
        .unwrap();
}

fn tag_id(library: &Library, namespace: TagNamespace, name: &str) -> String {
    library
        .vocabulary()
        .unwrap()
        .tags
        .into_iter()
        .find(|t| t.namespace == namespace && t.names.iter().any(|n| n.name == name))
        .unwrap()
        .id
}

fn any(terms: Vec<TermInput>, negate: bool) -> ConditionInput {
    ConditionInput { any: terms, negate }
}

fn resolve(library: &Library, conditions: Vec<ConditionInput>) -> ConditionTree {
    Search::new(&library.vocabulary().unwrap()).resolve(&SearchInput { conditions }, ZH)
}

/// 按条件树逐页取完，返回取到的 id 与每页报告的计数。
fn found(library: &Library, tree: &ConditionTree, page: u32) -> (Vec<String>, BTreeSet<u32>) {
    let mut ids = Vec::new();
    let mut totals = BTreeSet::new();
    let mut cursor = None;
    loop {
        let result = library
            .browse(&BrowseQuery {
                scope: Default::default(),
                conditions: tree.clone(),
                cursor,
                limit: page,
                thumbnail_px: 256,
            })
            .unwrap();
        ids.extend(result.cards.into_iter().map(|c| c.id));
        totals.insert(result.total);
        cursor = result.next_cursor;
        if cursor.is_none() {
            return (ids, totals);
        }
    }
}

fn set(ids: &[String]) -> BTreeSet<String> {
    ids.iter().cloned().collect()
}

#[test]
fn conditions_all_hold_alternatives_widen_and_exclusions_remove_page_by_page() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with(dir.path(), &["0.png", "1.png", "2.png", "3.png", "4.png"]);
    tag(&library, &[&ids[0], &ids[2]], TagNamespace::General, "蓝发");
    tag(&library, &[&ids[1], &ids[4]], TagNamespace::General, "紫发");
    tag(&library, &[&ids[2]], TagNamespace::General, "多人");
    tag(&library, &[&ids[0], &ids[4]], TagNamespace::General, "短发");
    let blue = tag_id(&library, TagNamespace::General, "蓝发");
    let purple = tag_id(&library, TagNamespace::General, "紫发");
    let multi = tag_id(&library, TagNamespace::General, "多人");
    let short = tag_id(&library, TagNamespace::General, "短发");
    let t = |id: &String| TermInput::Tag { id: id.clone() };

    // 蓝发或紫发、不要多人。
    let tree = resolve(
        &library,
        vec![
            any(vec![t(&blue), t(&purple)], false),
            any(vec![t(&multi)], true),
        ],
    );
    let (got, totals) = found(&library, &tree, 1);
    assert_eq!(got.len(), 3, "每张图只出现一次");
    assert_eq!(
        set(&got),
        set(&[ids[0].clone(), ids[1].clone(), ids[4].clone()])
    );
    assert_eq!(totals, BTreeSet::from([3]), "每页的计数都与结果一致");

    // 再加“短发”：默认同时满足。
    let tree = resolve(
        &library,
        vec![
            any(vec![t(&blue), t(&purple)], false),
            any(vec![t(&multi)], true),
            any(vec![t(&short)], false),
        ],
    );
    let (got, totals) = found(&library, &tree, 2);
    assert_eq!(set(&got), set(&[ids[0].clone(), ids[4].clone()]));
    assert_eq!(totals, BTreeSet::from([2]));

    // 没有条件时是全部，顺序与普通浏览相同。
    let (everything, totals) = found(&library, &ConditionTree::default(), 2);
    assert_eq!(set(&everything), set(&ids));
    assert_eq!(totals, BTreeSet::from([5]));
}

#[test]
fn typed_words_find_every_namespace_alias_and_the_images_own_file_name() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with(
        dir.path(),
        &["a.png", "b.png", "c.png", "pixiv_某某_123.png", "e.png"],
    );
    tag(&library, &[&ids[0]], TagNamespace::Artist, "某某");
    tag(&library, &[&ids[1]], TagNamespace::Character, "某某");
    tag(&library, &[&ids[2]], TagNamespace::General, "蓝发");
    let blue = tag_id(&library, TagNamespace::General, "蓝发");
    library
        .add_tag_alias(
            &blue,
            &kinshoko_core::library::TagAlias {
                name: "蓝头发".into(),
                lang: Some(ZH.into()),
            },
        )
        .unwrap();
    let text = |s: &str| TermInput::Text { text: s.into() };

    let tree = resolve(&library, vec![any(vec![text("某某")], false)]);
    let (got, totals) = found(&library, &tree, 10);
    assert_eq!(
        set(&got),
        set(&[ids[0].clone(), ids[1].clone(), ids[3].clone()]),
        "作者与角色都匹配，文件名含这个词的也匹配"
    );
    assert_eq!(totals, BTreeSet::from([3]));

    let tree = resolve(&library, vec![any(vec![text("蓝头发")], false)]);
    assert_eq!(found(&library, &tree, 10).0, [ids[2].clone()]);

    // 文件名比较时不分大小写与全角半角。
    let tree = resolve(&library, vec![any(vec![text("ＰＩＸＩＶ")], false)]);
    assert_eq!(found(&library, &tree, 10).0, [ids[3].clone()]);

    // 排除文字：没有任何“某某”的图。
    let tree = resolve(&library, vec![any(vec![text("某某")], true)]);
    assert_eq!(
        set(&found(&library, &tree, 10).0),
        set(&[ids[2].clone(), ids[4].clone()])
    );
}

#[test]
fn a_condition_with_no_alternatives_matches_nothing_and_its_exclusion_everything() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with(dir.path(), &["a.png", "b.png"]);
    let nothing = ConditionTree {
        conditions: vec![Condition {
            any: vec![],
            negate: false,
        }],
    };
    let (got, totals) = found(&library, &nothing, 10);
    assert!(got.is_empty());
    assert_eq!(totals, BTreeSet::from([0]));

    let everything = ConditionTree {
        conditions: vec![Condition {
            any: vec![],
            negate: true,
        }],
    };
    assert_eq!(set(&found(&library, &everything, 10).0), set(&ids));
}

/// 反馈约 100 ms 内出现（验收）：大库上解析条件并取第一页。耗时，手动以 release 运行：
/// `cargo test --release --test browse_search -- --ignored`。
#[test]
#[ignore]
fn the_first_page_of_a_search_arrives_within_100_ms_on_a_large_library() {
    const N: usize = 10_000;
    let dir = tempfile::tempdir().unwrap();
    let names: Vec<String> = (0..N).map(|i| format!("ref_{i}.png")).collect();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let paths: Vec<_> = names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let path = dir.path().join("in").join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            RgbaImage::from_fn(2, 2, |x, y| {
                image::Rgba([(i % 256) as u8, (i / 256) as u8, x as u8, y as u8])
            })
            .save(&path)
            .unwrap();
            path
        })
        .collect();
    let ids: Vec<String> = library
        .import(ImportSource { paths })
        .wait()
        .items
        .into_iter()
        .filter_map(|item| match item.outcome {
            ImportOutcome::Imported { image_id } => Some(image_id),
            _ => None,
        })
        .collect();
    for (k, name) in ["蓝发", "紫发", "短发", "多人", "逆光"].iter().enumerate() {
        let chosen: Vec<&String> = ids.iter().skip(k).step_by(k + 2).collect();
        tag(&library, &chosen, TagNamespace::General, name);
    }
    let blue = tag_id(&library, TagNamespace::General, "蓝发");
    let purple = tag_id(&library, TagNamespace::General, "紫发");
    let multi = tag_id(&library, TagNamespace::General, "多人");
    let vocabulary = library.vocabulary().unwrap();

    let started = std::time::Instant::now();
    let search = Search::new(&vocabulary);
    let tree = search.resolve(
        &SearchInput {
            conditions: vec![
                any(
                    vec![TermInput::Tag { id: blue }, TermInput::Tag { id: purple }],
                    false,
                ),
                any(vec![TermInput::Tag { id: multi }], true),
                any(vec![TermInput::Text { text: "发".into() }], false),
            ],
        },
        ZH,
    );
    let page = library
        .browse(&BrowseQuery {
            scope: Default::default(),
            conditions: tree,
            cursor: None,
            limit: 500,
            thumbnail_px: 256,
        })
        .unwrap();
    let elapsed = started.elapsed();
    assert!(page.total > 0);
    assert!(
        elapsed < std::time::Duration::from_millis(100),
        "{N} 张图上第一页用了 {elapsed:?}"
    );
}

#[test]
fn searching_finds_notes_stays_inside_the_scope_and_leaves_the_trash_out() {
    use kinshoko_core::library::{BrowseScope, ImageEdit};

    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with(dir.path(), &["a.png", "b.png", "c.png", "d.png"]);
    library
        .edit(
            &ids[..3],
            &[ImageEdit::SetNote {
                text: "逆光的头发".into(),
            }],
        )
        .unwrap();
    library.edit(&ids[2..3], &[ImageEdit::Delete]).unwrap();
    let folder = library.create_folder("光影", None).unwrap();
    library
        .edit(
            &[ids[1].clone(), ids[3].clone()],
            &[ImageEdit::AddToFolder {
                folder_id: folder.clone(),
            }],
        )
        .unwrap();
    let tree = resolve(
        &library,
        vec![any(
            vec![TermInput::Text {
                text: "逆光".into(),
            }],
            false,
        )],
    );

    let (got, totals) = found(&library, &tree, 10);
    assert_eq!(
        set(&got),
        set(&[ids[0].clone(), ids[1].clone()]),
        "回收站里的图不出现"
    );
    assert_eq!(totals, BTreeSet::from([2]));

    let in_folder = library
        .browse(&BrowseQuery {
            scope: BrowseScope::Folder { id: folder },
            conditions: tree.clone(),
            cursor: None,
            limit: 10,
            thumbnail_px: 256,
        })
        .unwrap();
    assert_eq!(in_folder.total, 1);
    assert_eq!(in_folder.cards[0].id, ids[1]);

    let in_trash = library
        .browse(&BrowseQuery {
            scope: BrowseScope::Trash,
            conditions: tree,
            cursor: None,
            limit: 10,
            thumbnail_px: 256,
        })
        .unwrap();
    assert_eq!(in_trash.total, 1);
    assert_eq!(in_trash.cards[0].id, ids[2]);
}
