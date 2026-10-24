//! 活动资料库的 Search 缓存（#76 S1）：按资料库身份、词表修订号与安全模式校验，构建期间
//! 发生失效时旧构建不写回。构建经 `search_with` 的闭包注入，测试在“读完词表、还没写回”
//! 这一刻改动资料库或清缓存，确定地重现命令层的交错，不靠并发循环碰运气。

use std::path::Path;
use std::sync::Arc;

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::approx::BuiltinApproxTable;
use kinshoko_core::library::{
    ContentRating, Error, FactSource, ImportOutcome, ImportSource, RatingFact, TagEdit,
    TagNamespace, TagRef,
};
use kinshoko_core::search::{Search, SearchCache};

const ZH: &str = "zh-CN";

struct Fixture {
    _dir: tempfile::TempDir,
    library: Arc<Library>,
    general: String,
}

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

fn tag(library: &Library, id: &str, name: &str) {
    library
        .edit_tags(
            &[id.to_owned()],
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

/// 一张全年龄图带“共有”，一张露骨图带“只在成人图上”；安全模式关着。
fn fixture(name: &str) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::create(&dir.path().join("lib"), name).unwrap());
    library.set_safe_mode(false);
    let [general, explicit] = <[String; 2]>::try_from(import(&library, dir.path(), 2)).unwrap();
    library
        .replace_source_rating(
            &FactSource::model("test"),
            &explicit,
            Some(RatingFact {
                rating: ContentRating::Explicit,
                score: Some(0.9),
            }),
        )
        .unwrap();
    tag(&library, &general, "共有");
    tag(&library, &explicit, "只在成人图上");
    Fixture {
        _dir: dir,
        library,
        general,
    }
}

fn names(search: &Search, text: &str) -> Vec<String> {
    search
        .candidates(text, ZH, 10)
        .into_iter()
        .map(|c| c.tag.name)
        .collect()
}

#[test]
fn an_unchanged_library_reuses_one_search() {
    let f = fixture("库");
    let (cache, builtin) = (SearchCache::default(), BuiltinApproxTable::bundled());
    let first = cache.search(&f.library, &builtin, false).unwrap();
    let again = cache.search(&f.library, &builtin, false).unwrap();
    assert!(Arc::ptr_eq(&first, &again));
}

#[test]
fn a_build_that_saw_safe_mode_turn_on_is_neither_answered_nor_written_back() {
    let f = fixture("库");
    let (cache, builtin) = (SearchCache::default(), BuiltinApproxTable::bundled());
    // 读完关着安全模式的词表后，安全模式开启，事件转发清掉了缓存。
    let stale = cache.search_with(&f.library, false, |vocabulary| {
        f.library.set_safe_mode(true);
        cache.invalidate();
        Search::new(vocabulary, &builtin)
    });
    assert!(
        matches!(stale, Err(Error::LensChanged)),
        "{:?}",
        stale.map(drop)
    );
    let fresh = cache.search(&f.library, &builtin, true).unwrap();
    assert!(names(&fresh, "只在").is_empty());
    assert_eq!(names(&fresh, "共有"), ["共有"]);
}

#[test]
fn a_build_that_lost_a_race_with_an_invalidation_is_not_written_back() {
    let f = fixture("库");
    let (cache, builtin) = (SearchCache::default(), BuiltinApproxTable::bundled());
    let raced = cache
        .search_with(&f.library, false, |vocabulary| {
            cache.invalidate();
            Search::new(vocabulary, &builtin)
        })
        .unwrap();
    let next = cache.search(&f.library, &builtin, false).unwrap();
    assert!(!Arc::ptr_eq(&raced, &next), "失效之后写回了旧构建");
}

#[test]
fn a_vocabulary_change_during_the_build_is_seen_by_the_next_lookup() {
    let f = fixture("库");
    let (cache, builtin) = (SearchCache::default(), BuiltinApproxTable::bundled());
    // 事件转发还没来得及清缓存：只靠修订号校验也不能继续用旧快照。
    cache
        .search_with(&f.library, false, |vocabulary| {
            tag(&f.library, &f.general, "新标签");
            Search::new(vocabulary, &builtin)
        })
        .unwrap();
    let next = cache.search(&f.library, &builtin, false).unwrap();
    assert_eq!(names(&next, "新标签"), ["新标签"]);
}

#[test]
fn a_safe_mode_change_without_an_invalidation_still_misses_the_cache() {
    let f = fixture("库");
    let (cache, builtin) = (SearchCache::default(), BuiltinApproxTable::bundled());
    let released = cache.search(&f.library, &builtin, false).unwrap();
    assert_eq!(names(&released, "只在"), ["只在成人图上"]);
    f.library.set_safe_mode(true);
    let sealed = cache.search(&f.library, &builtin, true).unwrap();
    assert!(names(&sealed, "只在").is_empty());
}

#[test]
fn a_lookup_for_another_lens_than_the_library_has_is_refused() {
    let f = fixture("库");
    let (cache, builtin) = (SearchCache::default(), BuiltinApproxTable::bundled());
    f.library.set_safe_mode(true);
    let refused = cache.search(&f.library, &builtin, false);
    assert!(
        matches!(refused, Err(Error::LensChanged)),
        "{:?}",
        refused.map(drop)
    );
}

#[test]
fn a_stale_build_of_the_previous_library_is_not_used_for_the_next_one() {
    let (a, b) = (fixture("甲"), fixture("乙"));
    tag(&b.library, &b.general, "乙库标签");
    let (cache, builtin) = (SearchCache::default(), BuiltinApproxTable::bundled());
    // 甲库的构建还没写回时切换到了乙库（装配时清缓存）。
    cache
        .search_with(&a.library, false, |vocabulary| {
            cache.invalidate();
            Search::new(vocabulary, &builtin)
        })
        .unwrap();
    let next = cache.search(&b.library, &builtin, false).unwrap();
    assert_eq!(names(&next, "乙库"), ["乙库标签"]);
    // 不跨资料库复用：两个库交替查找各得各的。
    cache.search(&a.library, &builtin, false).unwrap();
    let back = cache.search(&b.library, &builtin, false).unwrap();
    assert_eq!(names(&back, "乙库"), ["乙库标签"]);
}
