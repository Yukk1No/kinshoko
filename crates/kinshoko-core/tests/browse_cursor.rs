//! 浏览分页游标（#77 S4）：游标核对资料库身份、查询与浏览视角，以及会影响结果集的修订号。
//! 结果集变了以后旧游标明确失效（`Error::CursorExpired`），调用方从第一页重读；
//! 结果集不变时连续分页完整、不重复。用临时目录里的真库，经 `Library` 的对外接口。

use std::path::Path;

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::approx::BuiltinApproxTable;
use kinshoko_core::library::{
    BrowsePage, BrowseQuery, BrowseScope, ContentRating, Error, FactSource, ImageEdit,
    ImportOutcome, ImportSource, RatingFact, TagEdit, TagNamespace, TagRef,
};
use kinshoko_core::search::{ConditionInput, ConditionTree, Search, SearchInput, TermInput};

const ZH: &str = "zh-CN";

/// 按顺序导入 n 张内容不同的图，返回参考图 id（导入顺序）。
fn import(library: &Library, dir: &Path, n: u8) -> Vec<String> {
    let paths: Vec<_> = (0..n)
        .map(|i| {
            let path = dir.join(format!("in/{i}.png"));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            RgbaImage::from_fn(4, 4, |x, y| image::Rgba([i, x as u8, y as u8, 255]))
                .save(&path)
                .unwrap();
            path
        })
        .collect();
    library
        .import(ImportSource { paths })
        .wait()
        .items
        .into_iter()
        .map(|item| match item.outcome {
            ImportOutcome::Imported { image_id } => image_id,
            other => panic!("未导入：{other:?}"),
        })
        .collect()
}

fn rate(library: &Library, id: &str, rating: ContentRating) {
    library
        .replace_source_rating(
            &FactSource::model("test"),
            id,
            Some(RatingFact {
                rating,
                score: Some(0.9),
            }),
        )
        .unwrap();
}

fn tag(library: &Library, ids: &[&String], name: &str) {
    let ids: Vec<String> = ids.iter().map(|s| (*s).clone()).collect();
    library
        .edit_tags(
            &ids,
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: name.into(),
                    lang: ZH.into(),
                },
            }],
        )
        .unwrap();
}

fn query(scope: BrowseScope, conditions: ConditionTree, cursor: Option<String>) -> BrowseQuery {
    BrowseQuery {
        scope,
        conditions,
        cursor,
        limit: 1,
        thumbnail_px: 256,
    }
}

fn page(library: &Library, scope: BrowseScope, cursor: Option<String>) -> BrowsePage {
    library
        .browse(&query(scope, Default::default(), cursor))
        .unwrap()
}

fn ids(page: &BrowsePage) -> Vec<String> {
    page.cards.iter().map(|c| c.id.clone()).collect()
}

fn expired(result: Result<BrowsePage, Error>) -> bool {
    matches!(result, Err(Error::CursorExpired))
}

fn text(library: &Library, s: &str) -> ConditionTree {
    Search::new(
        &library.vocabulary().unwrap(),
        &BuiltinApproxTable::bundled(),
    )
    .resolve(
        &SearchInput {
            conditions: vec![ConditionInput {
                any: vec![TermInput::Text {
                    text: s.into(),
                    dismissed: Vec::new(),
                }],
                negate: false,
            }],
            exact: false,
        },
        ZH,
    )
}

/// 审查反例：安全模式下最新的图由露骨改为全年龄，旧游标若仍有效，这张新可见的图整次分页都看不到。
#[test]
fn browse_cursor_expires_when_visibility_revision_advances() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    library.set_safe_mode(false);
    let [one, two, three] = <[String; 3]>::try_from(import(&library, dir.path(), 3)).unwrap();
    rate(&library, &three, ContentRating::Explicit);
    library.set_safe_mode(true);

    let first = page(&library, BrowseScope::All, None);
    assert_eq!(ids(&first), std::slice::from_ref(&two));
    assert_eq!(first.total, 2);
    let cursor = first.next_cursor.clone().expect("还有下一页");
    let before = library.vocabulary_revision().unwrap();

    rate(&library, &three, ContentRating::General);
    assert!(library.vocabulary_revision().unwrap() > before);

    let stale = library.browse(&query(BrowseScope::All, Default::default(), Some(cursor)));
    assert!(expired(stale), "旧游标应失效");

    // 调用方从第一页重读，新可见的图在内。
    let mut seen = Vec::new();
    let mut cursor = None;
    loop {
        let p = page(&library, BrowseScope::All, cursor);
        assert_eq!(p.total, 3);
        seen.extend(ids(&p));
        cursor = p.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(seen, [three, two, one]);
}

#[test]
fn stable_result_set_pages_through_completely_without_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    library.set_safe_mode(false);
    let all = import(&library, dir.path(), 5);
    // 不改变结果集的写入（备注、无关打标、未跨过成人线的分级）不打断分页。
    let mut seen = Vec::new();
    let mut cursor = None;
    loop {
        let p = page(&library, BrowseScope::All, cursor);
        assert_eq!(p.total, 5);
        seen.extend(ids(&p));
        cursor = p.next_cursor;
        match seen.len() {
            1 => tag(&library, &[&all[0]], "无关"),
            2 => rate(&library, &all[1], ContentRating::Sensitive),
            _ => {}
        }
        if cursor.is_none() {
            break;
        }
    }
    let mut expected = all.clone();
    expected.reverse();
    assert_eq!(seen, expected);
}

#[test]
fn cursor_expires_when_safe_mode_switches() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    library.set_safe_mode(false);
    let all = import(&library, dir.path(), 3);
    rate(&library, &all[0], ContentRating::Explicit);

    let cursor = page(&library, BrowseScope::All, None).next_cursor.unwrap();
    library.set_safe_mode(true);
    let stale = library.browse(&query(BrowseScope::All, Default::default(), Some(cursor)));
    assert!(expired(stale), "安全模式切换后旧视角的游标应失效");
}

#[test]
fn cursor_only_continues_the_same_query_in_the_same_library() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let other = Library::create(&dir.path().join("other"), "另一个库").unwrap();
    let all = import(&library, dir.path(), 3);
    import(&other, &dir.path().join("o"), 3);
    let folder = library.create_folder("参考", None).unwrap();
    library
        .edit(
            &all,
            &[ImageEdit::AddToFolder {
                folder_id: folder.clone(),
            }],
        )
        .unwrap();

    let cursor = page(&library, BrowseScope::All, None).next_cursor.unwrap();
    let elsewhere = other.browse(&query(
        BrowseScope::All,
        Default::default(),
        Some(cursor.clone()),
    ));
    assert!(expired(elsewhere), "另一个资料库不接受这个游标");
    let other_scope = library.browse(&query(
        BrowseScope::Folder { id: folder },
        Default::default(),
        Some(cursor.clone()),
    ));
    assert!(expired(other_scope), "另一个范围不接受这个游标");
    let other_conditions = library.browse(&query(
        BrowseScope::All,
        text(&library, "某某"),
        Some(cursor.clone()),
    ));
    assert!(expired(other_conditions), "另一组条件不接受这个游标");
    assert!(matches!(
        library.browse(&query(
            BrowseScope::All,
            Default::default(),
            Some("2".into())
        )),
        Err(Error::InvalidCursor)
    ));
    // 原查询仍能接着翻。
    assert_eq!(
        page(&library, BrowseScope::All, Some(cursor)).cards.len(),
        1
    );
}

/// 较新的图放进正在浏览的文件夹：它排在游标之前，旧游标接着翻会漏掉它。
#[test]
fn cursor_expires_when_an_image_joins_the_browsed_folder() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let [one, two, three] = <[String; 3]>::try_from(import(&library, dir.path(), 3)).unwrap();
    let folder = library.create_folder("参考", None).unwrap();
    library
        .edit(
            &[one.clone(), two.clone()],
            &[ImageEdit::AddToFolder {
                folder_id: folder.clone(),
            }],
        )
        .unwrap();
    let scope = BrowseScope::Folder { id: folder.clone() };
    let first = page(&library, scope.clone(), None);
    assert_eq!(ids(&first), [two]);

    library
        .edit(&[three], &[ImageEdit::AddToFolder { folder_id: folder }])
        .unwrap();
    let stale = library.browse(&query(scope, Default::default(), first.next_cursor));
    assert!(expired(stale), "文件夹成员变化后旧游标应失效");
}

/// 查找条件下，备注变化让较新的图开始满足条件：旧游标失效。
#[test]
fn cursor_expires_when_a_note_change_alters_the_search_result() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let [one, two, three] = <[String; 3]>::try_from(import(&library, dir.path(), 3)).unwrap();
    library
        .edit(
            &[one, two.clone()],
            &[ImageEdit::SetNote {
                text: "某某参考".into(),
            }],
        )
        .unwrap();
    let tree = text(&library, "某某");
    let first = library
        .browse(&query(BrowseScope::All, tree.clone(), None))
        .unwrap();
    assert_eq!(ids(&first), [two]);

    library
        .edit(
            &[three],
            &[ImageEdit::SetNote {
                text: "某某".into(),
            }],
        )
        .unwrap();
    let stale = library.browse(&query(BrowseScope::All, tree, first.next_cursor));
    assert!(expired(stale), "查找结果变化后旧游标应失效");
}
