//! 按内容分级查找（#161）：分级在搜索框里像标签一样用，按有效分级匹配，安全模式优先。
//! 用临时目录里的真库，经 `Library` 与 `Search` 的对外接口；分级按模型来源写入。

use std::collections::BTreeSet;

use kinshoko_core::Library;
use kinshoko_core::approx::BuiltinApproxTable;
use kinshoko_core::library::{
    BrowseQuery, ContentRating, FactSource, ImageEdit, RatingFact, TagEdit, TagNamespace, TagRef,
};
use kinshoko_core::search::{ConditionInput, Search, SearchInput, TermInput, rating_candidates};

#[path = "support/library.rs"]
mod support_library;
use support_library::import_seeded;

const ZH: &str = "zh-CN";

/// 分级在中文界面里的显示名（界面按 `common:rating` 写出）。
fn shown_name(label: &kinshoko_core::search::RatingLabel) -> String {
    if label.r18 {
        return "R18".into();
    }
    label
        .ratings
        .iter()
        .map(|r| match r {
            ContentRating::General => "全年龄",
            ContentRating::Sensitive => "轻度",
            ContentRating::Questionable => "敏感",
            ContentRating::Explicit => "成人",
        })
        .collect::<Vec<_>>()
        .join("、")
}

/// 测试库里的图，按内容分级区分；安全模式关着。
struct Fixture {
    _dir: tempfile::TempDir,
    library: Library,
    general: String,
    sensitive: String,
    questionable: String,
    explicit: String,
    unrated: String,
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

impl Fixture {
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::create(&dir.path().join("lib"), "库").unwrap();
        library.set_safe_mode(false);
        let [general, sensitive, questionable, explicit, unrated] =
            <[String; 5]>::try_from(import_seeded(&library, dir.path(), 0..5)).unwrap();
        rate(&library, &general, ContentRating::General);
        rate(&library, &sensitive, ContentRating::Sensitive);
        rate(&library, &questionable, ContentRating::Questionable);
        rate(&library, &explicit, ContentRating::Explicit);
        Fixture {
            _dir: dir,
            library,
            general,
            sensitive,
            questionable,
            explicit,
            unrated,
        }
    }

    fn search(&self, conditions: Vec<ConditionInput>) -> BTreeSet<String> {
        let tree = Search::new(
            &self.library.vocabulary().unwrap(),
            &BuiltinApproxTable::bundled(),
        )
        .resolve(
            &SearchInput {
                conditions,
                exact: false,
            },
            ZH,
        );
        self.library
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
}

fn set(ids: &[&String]) -> BTreeSet<String> {
    ids.iter().map(|s| (*s).clone()).collect()
}

fn all(terms: Vec<TermInput>) -> ConditionInput {
    ConditionInput {
        any: terms,
        negate: false,
    }
}

fn not(terms: Vec<TermInput>) -> ConditionInput {
    ConditionInput {
        any: terms,
        negate: true,
    }
}

/// 点选候选得到的搜索框项。
fn picked(ratings: &[ContentRating]) -> TermInput {
    TermInput::Rating {
        ratings: ratings.to_vec(),
    }
}

const ADULT: [ContentRating; 2] = [ContentRating::Questionable, ContentRating::Explicit];

#[test]
fn typing_r18_offers_one_candidate_for_both_adult_ratings_and_it_finds_exactly_those_images() {
    let f = Fixture::new();
    for typed in ["R18", "r-18", "成人"] {
        let found = rating_candidates(typed, false);
        assert!(
            found
                .iter()
                .any(|c| c.rating.ratings == ADULT && c.rating.r18),
            "输入“{typed}”时没有合并的分级候选：{found:?}"
        );
    }

    assert_eq!(
        f.search(vec![all(vec![picked(&ADULT)])]),
        set(&[&f.questionable, &f.explicit])
    );
}

#[test]
fn excluding_r18_leaves_general_sensitive_and_unrated_images() {
    let f = Fixture::new();
    assert_eq!(
        f.search(vec![not(vec![picked(&ADULT)])]),
        set(&[&f.general, &f.sensitive, &f.unrated])
    );
}

#[test]
fn the_artists_corrected_rating_wins_over_the_automatic_one() {
    let f = Fixture::new();
    f.library
        .edit(
            std::slice::from_ref(&f.explicit),
            &[ImageEdit::SetRating {
                rating: ContentRating::General,
            }],
        )
        .unwrap();
    f.library
        .edit(
            std::slice::from_ref(&f.unrated),
            &[ImageEdit::SetRating {
                rating: ContentRating::Explicit,
            }],
        )
        .unwrap();

    assert_eq!(
        f.search(vec![all(vec![picked(&ADULT)])]),
        set(&[&f.questionable, &f.unrated])
    );
    assert_eq!(
        f.search(vec![all(vec![picked(&[ContentRating::General])])]),
        set(&[&f.general, &f.explicit])
    );
}

#[test]
fn with_safe_mode_on_adult_candidates_disappear_and_adult_conditions_find_nothing() {
    let f = Fixture::new();
    f.library.set_safe_mode(true);

    for typed in ["R18", "成人", "敏感", "explicit", "questionable"] {
        let found = rating_candidates(typed, true);
        assert!(
            found
                .iter()
                .all(|c| c.rating.ratings.iter().all(|r| !r.is_adult())),
            "安全模式开着时输入“{typed}”出现了成人分级候选：{found:?}"
        );
    }
    let names = |typed| -> Vec<String> {
        rating_candidates(typed, true)
            .into_iter()
            .map(|c| shown_name(&c.rating))
            .collect()
    };
    assert_eq!(names("全年龄"), ["全年龄"]);
    assert_eq!(names("sensitive"), ["轻度"]);

    assert_eq!(f.search(vec![all(vec![picked(&ADULT)])]), set(&[]));
    assert_eq!(
        f.search(vec![all(vec![picked(&[ContentRating::Explicit])])]),
        set(&[])
    );
    assert_eq!(
        f.search(vec![not(vec![picked(&ADULT)])]),
        set(&[&f.general, &f.sensitive, &f.unrated])
    );
}

#[test]
fn typed_text_also_matches_the_ratings_it_names_unless_safe_mode_hides_them() {
    let f = Fixture::new();
    let text = |t: &str| TermInput::Text {
        text: t.into(),
        dismissed: vec![],
    };
    assert_eq!(
        f.search(vec![all(vec![text("R18")])]),
        set(&[&f.questionable, &f.explicit])
    );
    assert_eq!(
        f.search(vec![all(vec![text("全年龄")])]),
        set(&[&f.general])
    );

    f.library.set_safe_mode(true);
    assert_eq!(f.search(vec![all(vec![text("R18")])]), set(&[]));
    let tree = Search::new(
        &f.library.vocabulary().unwrap(),
        &BuiltinApproxTable::bundled(),
    )
    .resolve(
        &SearchInput {
            conditions: vec![all(vec![text("R18")])],
            exact: false,
        },
        ZH,
    );
    let shown = format!("{tree:?}");
    assert!(
        !shown.contains("Explicit"),
        "安全模式开着时文字项展开了成人分级：{shown}"
    );
}

fn tag(f: &Fixture, ids: &[&String], name: &str) -> TermInput {
    let ids: Vec<String> = ids.iter().map(|s| (*s).clone()).collect();
    f.library
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
    let id = f
        .library
        .vocabulary()
        .unwrap()
        .tags
        .into_iter()
        .find(|t| t.names.iter().any(|n| n.name == name))
        .unwrap()
        .id;
    TermInput::Tag {
        id,
        dismissed: vec![],
    }
}

#[test]
fn rating_conditions_combine_with_tags_and_sit_inside_the_same_alternatives() {
    let f = Fixture::new();
    let short_hair = tag(&f, &[&f.general, &f.explicit, &f.unrated], "短发");
    let general = picked(&[ContentRating::General]);

    assert_eq!(
        f.search(vec![
            all(vec![short_hair.clone()]),
            all(vec![picked(&ADULT)])
        ]),
        set(&[&f.explicit])
    );
    assert_eq!(
        f.search(vec![
            all(vec![short_hair.clone()]),
            not(vec![picked(&ADULT)])
        ]),
        set(&[&f.general, &f.unrated])
    );
    assert_eq!(
        f.search(vec![all(vec![
            short_hair,
            picked(&[ContentRating::Sensitive])
        ])]),
        set(&[&f.general, &f.sensitive, &f.explicit, &f.unrated])
    );
    assert_eq!(
        f.search(vec![all(vec![
            general,
            picked(&[ContentRating::Questionable])
        ])]),
        set(&[&f.general, &f.questionable])
    );
}

#[test]
fn english_display_names_are_searchable_like_the_chinese_ones() {
    let found = |typed| -> Vec<(String, Option<String>)> {
        rating_candidates(typed, false)
            .into_iter()
            .map(|c| (shown_name(&c.rating), c.via))
            .collect()
    };
    assert_eq!(found("mild"), [("轻度".to_owned(), None)]);
    assert_eq!(found("全年龄"), [("全年龄".to_owned(), None)]);
    assert!(found("adult").contains(&("成人".to_owned(), None)));
    assert!(
        found("explicit").contains(&("成人".to_owned(), Some("explicit".to_owned()))),
        "Danbooru 的分级名仍是其他叫法"
    );
}
