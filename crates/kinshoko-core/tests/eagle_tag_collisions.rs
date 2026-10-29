//! Eagle 标签撞上库里已有标签时的去向（#217，ADR-0012）。

#[path = "support/eagle.rs"]
#[allow(dead_code)]
mod eagle;

use std::collections::BTreeMap;
use std::path::Path;

use kinshoko_core::Library;
use kinshoko_core::library::{
    ExternalVocabulary, ImportOutcome, ImportSource, TagAlias, TagEdit, TagNamespace, TagRef,
    TagTranslation, TagTranslations,
};
use serde_json::json;

const ZH: &str = "zh-CN";

fn fixture(dir: &Path, tags: &[&[&str]]) -> eagle::EagleFixture {
    let mut fixture = eagle::build(&dir.join("主库.library"), "4.0.0", tags.len());
    for (i, t) in tags.iter().enumerate() {
        fixture.items[i]["tags"] = json!(t);
        fixture.items[i]["isDeleted"] = json!(false);
        fixture.save_item(i);
    }
    fixture
}

fn import(library: &Library, fixture: &eagle::EagleFixture) -> Vec<String> {
    library
        .import(ImportSource {
            paths: vec![fixture.root.clone()],
        })
        .wait()
        .items
        .into_iter()
        .filter_map(|item| match item.outcome {
            ImportOutcome::Imported { image_id } | ImportOutcome::Merged { image_id } => {
                Some(image_id)
            }
            _ => None,
        })
        .collect()
}

fn vocabulary() -> ExternalVocabulary {
    ExternalVocabulary::new(
        ["blue_eyes".to_owned()],
        &TagTranslations {
            entries: vec![TagTranslation {
                external: "blue_eyes".into(),
                names: BTreeMap::from([(ZH.to_owned(), "蓝瞳".to_owned())]),
                aliases: Vec::new(),
            }],
        },
    )
}

/// 同一次匹配里两个 Eagle 标签对上同一个外部名称：留下的那个也要报出来。
#[test]
fn both_eagle_tags_that_meet_on_one_external_are_reported() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = fixture(dir.path(), &[&["blue eyes"], &["Blue_Eyes"]]);
    let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
    import(&library, &fixture);

    let mapping = library.map_eagle_tags(&vocabulary(), ZH).unwrap();

    assert_eq!(mapping.matched.len(), 2, "{mapping:?}");
    assert_eq!(
        mapping
            .matched
            .iter()
            .filter(|m| m.merged_into.is_some())
            .count(),
        1
    );
}

/// 外部名称属于另一个命名空间的标签：不并，Eagle 标签留在没对上的里。
#[test]
fn an_external_owned_in_another_namespace_is_not_merged() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = fixture(dir.path(), &[&["blue eyes"], &[]]);
    let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
    let images = import(&library, &fixture);
    library
        .edit_tags(
            std::slice::from_ref(&images[1]),
            &[TagEdit::Add {
                tag: TagRef::External {
                    namespace: TagNamespace::Character,
                    name: "blue_eyes".into(),
                },
            }],
        )
        .unwrap();

    let mapping = library.map_eagle_tags(&vocabulary(), ZH).unwrap();

    assert!(mapping.matched.is_empty(), "{mapping:?}");
    assert_eq!(mapping.unmatched.len(), 1);
    assert_eq!(mapping.unmatched[0].candidates, ["blue_eyes"]);
    let tags = library.vocabulary().unwrap().tags;
    assert_eq!(tags.len(), 2);
    assert!(tags.iter().all(|t| t.count == 1));
}

/// Eagle 原文恰是已有标签的名称：沿用那个标签，名称改了以后重新迁入仍落在它上面。
#[test]
fn an_original_reusing_a_named_tag_still_finds_it_after_a_rename() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = fixture(dir.path(), &[&["cyberpunk"]]);
    let dir2 = tempfile::tempdir().unwrap();
    let library2 = Library::create(&dir2.path().join("kinshoko"), "参考").unwrap();
    let first = fixture_image(&library2, dir2.path());
    library2
        .edit_tags(
            std::slice::from_ref(&first),
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: "cyberpunk".into(),
                    lang: "en".into(),
                },
            }],
        )
        .unwrap();
    import(&library2, &fixture);
    let tag = library2.vocabulary().unwrap().tags;
    assert_eq!(tag.len(), 1, "沿用已有标签");
    assert!(tag[0].aliases.contains(&TagAlias {
        name: "cyberpunk".into(),
        lang: None
    }));
    library2.rename_tag(&tag[0].id, "en", "cyber punk").unwrap();

    import(&library2, &fixture);

    assert_eq!(library2.vocabulary().unwrap().tags.len(), 1);
}

fn fixture_image(library: &Library, dir: &Path) -> String {
    let path = dir.join("own.png");
    image::RgbaImage::from_pixel(4, 3, image::Rgba([200, 1, 2, 255]))
        .save(&path)
        .unwrap();
    library
        .import(ImportSource { paths: vec![path] })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned()
}
