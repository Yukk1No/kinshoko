//! 个人近似对应表（#56）：随资料库保存，按标签身份记录“相近”或“不相近”，经词表快照交给
//! Search，再由 `browse` 执行。全部通过 `Library` 的对外接口，用临时目录里的真库。

use std::collections::BTreeSet;
use std::path::Path;

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::approx::{ApproxRelation, BuiltinApproxTable};
use kinshoko_core::library::{
    BrowseQuery, Error, ImportOutcome, ImportSource, LibraryEvent, TagEdit, TagNamespace, TagRef,
};
use kinshoko_core::search::{ConditionInput, Search, SearchInput, TermInput};

const ZH: &str = "zh-CN";

/// 四张图：蓝瞳、水色瞳、自造的“天空色”、红瞳。前两个和红瞳有外部对应。
struct Fixture {
    library: Library,
    images: Vec<String>,
    blue: String,
    aqua: String,
    sky: String,
    red: String,
}

fn fixture(dir: &Path) -> Fixture {
    let library = Library::create(&dir.join("lib"), "库").unwrap();
    let paths: Vec<_> = (0..4u8)
        .map(|i| {
            let path = dir.join(format!("in/{i}.png"));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            RgbaImage::from_fn(4, 4, |x, y| image::Rgba([i, x as u8, y as u8, 255]))
                .save(&path)
                .unwrap();
            path
        })
        .collect();
    let images: Vec<String> = library
        .import(ImportSource { paths })
        .wait()
        .items
        .into_iter()
        .map(|item| match item.outcome {
            ImportOutcome::Imported { image_id } => image_id,
            other => panic!("未导入：{other:?}"),
        })
        .collect();
    let external = |name: &str| TagRef::External {
        namespace: TagNamespace::General,
        name: name.into(),
    };
    let tags = [
        external("blue_eyes"),
        external("aqua_eyes"),
        TagRef::Named {
            namespace: TagNamespace::General,
            name: "天空色".into(),
            lang: ZH.into(),
        },
        external("red_eyes"),
    ];
    for (image, tag) in images.iter().zip(tags) {
        library
            .edit_tags(std::slice::from_ref(image), &[TagEdit::Add { tag }])
            .unwrap();
    }
    let vocabulary = library.vocabulary().unwrap();
    let id = |pred: &dyn Fn(&kinshoko_core::library::VocabularyTag) -> bool| {
        vocabulary.tags.iter().find(|t| pred(t)).unwrap().id.clone()
    };
    Fixture {
        blue: id(&|t| t.external == ["blue_eyes"]),
        aqua: id(&|t| t.external == ["aqua_eyes"]),
        red: id(&|t| t.external == ["red_eyes"]),
        sky: id(&|t| t.names.iter().any(|n| n.name == "天空色")),
        library,
        images,
    }
}

/// 只点选 `tag` 一个条件时找到的图。
fn found(library: &Library, tag: &str, exact: bool) -> BTreeSet<String> {
    let search = Search::new(
        &library.vocabulary().unwrap(),
        &BuiltinApproxTable::bundled(),
    );
    let tree = search.resolve(
        &SearchInput {
            conditions: vec![ConditionInput {
                any: vec![TermInput::Tag {
                    id: tag.into(),
                    dismissed: Vec::new(),
                }],
                negate: false,
            }],
            exact,
        },
        ZH,
    );
    library
        .browse(&BrowseQuery {
            scope: Default::default(),
            conditions: tree,
            cursor: None,
            limit: 100,
            thumbnail_px: 256,
        })
        .unwrap()
        .cards
        .into_iter()
        .map(|c| c.id)
        .collect()
}

fn set(ids: &[&String]) -> BTreeSet<String> {
    ids.iter().map(|s| (*s).clone()).collect()
}

#[test]
fn the_built_in_pair_expands_by_default_and_exact_matches_only_the_tag() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path());
    let [blue_img, aqua_img, ..] = &f.images[..] else {
        unreachable!()
    };

    assert_eq!(
        found(&f.library, &f.blue, false),
        set(&[blue_img, aqua_img])
    );
    assert_eq!(found(&f.library, &f.blue, true), set(&[blue_img]));
}

#[test]
fn never_expand_again_records_not_similar_which_beats_the_built_in_pair_and_survives_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path());
    let events = f.library.events();

    f.library
        .set_tag_approx(&f.aqua, &f.blue, ApproxRelation::NotSimilar)
        .unwrap();
    assert_eq!(found(&f.library, &f.blue, false), set(&[&f.images[0]]));
    assert!(
        events
            .try_iter()
            .any(|e| matches!(e, LibraryEvent::VocabularyChanged { .. })),
        "Search 的词表快照要随之重建"
    );

    let root = f.library.info().root.clone();
    drop(f.library);
    let reopened = Library::open(&root).unwrap();
    assert_eq!(found(&reopened, &f.blue, false), set(&[&f.images[0]]));
    let entries = reopened.personal_approx(ZH).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].relation, ApproxRelation::NotSimilar);
}

#[test]
fn plus_makes_any_library_tag_similar_and_deleting_the_entry_takes_it_back() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path());
    let [blue_img, aqua_img, sky_img, _] = &f.images[..] else {
        unreachable!()
    };

    f.library
        .set_tag_approx(&f.blue, &f.sky, ApproxRelation::Similar)
        .unwrap();
    assert_eq!(
        found(&f.library, &f.blue, false),
        set(&[blue_img, aqua_img, sky_img])
    );
    assert_eq!(found(&f.library, &f.sky, false), set(&[sky_img, blue_img]));

    // 同一对再记一次（顺序相反）是改判断，不是多一条。
    f.library
        .set_tag_approx(&f.sky, &f.blue, ApproxRelation::NotSimilar)
        .unwrap();
    f.library
        .set_tag_approx(&f.red, &f.blue, ApproxRelation::Similar)
        .unwrap();
    let entries = f.library.personal_approx(ZH).unwrap();
    let listed: Vec<(String, String, ApproxRelation)> = entries
        .iter()
        .map(|e| (e.a.name.clone(), e.b.name.clone(), e.relation))
        .collect();
    assert_eq!(
        listed,
        [
            (
                "red eyes".into(),
                "blue eyes".into(),
                ApproxRelation::Similar
            ),
            (
                "天空色".into(),
                "blue eyes".into(),
                ApproxRelation::NotSimilar
            ),
        ],
        "最近记下的在前，两端按记下时的顺序，名称按界面语言"
    );
    assert!(!entries[1].a.has_external, "设置里能看出哪端没有外部对应");

    f.library.remove_tag_approx(&f.blue, &f.sky).unwrap();
    f.library.remove_tag_approx(&f.blue, &f.red).unwrap();
    assert!(f.library.personal_approx(ZH).unwrap().is_empty());
    assert_eq!(
        found(&f.library, &f.blue, false),
        set(&[blue_img, aqua_img])
    );
}

#[test]
fn entries_need_two_different_existing_tags() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path());

    assert!(matches!(
        f.library
            .set_tag_approx(&f.blue, "no-such-tag", ApproxRelation::Similar),
        Err(Error::UnknownTag)
    ));
    assert!(matches!(
        f.library
            .set_tag_approx(&f.blue, &f.blue, ApproxRelation::Similar),
        Err(Error::SameTag)
    ));
    assert!(f.library.personal_approx(ZH).unwrap().is_empty());
}
