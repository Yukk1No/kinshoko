//! 安全模式（#60）：Library 内部的浏览视角与参考视角。
//! 用临时目录里的真库，经 `Library` 的对外接口；分级按模型来源写入（与打标子进程写入的方式相同）。

use std::collections::BTreeSet;
use std::path::Path;

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::approx::{ApproxRelation, BuiltinApproxTable};
use kinshoko_core::library::{
    BrowseQuery, BrowseScope, ContentRating, Error, FactSource, ImageEdit, ImportOutcome,
    ImportSource, LibraryEvent, RatingFact, TagEdit, TagNamespace, TagRef,
};
use kinshoko_core::search::{ConditionInput, Search, SearchInput, TermInput};

const ZH: &str = "zh-CN";

/// 测试库里的图，按内容分级区分。
struct Fixture {
    _dir: tempfile::TempDir,
    library: Library,
    general: String,
    sensitive: String,
    questionable: String,
    explicit: String,
    unrated: String,
    /// 在回收站里的露骨图与全年龄图。
    trashed_explicit: String,
    trashed_general: String,
    folder: String,
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

fn named(name: &str) -> TagRef {
    TagRef::Named {
        namespace: TagNamespace::General,
        name: name.into(),
        lang: ZH.into(),
    }
}

fn tag(library: &Library, ids: &[&String], name: &str) {
    let ids: Vec<String> = ids.iter().map(|s| (*s).clone()).collect();
    library
        .edit_tags(&ids, &[TagEdit::Add { tag: named(name) }])
        .unwrap();
}

impl Fixture {
    /// 安全模式关着时整理好全部图，最后打开安全模式。
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::create(&dir.path().join("lib"), "库").unwrap();
        library.set_safe_mode(false);
        let ids = import(&library, dir.path(), 7);
        let [
            general,
            sensitive,
            questionable,
            explicit,
            unrated,
            trashed_explicit,
            trashed_general,
        ] = <[String; 7]>::try_from(ids).unwrap();
        rate(&library, &general, ContentRating::General);
        rate(&library, &sensitive, ContentRating::Sensitive);
        rate(&library, &questionable, ContentRating::Questionable);
        rate(&library, &explicit, ContentRating::Explicit);
        rate(&library, &trashed_explicit, ContentRating::Explicit);
        rate(&library, &trashed_general, ContentRating::General);
        tag(&library, &[&general, &explicit], "共有");
        tag(
            &library,
            &[&questionable, &explicit, &trashed_explicit],
            "只在成人图上",
        );
        let folder = library.create_folder("参考", None).unwrap();
        library
            .edit(
                &[general.clone(), explicit.clone()],
                &[ImageEdit::AddToFolder {
                    folder_id: folder.clone(),
                }],
            )
            .unwrap();
        library
            .edit(
                &[trashed_explicit.clone(), trashed_general.clone()],
                &[ImageEdit::Delete],
            )
            .unwrap();
        library.set_safe_mode(true);
        Fixture {
            _dir: dir,
            library,
            general,
            sensitive,
            questionable,
            explicit,
            unrated,
            trashed_explicit,
            trashed_general,
            folder,
        }
    }

    fn sealed(&self) -> [&String; 3] {
        [&self.questionable, &self.explicit, &self.trashed_explicit]
    }

    fn browse(&self, scope: BrowseScope) -> (BTreeSet<String>, u32) {
        let page = self
            .library
            .browse(&BrowseQuery {
                scope,
                conditions: Default::default(),
                cursor: None,
                limit: 100,
                thumbnail_px: 256,
            })
            .unwrap();
        (page.cards.into_iter().map(|c| c.id).collect(), page.total)
    }
}

fn set(ids: &[&String]) -> BTreeSet<String> {
    ids.iter().map(|s| (*s).clone()).collect()
}

#[test]
fn a_new_library_starts_in_safe_mode() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    assert!(library.safe_mode());
    drop(library);
    assert!(Library::open(&dir.path().join("lib")).unwrap().safe_mode());
}

#[test]
fn the_wall_and_its_total_leave_out_sealed_images_in_every_scope() {
    let f = Fixture::new();
    let (all, total) = f.browse(BrowseScope::All);
    assert_eq!(all, set(&[&f.general, &f.sensitive, &f.unrated]));
    assert_eq!(total, 3);

    let (folder, total) = f.browse(BrowseScope::Folder {
        id: f.folder.clone(),
    });
    assert_eq!(folder, set(&[&f.general]));
    assert_eq!(total, 1);

    let (trash, total) = f.browse(BrowseScope::Trash);
    assert_eq!(trash, set(&[&f.trashed_general]));
    assert_eq!(total, 1);
}

#[test]
fn sidebar_counts_do_not_reveal_sealed_images() {
    let f = Fixture::new();
    let sidebar = f.library.sidebar().unwrap();
    assert_eq!(sidebar.all, 3);
    assert_eq!(sidebar.trash, 1);
    assert_eq!(sidebar.folders[0].count, 1);
}

#[test]
fn tag_counts_candidates_and_groups_do_not_reveal_sealed_images() {
    let f = Fixture::new();
    let vocabulary = f.library.vocabulary().unwrap();
    let shared = vocabulary
        .tags
        .iter()
        .find(|t| t.names.iter().any(|n| n.name == "共有"))
        .unwrap();
    assert_eq!(shared.count, 1);
    // 只出现在被封印的图上的标签，像不存在一样。
    assert!(
        !vocabulary
            .tags
            .iter()
            .any(|t| t.names.iter().any(|n| n.name == "只在成人图上"))
    );
    let search = Search::new(&vocabulary, &BuiltinApproxTable::bundled());
    assert!(search.candidates("只在", ZH, 10).is_empty());

    f.library
        .create_tag_group("一般", Some(TagNamespace::General))
        .unwrap();
    let groups = f.library.tag_groups(ZH).unwrap();
    let names: Vec<(&str, u32)> = groups[0]
        .tags
        .iter()
        .map(|t| (t.tag.name.as_str(), t.count))
        .collect();
    assert_eq!(names, [("共有", 1)]);
}

#[test]
fn the_personal_approx_table_does_not_name_tags_only_on_sealed_images() {
    let f = Fixture::new();
    f.library.set_safe_mode(false);
    let vocabulary = f.library.vocabulary().unwrap();
    let id = |name: &str| {
        vocabulary
            .tags
            .iter()
            .find(|t| t.names.iter().any(|n| n.name == name))
            .unwrap()
            .id
            .clone()
    };
    f.library
        .set_tag_approx(&id("共有"), &id("只在成人图上"), ApproxRelation::Similar)
        .unwrap();
    assert_eq!(f.library.personal_approx(ZH).unwrap().len(), 1);

    f.library.set_safe_mode(true);
    assert!(f.library.personal_approx(ZH).unwrap().is_empty());
    assert!(f.library.vocabulary().unwrap().personal_approx.is_empty());
}

#[test]
fn searching_never_finds_sealed_images() {
    let f = Fixture::new();
    let vocabulary = f.library.vocabulary().unwrap();
    let tree = Search::new(&vocabulary, &BuiltinApproxTable::bundled()).resolve(
        &SearchInput {
            conditions: vec![ConditionInput {
                any: vec![TermInput::Text {
                    text: "共有".into(),
                    dismissed: Vec::new(),
                }],
                negate: false,
            }],
            exact: false,
        },
        ZH,
    );
    let page = f
        .library
        .browse(&BrowseQuery {
            scope: BrowseScope::All,
            conditions: tree,
            cursor: None,
            limit: 100,
            thumbnail_px: 256,
        })
        .unwrap();
    let found: Vec<_> = page.cards.iter().map(|c| c.id.clone()).collect();
    assert_eq!(found, std::slice::from_ref(&f.general));
    assert_eq!(page.total, 1);
}

#[test]
fn a_sealed_image_does_not_exist_when_looked_up_or_edited() {
    let f = Fixture::new();
    let lib = &f.library;
    let unknown = |r: Result<(), Error>| {
        assert!(matches!(r, Err(Error::UnknownImage)), "{r:?}");
    };
    for id in f.sealed() {
        unknown(lib.image(id).map(drop));
        unknown(lib.image_tags(id, ZH).map(drop));
        unknown(lib.image_rating(id).map(drop));
        unknown(lib.image_sources(id).map(drop));
        unknown(lib.thumbnail(id, 256).map(drop));
        unknown(lib.original_path(id).map(drop));
        unknown(lib.display(id).map(drop));
        unknown(lib.display_scaled(id, 64).map(drop));
        // 色彩描述也是按 id 的浏览读取，不能看出被封印的图存在（#76）。
        unknown(lib.colour(id).map(drop));
        unknown(
            lib.edit(std::slice::from_ref(id), &[ImageEdit::Restore])
                .map(drop),
        );
        unknown(lib.edit_tags(
            std::slice::from_ref(id),
            &[TagEdit::Add { tag: named("x") }],
        ));
    }
    // 没被封印的图照常可见。
    for id in [&f.general, &f.sensitive, &f.unrated, &f.trashed_general] {
        lib.image(id).unwrap();
        lib.thumbnail(id, 256).unwrap();
    }
}

#[test]
fn turning_safe_mode_off_restores_everything() {
    let f = Fixture::new();
    let events = f.library.events();
    f.library.set_safe_mode(false);
    let (all, total) = f.browse(BrowseScope::All);
    assert_eq!(
        all,
        set(&[
            &f.general,
            &f.sensitive,
            &f.questionable,
            &f.explicit,
            &f.unrated
        ])
    );
    assert_eq!(total, 5);
    assert_eq!(f.library.sidebar().unwrap().trash, 2);
    let vocabulary = f.library.vocabulary().unwrap();
    let hidden = vocabulary
        .tags
        .iter()
        .find(|t| t.names.iter().any(|n| n.name == "只在成人图上"))
        .unwrap();
    assert_eq!(hidden.count, 2);
    f.library.image(&f.explicit).unwrap();
    assert_eq!(
        events.try_recv().unwrap(),
        LibraryEvent::SafeModeChanged {
            library_id: f.library.info().id.clone(),
            on: false,
        }
    );
    // 状态没变就不推送。
    f.library.set_safe_mode(false);
    assert!(events.try_recv().is_err());
}

#[test]
fn cards_say_which_images_safe_mode_would_seal() {
    let f = Fixture::new();
    f.library.set_safe_mode(false);
    let page = f
        .library
        .browse(&BrowseQuery {
            scope: BrowseScope::All,
            conditions: Default::default(),
            cursor: None,
            limit: 100,
            thumbnail_px: 256,
        })
        .unwrap();
    let adult: BTreeSet<String> = page
        .cards
        .iter()
        .filter(|c| c.adult)
        .map(|c| c.id.clone())
        .collect();
    assert_eq!(adult, set(&[&f.questionable, &f.explicit]));
}

#[test]
fn an_image_rated_adult_while_safe_mode_is_on_disappears() {
    let f = Fixture::new();
    rate(&f.library, &f.unrated, ContentRating::Explicit);
    let (all, _) = f.browse(BrowseScope::All);
    assert_eq!(all, set(&[&f.general, &f.sensitive]));
    assert!(f.library.image(&f.unrated).is_err());
}

#[test]
fn the_wall_is_told_to_refresh_only_when_a_rating_change_seals_or_releases_an_image() {
    let f = Fixture::new();
    let events = f.library.events();
    let stale = || {
        events
            .try_iter()
            .filter(|e| matches!(e, LibraryEvent::ListStale { .. }))
            .count()
    };
    rate(&f.library, &f.unrated, ContentRating::Sensitive);
    assert_eq!(stale(), 0);
    rate(&f.library, &f.unrated, ContentRating::Questionable);
    assert_eq!(stale(), 1);
    rate(&f.library, &f.unrated, ContentRating::Explicit);
    assert_eq!(stale(), 0);
    rate(&f.library, &f.unrated, ContentRating::General);
    assert_eq!(stale(), 1);
}

#[test]
fn the_reference_lens_is_handed_out_once_and_marks_sealed_images() {
    let f = Fixture::new();
    let lens = f.library.take_reference_lens().expect("装配时取得");
    assert!(f.library.take_reference_lens().is_none());

    assert!(lens.image(&f.explicit).unwrap().sealed);
    lens.thumbnail(&f.explicit, 256).unwrap();
    assert!(lens.original_path(&f.explicit).unwrap().is_file());
    assert!(lens.image(&f.trashed_explicit).unwrap().sealed);
    assert!(!lens.image(&f.general).unwrap().sealed);
    assert!(!lens.image(&f.unrated).unwrap().sealed);

    // 克隆给另一个装配时指定的模块；安全模式关掉后不再需要遮蔽。
    let pins = lens.clone();
    f.library.set_safe_mode(false);
    assert!(!pins.image(&f.explicit).unwrap().sealed);
}

#[test]
fn the_tagger_still_reaches_sealed_images() {
    let f = Fixture::new();
    assert!(f.library.original_to_tag(&f.explicit).unwrap().is_file());
}

#[test]
fn the_effective_rating_decides_what_is_sealed() {
    let f = Fixture::new();
    f.library.set_safe_mode(false);
    for (id, adult) in [
        (&f.general, false),
        (&f.sensitive, false),
        (&f.questionable, true),
        (&f.explicit, true),
    ] {
        let rating = f.library.image_rating(id).unwrap();
        assert_eq!(rating.effective.is_some_and(ContentRating::is_adult), adult);
    }
    assert_eq!(f.library.image_rating(&f.unrated).unwrap().effective, None);
}

/// 分级跨过“含成人内容”时，安全模式下可见的词表变了：修订号必须前进并在提交后推送
/// `VocabularyChanged`，否则按修订号与安全模式缓存的 Search 会继续给出旧候选（#76 S2）。
/// 人工设置/退回分级与模型来源分级替换都一样，移出与重新进入可见集合都覆盖。
#[test]
fn a_rating_that_seals_or_releases_an_image_advances_the_vocabulary_revision() {
    let f = Fixture::new();
    tag(&f.library, &[&f.unrated], "只在这张图上");
    let events = f.library.events();
    let mut revision = f.library.vocabulary().unwrap().revision;
    let mut step = |what: &str, visible: bool| {
        let vocabulary = f.library.vocabulary().unwrap();
        let shown = vocabulary
            .tags
            .iter()
            .any(|t| t.names.iter().any(|n| n.name == "只在这张图上"));
        assert_eq!(shown, visible, "{what}：标签是否可见");
        assert_ne!(
            vocabulary.revision, revision,
            "{what}：可见词表变了，修订号却没变"
        );
        let announced: Vec<i64> = events
            .try_iter()
            .filter_map(|e| match e {
                LibraryEvent::VocabularyChanged { revision, .. } => Some(revision),
                _ => None,
            })
            .collect();
        assert_eq!(
            announced,
            [vocabulary.revision],
            "{what}：提交后推送新修订号"
        );
        revision = vocabulary.revision;
    };
    let id = std::slice::from_ref(&f.unrated);
    f.library
        .edit(
            id,
            &[ImageEdit::SetRating {
                rating: ContentRating::Explicit,
            }],
        )
        .unwrap();
    step("人工设为露骨", false);
    f.library.set_safe_mode(false);
    f.library.edit(id, &[ImageEdit::RevertRating]).unwrap();
    f.library.set_safe_mode(true);
    step("退回人工分级", true);
    rate(&f.library, &f.unrated, ContentRating::Questionable);
    step("模型分级为成人内容", false);
    rate(&f.library, &f.unrated, ContentRating::General);
    step("模型分级为全年龄", true);
}
