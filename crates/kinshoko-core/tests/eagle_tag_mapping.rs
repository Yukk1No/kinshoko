//! 迁入向导：Eagle 标签的外部对应（#59）。只通过核心 crate 的公开接口验证。

#[path = "support/eagle.rs"]
#[allow(dead_code)]
mod eagle;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use kinshoko_core::Library;
use kinshoko_core::approx::BuiltinApproxTable;
use kinshoko_core::library::{
    BrowseQuery, EagleTagMapping, ExternalVocabulary, ImportOutcome, ImportSource, MatchBasis,
    TagTranslation, TagTranslations,
};
use kinshoko_core::search::{ConditionInput, Search, SearchInput, TermInput};
use serde_json::json;

const ZH: &str = "zh-CN";

/// 迁入一个 Eagle 库，第 i 个条目带 `tags[i]` 中的标签。返回资料库与各条目的参考图 id。
fn import(dir: &Path, tags: &[&[&str]]) -> (Library, Vec<String>) {
    let mut fixture = eagle::build(&dir.join("主库.library"), "4.0.0", tags.len());
    for (i, t) in tags.iter().enumerate() {
        fixture.items[i]["tags"] = json!(t);
        fixture.items[i]["isDeleted"] = json!(false);
        fixture.save_item(i);
    }
    let library = Library::create(&dir.join("kinshoko"), "参考").unwrap();
    let report = library
        .import(ImportSource {
            paths: vec![fixture.root.clone()],
        })
        .wait();
    let images = report
        .items
        .into_iter()
        .map(|item| match item.outcome {
            ImportOutcome::Imported { image_id } => image_id,
            other => panic!("未迁入：{other:?}"),
        })
        .collect();
    (library, images)
}

fn translations(entries: &[(&str, &str)]) -> TagTranslations {
    TagTranslations {
        entries: entries
            .iter()
            .map(|(external, zh)| TagTranslation {
                external: (*external).into(),
                names: BTreeMap::from([(ZH.to_owned(), (*zh).to_owned())]),
                aliases: Vec::new(),
            })
            .collect(),
    }
}

fn matched(mapping: &EagleTagMapping) -> Vec<(String, Vec<String>, MatchBasis)> {
    let mut out: Vec<_> = mapping
        .matched
        .iter()
        .map(|m| (m.tag.name.clone(), m.external.clone(), m.basis))
        .collect();
    out.sort();
    out
}

fn unmatched(mapping: &EagleTagMapping) -> Vec<String> {
    mapping
        .unmatched
        .iter()
        .map(|u| u.tag.name.clone())
        .collect()
}

#[test]
fn eagle_tags_match_external_names_exactly_after_folding_case_spaces_and_full_width() {
    let dir = tempfile::tempdir().unwrap();
    let (library, _) = import(
        dir.path(),
        &[&["Blue Eyes", "ＡＱＵＡ　ＥＹＥＳ"], &["long_hair", "自造"]],
    );
    let vocabulary = ExternalVocabulary::new(
        ["blue_eyes", "aqua_eyes", "long_hair", "short_hair"].map(String::from),
        &TagTranslations::default(),
    );

    let mapping = library.map_eagle_tags(&vocabulary, ZH).unwrap();

    assert_eq!(
        matched(&mapping),
        [
            (
                "Blue Eyes".to_owned(),
                vec!["blue_eyes".to_owned()],
                MatchBasis::Name
            ),
            (
                "long_hair".to_owned(),
                vec!["long_hair".to_owned()],
                MatchBasis::Name
            ),
            (
                "ＡＱＵＡ　ＥＹＥＳ".to_owned(),
                vec!["aqua_eyes".to_owned()],
                MatchBasis::Name
            ),
        ]
    );
    assert_eq!(unmatched(&mapping), ["自造"]);
    // 匹配结果写进外部对应：之后模型输出 blue_eyes 会落在这个 Eagle 标签上。
    let vocab = library.vocabulary().unwrap();
    let blue = vocab
        .tags
        .iter()
        .find(|t| t.names.iter().any(|n| n.name == "Blue Eyes"))
        .unwrap();
    assert_eq!(blue.external, ["blue_eyes"]);
}

#[test]
fn translation_names_match_and_ambiguous_or_taken_names_are_left_for_the_artist() {
    let dir = tempfile::tempdir().unwrap();
    let (library, images) = import(
        dir.path(),
        &[&["蓝瞳", "双马尾"], &["水色瞳", "red eyes"], &["双马尾"]],
    );
    // 模型先输出过 red_eyes：外部名称已落在另一个标签上。
    library
        .edit_tags(
            std::slice::from_ref(&images[0]),
            &[kinshoko_core::library::TagEdit::Add {
                tag: kinshoko_core::library::TagRef::External {
                    namespace: kinshoko_core::library::TagNamespace::General,
                    name: "red_eyes".into(),
                },
            }],
        )
        .unwrap();
    let vocabulary = ExternalVocabulary::new(
        ["red_eyes", "aqua_eyes"].map(String::from),
        &translations(&[
            ("blue_eyes", "蓝瞳"),
            ("twintails", "双马尾"),
            ("low_twintails", "双马尾"),
        ]),
    );

    let mapping = library.map_eagle_tags(&vocabulary, ZH).unwrap();

    assert_eq!(
        matched(&mapping),
        [(
            "蓝瞳".to_owned(),
            vec!["blue_eyes".to_owned()],
            MatchBasis::Translation
        )]
    );
    // 张数多的排前面。
    assert_eq!(unmatched(&mapping), ["双马尾", "red eyes", "水色瞳"]);
    assert_eq!(
        mapping.unmatched[0].candidates,
        ["low_twintails", "twintails"]
    );
    assert_eq!(
        mapping.unmatched[1].taken_external.as_deref(),
        Some("red_eyes")
    );
    assert_eq!(
        mapping.unmatched[1]
            .taken_by
            .as_ref()
            .map(|t| t.name.as_str()),
        Some("red eyes")
    );
    assert!(mapping.unmatched[2].candidates.is_empty());
    assert_eq!(mapping.vocabulary_size, 5);

    // 再次打开向导：已写入的算作之前就有，没对上的仍列出。
    let again = library.map_eagle_tags(&vocabulary, ZH).unwrap();
    assert_eq!(again.matched[0].basis, MatchBasis::Earlier);
    assert_eq!(unmatched(&again), ["双马尾", "red eyes", "水色瞳"]);
}

/// 只点选 `tag` 一个条件（近似查找开启）时找到的图。
fn found(library: &Library, tag: &str) -> BTreeSet<String> {
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
            exact: false,
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

#[test]
fn tags_given_an_external_mapping_by_hand_join_the_built_in_expansion_and_skipped_ones_still_work()
{
    let dir = tempfile::tempdir().unwrap();
    let (library, images) = import(dir.path(), &[&["blue eyes"], &["水色"], &["自造"]]);
    let vocabulary = ExternalVocabulary::new(
        ExternalVocabulary::builtin_names(&BuiltinApproxTable::bundled()),
        &TagTranslations::default(),
    );
    assert!(vocabulary.len() > 50);
    let mapping = library.map_eagle_tags(&vocabulary, ZH).unwrap();
    assert_eq!(unmatched(&mapping), ["水色", "自造"]);
    let blue = mapping.matched[0].tag.id.clone();
    let aqua = mapping.unmatched[0].tag.id.clone();
    let own = mapping.unmatched[1].tag.id.clone();

    // 补对应之前：水色没有外部对应，不参与内置近似对应表。
    assert_eq!(found(&library, &blue), set(&[&images[0]]));

    // 联想按规范化后的前缀；画师照自己的写法输入，写入词表的写法。
    assert_eq!(vocabulary.suggest("Aqua E", 3), ["aqua_eyes"]);
    let mapped = library
        .map_tag_external(&aqua, "Aqua Eyes", &vocabulary)
        .unwrap();
    assert_eq!(mapped.external, "aqua_eyes");
    assert!(mapped.known);

    assert_eq!(found(&library, &blue), set(&[&images[0], &images[1]]));
    assert_eq!(found(&library, &aqua), set(&[&images[1], &images[0]]));
    // 跳过的标签照常迁入、照常可查，只是不展开。
    assert_eq!(found(&library, &own), set(&[&images[2]]));

    let after = library.map_eagle_tags(&vocabulary, ZH).unwrap();
    assert_eq!(unmatched(&after), ["自造"]);
    // 显示名不变：外部对应不是叫法。
    assert!(
        after
            .matched
            .iter()
            .any(|m| m.tag.name == "水色" && m.tag.has_external)
    );

    // 词表里没有的名称也照写，但标明不认识。
    let unknown = library
        .map_tag_external(&own, "my_tag", &vocabulary)
        .unwrap();
    assert_eq!(unknown.external, "my_tag");
    assert!(!unknown.known);
}

fn set(ids: &[&String]) -> BTreeSet<String> {
    ids.iter().map(|s| (*s).clone()).collect()
}

#[test]
fn with_safe_mode_on_tags_only_on_sealed_images_are_not_listed() {
    use kinshoko_core::library::{ContentRating, FactSource, RatingFact};

    let dir = tempfile::tempdir().unwrap();
    let (library, images) = import(dir.path(), &[&["日常"], &["只在成人图上"]]);
    library.set_safe_mode(true);
    library
        .replace_source_rating(
            &FactSource::model("test"),
            &images[1],
            Some(RatingFact {
                rating: ContentRating::Explicit,
                score: Some(0.9),
            }),
        )
        .unwrap();
    let vocabulary = ExternalVocabulary::new(Vec::new(), &TagTranslations::default());

    assert_eq!(
        unmatched(&library.map_eagle_tags(&vocabulary, ZH).unwrap()),
        ["日常"]
    );
    library.set_safe_mode(false);
    assert_eq!(
        unmatched(&library.map_eagle_tags(&vocabulary, ZH).unwrap()),
        ["只在成人图上", "日常"]
    );
}

#[test]
fn the_tagger_vocabulary_is_read_from_the_name_column_of_selected_tags_csv() {
    let dir = tempfile::tempdir().unwrap();
    let csv = dir.path().join("selected_tags.csv");
    std::fs::write(
        &csv,
        "tag_id,name,category,count\n0,blue_eyes,0,10\n1,\"hatsune_miku\",4,9\n",
    )
    .unwrap();
    let names = ExternalVocabulary::read_tags_csv(&csv).unwrap();
    assert_eq!(names, ["blue_eyes", "hatsune_miku"]);
    let vocabulary = ExternalVocabulary::new(names, &TagTranslations::default());
    assert_eq!(vocabulary.by_name("Hatsune Miku"), ["hatsune_miku"]);
}
