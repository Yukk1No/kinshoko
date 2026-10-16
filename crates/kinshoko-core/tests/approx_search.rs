//! 近似查找（#56）：Search 按内置近似对应表与个人近似对应表把相近标签展开成可见的“任一”。
//! 这里只用手写的词表快照与对应表，不碰资料库与文件。

use kinshoko_core::approx::{ApproxRelation, ApproxSource, BuiltinApproxTable, PersonalApprox};
use kinshoko_core::library::{LocalizedName, TagNamespace, Vocabulary, VocabularyTag};
use kinshoko_core::search::{ConditionInput, Search, SearchInput, Term, TermInput};

const ZH: &str = "zh-CN";

fn tag(id: &str, name: &str, external: &[&str], count: u32) -> VocabularyTag {
    VocabularyTag {
        id: id.into(),
        namespace: TagNamespace::General,
        names: vec![LocalizedName {
            lang: ZH.into(),
            name: name.into(),
        }],
        aliases: Vec::new(),
        external: external.iter().map(|e| (*e).into()).collect(),
        count,
    }
}

/// 瞳色：蓝瞳～水色瞳、蓝瞳～紫瞳在内置近似对应表中；“天空色”是画师自造的标签，没有外部对应。
fn eyes() -> Vec<VocabularyTag> {
    vec![
        tag("blue", "蓝瞳", &["blue_eyes"], 5),
        tag("aqua", "水色瞳", &["aqua_eyes"], 3),
        tag("purple", "紫瞳", &["purple_eyes"], 2),
        tag("red", "红瞳", &["red_eyes"], 4),
        tag("sky", "天空色", &[], 1),
    ]
}

fn builtin(version: u32, pairs: &[(&str, &str)]) -> BuiltinApproxTable {
    BuiltinApproxTable::from_pairs(version, pairs.iter().copied())
}

fn eye_table() -> BuiltinApproxTable {
    builtin(
        1,
        &[("aqua_eyes", "blue_eyes"), ("blue_eyes", "purple_eyes")],
    )
}

fn vocabulary(tags: Vec<VocabularyTag>, personal: Vec<PersonalApprox>) -> Vocabulary {
    Vocabulary {
        revision: 1,
        tags,
        personal_approx: personal,
    }
}

fn personal(a: &str, b: &str, relation: ApproxRelation) -> PersonalApprox {
    PersonalApprox {
        a: a.into(),
        b: b.into(),
        relation,
    }
}

fn pick(id: &str) -> TermInput {
    TermInput::Tag {
        id: id.into(),
        dismissed: Vec::new(),
    }
}

fn one(term: TermInput) -> SearchInput {
    SearchInput {
        conditions: vec![ConditionInput {
            any: vec![term],
            negate: false,
        }],
        exact: false,
    }
}

/// 第一个条件第一项展开出的相近标签：（id，来源），按显示顺序。
fn expanded(search: &Search, input: &SearchInput) -> Vec<(String, ApproxSource)> {
    let tree = search.resolve(input, ZH);
    let similar = match &tree.conditions[0].any[0] {
        Term::Tag { similar, .. } | Term::Text { similar, .. } => similar,
    };
    similar
        .iter()
        .map(|s| (s.tag.id.clone(), s.source))
        .collect()
}

fn ids(found: &[(String, ApproxSource)]) -> Vec<&str> {
    found.iter().map(|(id, _)| id.as_str()).collect()
}

#[test]
fn a_picked_tag_expands_by_default_into_its_built_in_neighbours_without_chaining() {
    let search = Search::new(&vocabulary(eyes(), Vec::new()), &eye_table());

    let found = expanded(&search, &one(pick("blue")));
    assert_eq!(ids(&found), ["aqua", "purple"], "按张数从多到少");
    assert!(found.iter().all(|(_, s)| *s == ApproxSource::Builtin));

    // 相近关系不传递：水色瞳～蓝瞳、蓝瞳～紫瞳，不表示水色瞳～紫瞳。
    assert_eq!(ids(&expanded(&search, &one(pick("aqua")))), ["blue"]);
    assert!(expanded(&search, &one(pick("red"))).is_empty());
}

#[test]
fn switching_back_to_exact_expands_nothing() {
    let search = Search::new(&vocabulary(eyes(), Vec::new()), &eye_table());
    let mut input = one(pick("blue"));
    input.exact = true;

    assert!(expanded(&search, &input).is_empty());
    let mut also_text = one(TermInput::Text {
        text: "蓝瞳".into(),
        dismissed: Vec::new(),
    });
    also_text.exact = true;
    assert!(expanded(&search, &also_text).is_empty());
}

#[test]
fn typed_words_expand_the_neighbours_of_the_tags_they_match() {
    let search = Search::new(&vocabulary(eyes(), Vec::new()), &eye_table());

    let input = one(TermInput::Text {
        text: "蓝瞳".into(),
        dismissed: Vec::new(),
    });
    let tree = search.resolve(&input, ZH);
    let Term::Text { tags, similar, .. } = &tree.conditions[0].any[0] else {
        panic!("应是文字项");
    };
    assert_eq!(tags.len(), 1);
    let shown: Vec<(&str, &[String])> = similar
        .iter()
        .map(|s| (s.tag.id.as_str(), s.of.as_slice()))
        .collect();
    assert_eq!(
        shown,
        [
            ("aqua", &["blue".to_owned()][..]),
            ("purple", &["blue".to_owned()][..])
        ],
        "每个相近标签记着它和哪个标签相近，“以后都不展开”据此记个人条目"
    );

    // “瞳”同时匹配蓝瞳、水色瞳、紫瞳、红瞳：已经匹配到的标签不再作为相近标签重复列出。
    let input = one(TermInput::Text {
        text: "瞳".into(),
        dismissed: Vec::new(),
    });
    assert!(expanded(&search, &input).is_empty());
}

#[test]
fn not_similar_in_the_personal_table_beats_the_same_built_in_pair_in_either_order() {
    let search = Search::new(
        &vocabulary(
            eyes(),
            vec![personal("purple", "blue", ApproxRelation::NotSimilar)],
        ),
        &eye_table(),
    );

    assert_eq!(ids(&expanded(&search, &one(pick("blue")))), ["aqua"]);
    assert!(expanded(&search, &one(pick("purple"))).is_empty());
}

#[test]
fn any_library_tag_can_be_made_similar_including_ones_without_an_external_mapping() {
    let search = Search::new(
        &vocabulary(
            eyes(),
            vec![
                personal("blue", "sky", ApproxRelation::Similar),
                // 和内置表重复的“相近”：仍只列一次，来源记为个人。
                personal("aqua", "blue", ApproxRelation::Similar),
            ],
        ),
        &eye_table(),
    );

    assert_eq!(
        expanded(&search, &one(pick("blue"))),
        [
            ("aqua".to_owned(), ApproxSource::Personal),
            ("purple".to_owned(), ApproxSource::Builtin),
            ("sky".to_owned(), ApproxSource::Personal),
        ]
    );
    assert_eq!(
        expanded(&search, &one(pick("sky"))),
        [("blue".to_owned(), ApproxSource::Personal)]
    );
}

#[test]
fn just_this_once_leaves_a_neighbour_out_of_that_term_only() {
    let search = Search::new(&vocabulary(eyes(), Vec::new()), &eye_table());
    let input = SearchInput {
        conditions: vec![
            ConditionInput {
                any: vec![TermInput::Tag {
                    id: "blue".into(),
                    dismissed: vec!["aqua".into()],
                }],
                negate: false,
            },
            ConditionInput {
                any: vec![pick("blue")],
                negate: true,
            },
        ],
        exact: false,
    };

    let tree = search.resolve(&input, ZH);
    let similar_ids = |i: usize| match &tree.conditions[i].any[0] {
        Term::Tag { similar, .. } => similar.iter().map(|s| s.tag.id.clone()).collect(),
        Term::Text { .. } => Vec::<String>::new(),
    };
    assert_eq!(similar_ids(0), ["purple"]);
    assert_eq!(similar_ids(1), ["aqua", "purple"]);
}

#[test]
fn neighbours_without_any_visible_image_are_not_expanded() {
    let mut tags = eyes();
    tags.iter_mut().find(|t| t.id == "aqua").unwrap().count = 0;
    let search = Search::new(&vocabulary(tags, Vec::new()), &eye_table());

    assert_eq!(ids(&expanded(&search, &one(pick("blue")))), ["purple"]);
}

#[test]
fn updating_the_built_in_table_leaves_personal_entries_in_force() {
    let mine = vec![
        personal("blue", "sky", ApproxRelation::Similar),
        personal("aqua", "blue", ApproxRelation::NotSimilar),
    ];
    let v1 = Search::new(&vocabulary(eyes(), mine.clone()), &eye_table());
    // 新版内置表去掉了蓝瞳～紫瞳，加上了蓝瞳～红瞳，也仍有画师否定过的水色瞳～蓝瞳。
    let v2_table = builtin(2, &[("aqua_eyes", "blue_eyes"), ("blue_eyes", "red_eyes")]);
    let v2 = Search::new(&vocabulary(eyes(), mine), &v2_table);

    assert_eq!(ids(&expanded(&v1, &one(pick("blue")))), ["purple", "sky"]);
    assert_eq!(ids(&expanded(&v2, &one(pick("blue")))), ["red", "sky"]);
}

#[test]
fn the_bundled_table_loads_and_unknown_formats_are_refused() {
    let table = BuiltinApproxTable::bundled();
    assert!(table.table_version() >= 1);
    assert!(!table.is_empty());

    let wrong = r#"{"format":"something-else","format_version":1,"table_version":1,"pairs":[]}"#;
    assert!(BuiltinApproxTable::parse(wrong).is_err());
    let newer = r#"{"format":"kinshoko.builtin-approx-table","format_version":2,"table_version":1,"pairs":[]}"#;
    assert!(BuiltinApproxTable::parse(newer).is_err());
    let ok = r#"{"format":"kinshoko.builtin-approx-table","format_version":1,"table_version":3,
        "categories":["eye_color"],"pairs":[{"category":"eye_color","a":"aqua_eyes","b":"blue_eyes"}]}"#;
    let parsed = BuiltinApproxTable::parse(ok).unwrap();
    assert_eq!((parsed.table_version(), parsed.len()), (3, 1));
}
