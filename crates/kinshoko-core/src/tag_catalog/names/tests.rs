//! 一次查齐的 [`resolve_all`] 与逐个 [`resolve`] 等价（#334）：两个资料库共用一个标签、同语言的来源
//! 名称、重复的来源名称、不分语言（`und`）的名称、名称偏好、没有来源名称的映射，以及坏 JSON 时同样报错。

use super::*;
use crate::Library;
use crate::library::{FactSource, ImportSource, SourceTag, TagNamespace, TagRef};
use image::{Rgba, RgbaImage};

fn tagged(dir: &std::path::Path, name: &str, externals: &[&str]) -> Library {
    let library = Library::create(&dir.join(name), name).unwrap();
    let path = dir.join(format!("{name}.png"));
    RgbaImage::from_pixel(4, 3, Rgba([1, 2, 3, 255]))
        .save(&path)
        .unwrap();
    let id = library
        .import(ImportSource { paths: vec![path] })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();
    let tags: Vec<SourceTag> = externals
        .iter()
        .map(|name| SourceTag {
            tag: TagRef::External {
                namespace: TagNamespace::General,
                name: (*name).into(),
            },
            score: None,
        })
        .collect();
    library
        .replace_source_tags(&FactSource::model("test"), &id, &tags)
        .unwrap();
    library
}

fn names(pairs: &[(&str, &str)]) -> String {
    serde_json::to_string(
        &pairs
            .iter()
            .map(|(lang, name)| LocalizedName {
                lang: (*lang).into(),
                name: (*name).into(),
            })
            .collect::<Vec<_>>(),
    )
    .unwrap()
}

/// 映射到 `catalog_id` 的第 `nth` 个映射（按资料库、本地 id 排）写入来源名称。
fn set_sources(catalog: &TagCatalog, external: &str, nth: usize, json: &str) {
    let (library_id, local): (String, String) = catalog
        .conn
        .query_row(
            "SELECT m.library_id,m.local_tag_id FROM library_tag_mapping m
             JOIN catalog_external e ON e.catalog_id=m.catalog_id
             WHERE e.name=?1 ORDER BY m.library_id,m.local_tag_id LIMIT 1 OFFSET ?2",
            rusqlite::params![external, nth as i64],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    catalog
        .conn
        .execute(
            "INSERT OR REPLACE INTO library_tag_source_name (library_id,local_tag_id,names) VALUES (?1,?2,?3)",
            rusqlite::params![library_id, local, json],
        )
        .unwrap();
}

fn catalog_id(catalog: &TagCatalog, external: &str) -> String {
    catalog
        .conn
        .query_row(
            "SELECT catalog_id FROM catalog_external WHERE name=?1",
            [external],
            |row| row.get(0),
        )
        .unwrap()
}

/// 逐个 `resolve` 的结果，按 id 排。
fn one_by_one(catalog: &TagCatalog) -> Result<Vec<CatalogTag>, CatalogError> {
    let mut stmt = catalog
        .conn
        .prepare("SELECT definition FROM catalog_tag ORDER BY id")
        .unwrap();
    let mut tags: Vec<CatalogTag> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|raw| serde_json::from_str(&raw.unwrap()).unwrap())
        .collect();
    for tag in &mut tags {
        resolve(&catalog.conn, tag)?;
    }
    Ok(tags)
}

#[test]
fn resolving_all_tags_at_once_matches_resolving_them_one_by_one() {
    let dir = tempfile::tempdir().unwrap();
    let a = tagged(dir.path(), "a", &["shared", "only_a", "no_sources"]);
    let b = tagged(dir.path(), "b", &["shared", "only_b"]);
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.synchronize(&a).unwrap();
    catalog.synchronize(&b).unwrap();

    // 两个库对同一个标签各有同语言的来源名称，第一个库里还有重复项与不分语言的名称。
    set_sources(
        &catalog,
        "shared",
        0,
        &names(&[("zh", "甲"), ("und", "x"), ("zh", "甲"), ("en", "a")]),
    );
    set_sources(&catalog, "shared", 1, &names(&[("zh", "乙"), ("en", "b")]));
    set_sources(&catalog, "only_a", 0, &names(&[("und", "y"), ("ja", "ア")]));
    set_sources(&catalog, "only_b", 0, &names(&[]));
    catalog
        .conn
        .execute(
            "DELETE FROM library_tag_source_name WHERE local_tag_id IN
             (SELECT local_tag_id FROM library_tag_mapping WHERE catalog_id=?1)",
            [catalog_id(&catalog, "no_sources")],
        )
        .unwrap();
    for (external, lang, name) in [("shared", "zh", "偏好"), ("only_a", "ja", "好み")] {
        catalog
            .conn
            .execute(
                "INSERT INTO catalog_name_preference (catalog_id,lang,name) VALUES (?1,?2,?3)",
                rusqlite::params![catalog_id(&catalog, external), lang, name],
            )
            .unwrap();
    }

    let expected = one_by_one(&catalog).unwrap();
    let shared = expected
        .iter()
        .find(|t| t.id == catalog_id(&catalog, "shared"))
        .unwrap();
    assert!(
        shared.source_names.iter().any(|n| n.name == "乙"),
        "{shared:?}"
    );
    assert!(shared.names.iter().any(|n| n.name == "偏好"), "{shared:?}");
    assert_eq!(catalog.inspect().unwrap().tags, expected);
}

#[test]
fn a_broken_source_name_record_fails_both_ways() {
    let dir = tempfile::tempdir().unwrap();
    let a = tagged(dir.path(), "a", &["shared"]);
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.synchronize(&a).unwrap();
    set_sources(&catalog, "shared", 0, "not json");

    assert!(one_by_one(&catalog).is_err());
    assert!(catalog.inspect().is_err());
}
