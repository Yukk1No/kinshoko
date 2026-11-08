//! 来源标签里的成人记号：R-18 只体现为成人分级，不作为标签；R-18G 记为成人分级，标签保留。

#[path = "support/eagle.rs"]
#[allow(dead_code)]
mod eagle;

use std::path::Path;

use kinshoko_core::Library;
use kinshoko_core::library::{ContentRating, ImportOutcome, ImportSource};
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

fn shown(library: &Library, image: &str) -> Vec<String> {
    let mut names: Vec<_> = library
        .image_tags(image, ZH)
        .unwrap()
        .tags
        .into_iter()
        .map(|t| t.tag.name)
        .collect();
    names.sort();
    names
}

fn rating(library: &Library, image: &str) -> Option<ContentRating> {
    library.image(image).unwrap().rating.effective
}

#[test]
fn eagle_r18_tags_become_the_adult_rating() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = fixture(dir.path(), &[&["R-18", "原神"], &["r18g"], &["原神"]]);
    let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
    library.set_safe_mode(false);
    let images = import(&library, &fixture);

    assert_eq!(shown(&library, &images[0]), ["原神"]);
    assert_eq!(rating(&library, &images[0]), Some(ContentRating::Explicit));
    assert_eq!(shown(&library, &images[1]), ["r18g"]);
    assert_eq!(rating(&library, &images[1]), Some(ContentRating::Explicit));
    assert_eq!(shown(&library, &images[2]), ["原神"]);
    assert_eq!(rating(&library, &images[2]), None);
    // R-18 这个叫法没有进词表。
    let vocab = library.vocabulary().unwrap();
    assert!(
        vocab
            .tags
            .iter()
            .flat_map(|t| &t.source_names)
            .all(|n| n.name != "R-18")
    );
}

#[test]
fn earlier_libraries_drop_r18_tags_from_eagle_and_pixiv_layers() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = fixture(dir.path(), &[&["占位", "原神"], &["原神"]]);
    let root = dir.path().join("kinshoko");
    let library = Library::create(&root, "参考").unwrap();
    let images = import(&library, &fixture);
    drop(library);
    {
        // 退回上一版：Eagle 条目带着 R-18 标签、没有分级；另一张图的 pixiv 来源层也带 R-18。
        let conn = rusqlite::Connection::open(root.join("library.sqlite")).unwrap();
        let migrations = include_str!("../src/library/store.rs")
            .lines()
            .filter(|line| line.trim_start().starts_with("M::up"))
            .count();
        conn.execute_batch(&format!(
            "UPDATE tag_source_name SET name = 'R-18' WHERE name = '占位';
             DELETE FROM rating_fact;
             INSERT INTO tag_fact (image_id, tag_id, source, score)
                 SELECT '{}', tag_id, 'pixiv:9', NULL FROM tag_source_name WHERE name = 'R-18';
             PRAGMA user_version = {};",
            images[1],
            migrations - 1
        ))
        .unwrap();
    }

    let library = Library::open(&root).unwrap();
    library.set_safe_mode(false);

    assert_eq!(shown(&library, &images[0]), ["原神"]);
    assert_eq!(rating(&library, &images[0]), Some(ContentRating::Explicit));
    assert_eq!(shown(&library, &images[1]), ["原神"]);
    // pixiv 的分级来自作品本身，迁移不另记。
    assert_eq!(rating(&library, &images[1]), None);
}
