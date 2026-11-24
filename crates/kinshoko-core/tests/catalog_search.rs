//! 统一标签目录上的查找组装（#272）：视角不一致时不给候选，目录修订号变化时重建。

use std::sync::Arc;

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::approx::BuiltinApproxTable;
use kinshoko_core::library::{
    Error, ImportOutcome, ImportSource, TagAlias, TagEdit, TagNamespace, TagRef, TagTranslations,
};
use kinshoko_core::search::{CatalogSearch, Search};
use kinshoko_core::tag_catalog::CatalogError;

const ZH: &str = "zh-CN";

struct Fixture {
    dir: tempfile::TempDir,
    library: Arc<Library>,
}

/// 一张图带“共有”；安全模式关着。
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::create(&dir.path().join("lib"), "库").unwrap());
    library.set_safe_mode(false);
    let path = dir.path().join("in.png");
    RgbaImage::from_pixel(4, 4, image::Rgba([1, 2, 3, 255]))
        .save(&path)
        .unwrap();
    let report = library.import(ImportSource { paths: vec![path] }).wait();
    let ImportOutcome::Imported { image_id } = &report.items[0].outcome else {
        panic!("未导入：{:?}", report.items[0].outcome);
    };
    library
        .edit_tags(
            std::slice::from_ref(image_id),
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: "共有".into(),
                    lang: ZH.into(),
                },
            }],
        )
        .unwrap();
    Fixture { dir, library }
}

fn catalog_search(f: &Fixture) -> CatalogSearch {
    CatalogSearch::new(
        f.dir.path().join("device"),
        TagTranslations::bundled(),
        BuiltinApproxTable::bundled(),
    )
}

fn names(search: &Search, text: &str) -> Vec<String> {
    search
        .candidates(text, ZH, 10)
        .into_iter()
        .map(|c| c.tag.name)
        .collect()
}

#[test]
fn an_unchanged_catalog_and_library_reuse_one_search() {
    let f = fixture();
    let search = catalog_search(&f);
    let first = search.search(&f.library, false).unwrap();
    let again = search.search(&f.library, false).unwrap();
    assert!(Arc::ptr_eq(&first, &again));
    assert_eq!(names(&first, "共有"), ["共有"]);
}

#[test]
fn a_view_that_disagrees_with_the_library_gets_lens_changed() {
    let f = fixture();
    let search = catalog_search(&f);
    let result = search.search(&f.library, true);
    assert!(
        matches!(result, Err(CatalogError::Library(Error::LensChanged))),
        "{:?}",
        result.map(drop)
    );
}

#[test]
fn a_catalog_revision_change_rebuilds_the_search() {
    let f = fixture();
    let search = catalog_search(&f);
    let before = search.search(&f.library, false).unwrap();
    assert!(names(&before, "别称").is_empty());
    search
        .with_catalog(|catalog| {
            let inspection = catalog.synchronize(&f.library)?;
            let id = inspection.mappings[0].catalog_id.clone();
            catalog.add_alias(
                &id,
                &TagAlias {
                    name: "别称".into(),
                    lang: Some(ZH.into()),
                },
            )
        })
        .unwrap();
    let after = search.search(&f.library, false).unwrap();
    assert!(
        !Arc::ptr_eq(&before, &after),
        "目录修订号变了却复用了旧查找"
    );
    assert_eq!(names(&after, "别称"), ["共有"]);
}

#[test]
fn invalidating_drops_the_cached_search() {
    let f = fixture();
    let search = catalog_search(&f);
    let before = search.search(&f.library, false).unwrap();
    search.invalidate();
    let after = search.search(&f.library, false).unwrap();
    assert!(!Arc::ptr_eq(&before, &after));
}
