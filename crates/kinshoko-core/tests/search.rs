//! 基础检索（#54）：Search 是纯计算，输入文字与词表快照 → 可见的条件树与候选。
//! 这里只用手写的词表快照，不碰资料库与文件。

use kinshoko_core::library::{LocalizedName, TagAlias, TagNamespace, Vocabulary, VocabularyTag};
use kinshoko_core::search::{
    Condition, ConditionInput, ConditionTree, Search, SearchInput, Term, TermInput,
};

const ZH: &str = "zh-CN";

fn tag(id: &str, namespace: TagNamespace, name: &str, aliases: &[&str], count: u32) -> VocabularyTag {
    VocabularyTag {
        id: id.into(),
        namespace,
        names: vec![LocalizedName {
            lang: ZH.into(),
            name: name.into(),
        }],
        aliases: aliases
            .iter()
            .map(|a| TagAlias {
                name: (*a).into(),
                lang: None,
            })
            .collect(),
        external: Vec::new(),
        count,
    }
}

fn vocabulary(tags: Vec<VocabularyTag>) -> Vocabulary {
    Vocabulary { revision: 7, tags }
}

fn text(t: &str) -> TermInput {
    TermInput::Text { text: t.into() }
}

fn tag_term(id: &str) -> TermInput {
    TermInput::Tag { id: id.into() }
}

fn all(terms: Vec<TermInput>) -> ConditionInput {
    ConditionInput {
        any: terms,
        negate: false,
    }
}

fn input(conditions: Vec<ConditionInput>) -> SearchInput {
    SearchInput { conditions }
}

/// 条件树里每个条件的各项，写成“文字/标签 id 列表”便于比较。
fn shape(tree: &ConditionTree) -> Vec<(bool, Vec<String>)> {
    tree.conditions
        .iter()
        .map(|Condition { any, negate }| {
            let terms = any
                .iter()
                .map(|term| match term {
                    Term::Tag { tag, .. } => format!("tag:{}", tag.id),
                    Term::Text { text, tags } => {
                        let ids: Vec<&str> = tags.iter().map(|t| t.id.as_str()).collect();
                        format!("text:{text}[{}]", ids.join(","))
                    }
                })
                .collect();
            (*negate, terms)
        })
        .collect()
}

#[test]
fn typed_words_match_every_tag_whose_name_or_alias_contains_them_in_any_namespace() {
    let search = Search::new(&vocabulary(vec![
        tag("a1", TagNamespace::Artist, "某某", &[], 3),
        tag("c1", TagNamespace::Character, "某某", &[], 2),
        tag("g1", TagNamespace::General, "蓝发", &["蓝头发"], 5),
        tag("g2", TagNamespace::General, "短发", &[], 4),
    ]));

    let tree = search.resolve(&input(vec![all(vec![text("某某")])]), ZH);
    assert_eq!(shape(&tree), [(false, vec!["text:某某[a1,c1]".to_owned()])]);

    let tree = search.resolve(&input(vec![all(vec![text(" 头发 ")])]), ZH);
    assert_eq!(shape(&tree), [(false, vec!["text:头发[g1]".to_owned()])]);
}

#[test]
fn conditions_stay_separate_alternatives_stay_inside_one_and_exclusion_is_kept() {
    let search = Search::new(&vocabulary(vec![
        tag("blue", TagNamespace::General, "蓝发", &[], 5),
        tag("purple", TagNamespace::General, "紫发", &[], 3),
        tag("multi", TagNamespace::General, "多人", &[], 2),
        tag("short", TagNamespace::General, "短发", &[], 4),
    ]));

    // “蓝发或紫发、不要多人、短发”。
    let tree = search.resolve(
        &input(vec![
            all(vec![tag_term("blue"), tag_term("purple")]),
            ConditionInput {
                any: vec![tag_term("multi")],
                negate: true,
            },
            all(vec![tag_term("short")]),
        ]),
        ZH,
    );
    assert_eq!(
        shape(&tree),
        [
            (false, vec!["tag:blue".to_owned(), "tag:purple".to_owned()]),
            (true, vec!["tag:multi".to_owned()]),
            (false, vec!["tag:short".to_owned()]),
        ]
    );
    let Term::Tag { tag, similar } = &tree.conditions[0].any[1] else {
        panic!("应是标签项");
    };
    assert_eq!(tag.name, "紫发");
    assert!(similar.is_empty(), "基础检索不做近似展开");
}

#[test]
fn width_and_case_do_not_matter_when_typing() {
    let search = Search::new(&vocabulary(vec![
        tag("a", TagNamespace::Character, "Ｍｉｋｕ", &[], 1),
        tag("b", TagNamespace::General, "ポニーテール", &[], 1),
    ]));

    let tree = search.resolve(&input(vec![all(vec![text("MIKU")])]), ZH);
    assert_eq!(shape(&tree), [(false, vec!["text:MIKU[a]".to_owned()])]);
    let tree = search.resolve(&input(vec![all(vec![text("ﾎﾟﾆｰ")])]), ZH);
    assert_eq!(shape(&tree), [(false, vec!["text:ﾎﾟﾆｰ[b]".to_owned()])]);
}

#[test]
fn external_names_are_not_a_way_to_find_a_tag_unless_it_is_still_untranslated() {
    let mut translated = tag("eyes", TagNamespace::General, "蓝瞳", &[], 2);
    translated.external = vec!["blue_eyes".into()];
    let untranslated = VocabularyTag {
        id: "raw".into(),
        namespace: TagNamespace::General,
        names: Vec::new(),
        aliases: Vec::new(),
        external: vec!["hair_ornament".into()],
        count: 1,
    };
    let search = Search::new(&vocabulary(vec![translated, untranslated]));

    let tree = search.resolve(&input(vec![all(vec![text("blue_eyes")])]), ZH);
    assert_eq!(shape(&tree), [(false, vec!["text:blue_eyes[]".to_owned()])]);
    // 尚未翻译的标签以外部名称（下划线换成空格）显示，画师照着显示的名字也能查到。
    let tree = search.resolve(&input(vec![all(vec![text("hair orn")])]), ZH);
    assert_eq!(shape(&tree), [(false, vec!["text:hair orn[raw]".to_owned()])]);
    let Term::Text { tags, .. } = &tree.conditions[0].any[0] else {
        panic!("应是文字项");
    };
    assert!(tags[0].untranslated);
}

#[test]
fn blank_words_are_ignored_but_a_condition_on_a_deleted_tag_matches_nothing() {
    let search = Search::new(&vocabulary(vec![tag(
        "a",
        TagNamespace::General,
        "蓝发",
        &[],
        1,
    )]));

    let tree = search.resolve(
        &input(vec![
            all(vec![text("  ")]),
            all(vec![]),
            all(vec![tag_term("gone")]),
            all(vec![tag_term("gone"), text("蓝")]),
        ]),
        ZH,
    );
    assert_eq!(
        shape(&tree),
        [(false, vec![]), (false, vec!["text:蓝[a]".to_owned()])]
    );
    assert_eq!(
        search.resolve(&SearchInput::default(), ZH),
        ConditionTree::default()
    );
}

#[test]
fn tag_names_in_the_tree_follow_the_interface_language() {
    let mut t = tag("a", TagNamespace::General, "蓝发", &[], 1);
    t.names.push(LocalizedName {
        lang: "ja".into(),
        name: "青髪".into(),
    });
    let search = Search::new(&vocabulary(vec![t]));

    let tree = search.resolve(&input(vec![all(vec![text("青髪")])]), ZH);
    let Term::Text { tags, .. } = &tree.conditions[0].any[0] else {
        panic!("应是文字项");
    };
    assert_eq!(tags[0].name, "蓝发");
    let tree = search.resolve(&input(vec![all(vec![tag_term("a")])]), "ja");
    let Term::Tag { tag, .. } = &tree.conditions[0].any[0] else {
        panic!("应是标签项");
    };
    assert_eq!(tag.name, "青髪");
}

/// 候选写成“命名空间：名称（经由的别名）×张数”便于比较。
fn listed(search: &Search, typed: &str) -> Vec<String> {
    search
        .candidates(typed, ZH, 10)
        .into_iter()
        .map(|c| {
            let ns = match c.tag.namespace {
                TagNamespace::General => "",
                TagNamespace::Artist => "作者：",
                TagNamespace::Character => "角色：",
                TagNamespace::Work => "作品：",
            };
            let via = c.via.map(|v| format!("（{v}）")).unwrap_or_default();
            format!("{ns}{}{via}×{}", c.tag.name, c.count)
        })
        .collect()
}

#[test]
fn one_word_in_several_namespaces_lists_one_candidate_per_namespace() {
    let search = Search::new(&vocabulary(vec![
        tag("a1", TagNamespace::Artist, "某某", &[], 3),
        tag("c1", TagNamespace::Character, "某某", &[], 8),
        tag("g1", TagNamespace::General, "短发", &[], 4),
    ]));

    assert_eq!(listed(&search, "某某"), ["角色：某某×8", "作者：某某×3"]);
    assert!(listed(&search, "  ").is_empty());
}

#[test]
fn candidates_rank_exact_then_prefix_then_contains_and_names_before_aliases() {
    let search = Search::new(&vocabulary(vec![
        tag("contains", TagNamespace::General, "浅蓝发", &[], 50),
        tag("prefix", TagNamespace::General, "蓝发挑染", &[], 1),
        tag("prefix-big", TagNamespace::General, "蓝发少女", &[], 9),
        tag("alias", TagNamespace::General, "青发", &["蓝发"], 99),
        tag("exact", TagNamespace::General, "蓝发", &[], 2),
        tag("unused", TagNamespace::General, "蓝发辫", &[], 0),
    ]));

    assert_eq!(
        listed(&search, "蓝发"),
        [
            "蓝发×2",
            "青发（蓝发）×99",
            "蓝发少女×9",
            "蓝发挑染×1",
            "浅蓝发×50",
        ],
        "没有图的标签不进候选"
    );
    assert_eq!(search.candidates("蓝", ZH, 2).len(), 2);
}

#[test]
fn a_name_in_another_language_counts_as_a_way_to_reach_the_tag() {
    let mut t = tag("a", TagNamespace::General, "蓝发", &[], 1);
    t.names.push(LocalizedName {
        lang: "en".into(),
        name: "Blue Hair".into(),
    });
    let search = Search::new(&vocabulary(vec![t]));

    assert_eq!(listed(&search, "blue"), ["蓝发（Blue Hair）×1"]);
}
