//! 随软件分发的翻译表（#76 Core3、#77 C1，ADR-0003）：外部名称首次进库时的初始名称与别名，
//! 表更新只给尚未翻译的标签做首次初始化，不动画师改过的名称、别名与人工标签决定。
//! 读的是真正随软件分发的 `data/builtin-translation-table.json`（`TagTranslations::bundled()`）；
//! 应用壳的装配路径另在 `src-tauri/src/library.rs` 的测试里覆盖。

use std::collections::HashMap;
use std::path::Path;

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::approx::BuiltinApproxTable;
use kinshoko_core::library::{
    FactSource, ImportOutcome, ImportSource, SourceTag, TagAlias, TagEdit, TagLabel, TagNamespace,
    TagRef, TagTranslation, TagTranslations,
};
use kinshoko_core::search::Search;

const ZH: &str = "zh-CN";

fn library_with_images(dir: &Path, n: u8) -> (Library, Vec<String>) {
    let library = Library::create(&dir.join("lib"), "库").unwrap();
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

fn model_tags(library: &Library, image_id: &str, tags: &[(TagNamespace, &str)]) {
    let tags: Vec<_> = tags
        .iter()
        .map(|(namespace, name)| SourceTag {
            tag: TagRef::External {
                namespace: *namespace,
                name: (*name).into(),
            },
            score: Some(0.9),
        })
        .collect();
    library
        .replace_source_tags(&FactSource::model("pixai-v1.0"), image_id, &tags)
        .unwrap();
}

/// 这张图有效标签的中文显示，按外部名称取（从标签的显示查外部名称要经过词表）。
fn labels_by_external(library: &Library, image_id: &str) -> HashMap<String, TagLabel> {
    let vocabulary = library.vocabulary().unwrap();
    library
        .image_tags(image_id, ZH)
        .unwrap()
        .tags
        .into_iter()
        .filter_map(|t| {
            let entry = vocabulary.tags.iter().find(|v| v.id == t.tag.id).unwrap();
            Some((entry.external.first()?.clone(), t.tag))
        })
        .collect()
}

fn found(library: &Library, text: &str) -> Vec<String> {
    let search = Search::new(
        &library.vocabulary().unwrap(),
        &BuiltinApproxTable::bundled(),
    );
    search
        .candidates(text, ZH, 10)
        .into_iter()
        .map(|c| c.tag.name)
        .collect()
}

#[test]
fn the_bundled_table_gives_known_model_tags_chinese_names_and_aliases_to_find_them_by() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with_images(dir.path(), 1);
    library
        .set_translations(TagTranslations::bundled())
        .unwrap();

    model_tags(
        &library,
        &ids[0],
        &[
            (TagNamespace::General, "blue_eyes"),
            (TagNamespace::General, "long_hair"),
            (TagNamespace::Character, "hatsune_miku"),
        ],
    );

    let labels = labels_by_external(&library, &ids[0]);
    assert_eq!(labels["blue_eyes"].name, "蓝瞳");
    assert!(!labels["blue_eyes"].untranslated);
    assert_eq!(labels["long_hair"].name, "长发");
    // 角色不在翻译表里：照常进库，标明尚未翻译。
    assert_eq!(labels["hatsune_miku"].name, "hatsune miku");
    assert!(labels["hatsune_miku"].untranslated);

    assert_eq!(found(&library, "蓝瞳"), ["蓝瞳"]);
    assert_eq!(found(&library, "蓝眼睛"), ["蓝瞳"]);
    assert_eq!(found(&library, "长头发"), ["长发"]);
}

#[test]
fn without_a_translation_table_model_tags_stay_untranslated() {
    // 对照：核心资料库本身不带翻译表（由应用壳装上）；空表时外部名称照常进库、标明尚未翻译。
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with_images(dir.path(), 1);
    model_tags(&library, &ids[0], &[(TagNamespace::General, "blue_eyes")]);

    let labels = labels_by_external(&library, &ids[0]);
    assert_eq!(labels["blue_eyes"].name, "blue eyes");
    assert!(labels["blue_eyes"].untranslated);
    assert!(found(&library, "蓝瞳").is_empty());
}

#[test]
fn a_table_update_initialises_untranslated_tags_and_keeps_what_the_artist_changed() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with_images(dir.path(), 2);
    // 旧版本没有翻译表时进库的模型标签。
    for id in &ids {
        model_tags(
            &library,
            id,
            &[
                (TagNamespace::General, "blue_eyes"),
                (TagNamespace::General, "ahoge"),
                (TagNamespace::General, "long_hair"),
                (TagNamespace::General, "smile"),
            ],
        );
    }
    let before = labels_by_external(&library, &ids[0]);
    // 画师的整理：给 ahoge 起了自己的名字，给 long_hair 加了别名，在第二张图上否决了蓝瞳，
    // 还在第一张图上手动加了标签“微笑”（之后 smile 的译名与它重名）。
    library.rename_tag(&before["ahoge"].id, ZH, "翘毛").unwrap();
    library
        .add_tag_alias(
            &before["long_hair"].id,
            &TagAlias {
                name: "长长的头发".into(),
                lang: Some(ZH.into()),
            },
        )
        .unwrap();
    library
        .edit_tags(
            &ids[1..],
            &[TagEdit::Reject {
                tag: TagRef::Id {
                    id: before["blue_eyes"].id.clone(),
                },
            }],
        )
        .unwrap();
    library
        .edit_tags(
            &ids[..1],
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: "微笑".into(),
                    lang: ZH.into(),
                },
            }],
        )
        .unwrap();
    let revision = library.vocabulary_revision().unwrap();

    // 新版本装上翻译表：尚未翻译的标签做首次初始化。
    library
        .set_translations(TagTranslations::bundled())
        .unwrap();
    assert!(library.vocabulary_revision().unwrap() > revision);

    let after = labels_by_external(&library, &ids[0]);
    assert_eq!(after["blue_eyes"].name, "蓝瞳");
    assert_eq!(after["blue_eyes"].id, before["blue_eyes"].id);
    assert_eq!(after["ahoge"].name, "翘毛", "画师改过的名称不被翻译表覆盖");
    assert_eq!(after["long_hair"].name, "长发");
    // 译名“微笑”已是画师手动标签的名称：跳过，smile 留着尚未翻译，等画师处理。
    assert!(after["smile"].untranslated);
    assert_eq!(found(&library, "微笑").len(), 1);
    let vocabulary = library.vocabulary().unwrap();
    let long_hair = vocabulary
        .tags
        .iter()
        .find(|t| t.id == before["long_hair"].id)
        .unwrap();
    let aliases: Vec<_> = long_hair.aliases.iter().map(|a| a.name.as_str()).collect();
    assert!(aliases.contains(&"长长的头发") && aliases.contains(&"长头发"));
    // 人工标签决定不变：第二张图仍否决蓝瞳。
    let second = library.image_tags(&ids[1], ZH).unwrap();
    assert!(
        second
            .rejected
            .iter()
            .any(|t| t.id == before["blue_eyes"].id)
    );
    assert!(
        !second
            .tags
            .iter()
            .any(|t| t.tag.id == before["blue_eyes"].id)
    );

    // 画师之后改名；重打标与另一版翻译表都不改回去，也不再加别名。
    library
        .rename_tag(&before["blue_eyes"].id, ZH, "蓝眼")
        .unwrap();
    let revised = TagTranslations {
        entries: vec![TagTranslation {
            external: "blue_eyes".into(),
            names: [(ZH.to_owned(), "蓝色瞳孔".to_owned())].into(),
            aliases: vec![TagAlias {
                name: "碧眼".into(),
                lang: Some(ZH.into()),
            }],
        }],
    };
    library.set_translations(revised).unwrap();
    model_tags(&library, &ids[0], &[(TagNamespace::General, "blue_eyes")]);
    let last = labels_by_external(&library, &ids[0]);
    assert_eq!(last["blue_eyes"].name, "蓝眼");
    assert!(found(&library, "碧眼").is_empty());
    assert!(found(&library, "蓝色瞳孔").is_empty());
}

#[test]
fn the_bundled_table_is_versioned_and_every_name_points_to_one_entry() {
    let table = TagTranslations::bundled();
    assert!(TagTranslations::bundled_version() >= 1);
    assert!(table.entries.len() >= 2900, "{} 条", table.entries.len());
    let mut owners: HashMap<&str, &str> = HashMap::new();
    for entry in &table.entries {
        let name = entry.names.get(ZH).expect("每条都有简体中文名称");
        for text in
            std::iter::once(name.as_str()).chain(entry.aliases.iter().map(|a| a.name.as_str()))
        {
            if let Some(other) = owners.insert(text, &entry.external) {
                panic!("{text} 同时属于 {other} 与 {}", entry.external);
            }
        }
    }
    let blue = table
        .entries
        .iter()
        .find(|e| e.external == "blue_eyes")
        .unwrap();
    assert_eq!(blue.names[ZH], "蓝瞳");
}
