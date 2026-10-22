//! 安全模式范围（#223）：安全模式从哪一档内容分级开始作用。
//! 只有一条判定——被封印 = 安全模式开启，且有效分级在安全模式范围内；浏览、查找、分级候选、
//! 词表计数、永久删除拦截、参考视角与钉图遮蔽都按它。用临时目录里的真库，经对外接口。

use std::collections::BTreeSet;
use std::path::Path;

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::approx::BuiltinApproxTable;
use kinshoko_core::desktop::{PinVeils, Placement, SavedPin};
use kinshoko_core::library::{
    BrowseQuery, BrowseScope, ContentRating, Error, FactSource, ImageEdit, ImportOutcome,
    ImportSource, LibraryEvent, RatingFact, ReferenceImage, SafeMode, SafeModeScope, TagEdit,
    TagNamespace, TagRef,
};
use kinshoko_core::reference_groups::{GroupError, GroupUsage, ReferenceGroupUsage};
use kinshoko_core::search::{
    ConditionInput, Search, SearchInput, Term, TermInput, rating_candidates,
};

const ZH: &str = "zh-CN";

/// 没有参考组用到任何图。
struct NoGroups;

impl ReferenceGroupUsage for NoGroups {
    fn groups_using(&self, _: &str, _: &[String]) -> Result<Vec<GroupUsage>, GroupError> {
        Ok(Vec::new())
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    library: Library,
    general: String,
    sensitive: String,
    questionable: String,
    explicit: String,
    unrated: String,
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

impl Fixture {
    /// 四档各一张、还没分级的一张，每张有只属于它的标签；最后打开安全模式（默认范围）。
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::create(&dir.path().join("lib"), "库").unwrap();
        library.set_safe_mode(false);
        let [general, sensitive, questionable, explicit, unrated] =
            <[String; 5]>::try_from(import(&library, dir.path(), 5)).unwrap();
        for (id, rating, name) in [
            (&general, ContentRating::General, "只在全年龄"),
            (&sensitive, ContentRating::Sensitive, "只在轻度"),
            (&questionable, ContentRating::Questionable, "只在敏感"),
            (&explicit, ContentRating::Explicit, "只在成人"),
        ] {
            rate(&library, id, rating);
            tag(&library, id, name);
        }
        tag(&library, &unrated, "只在未分级");
        library.set_safe_mode(true);
        Fixture {
            _dir: dir,
            library,
            general,
            sensitive,
            questionable,
            explicit,
            unrated,
        }
    }

    fn all(&self) -> [&String; 5] {
        [
            &self.general,
            &self.sensitive,
            &self.questionable,
            &self.explicit,
            &self.unrated,
        ]
    }

    fn browse(&self) -> (BTreeSet<String>, u32) {
        let page = self
            .library
            .browse(&BrowseQuery {
                limit: 100,
                ..query(None)
            })
            .unwrap();
        (page.cards.into_iter().map(|c| c.id).collect(), page.total)
    }

    fn visible_tags(&self) -> BTreeSet<String> {
        self.library
            .vocabulary()
            .unwrap()
            .tags
            .into_iter()
            .flat_map(|t| t.names.into_iter().map(|n| n.name))
            .filter(|n| n.starts_with("只在"))
            .collect()
    }
}

fn query(cursor: Option<String>) -> BrowseQuery {
    BrowseQuery {
        scope: BrowseScope::All,
        conditions: Default::default(),
        cursor,
        limit: 1,
        thumbnail_px: 256,
    }
}

fn set<'a>(ids: impl IntoIterator<Item = &'a String>) -> BTreeSet<String> {
    ids.into_iter().cloned().collect()
}

fn names(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|n| (*n).to_owned()).collect()
}

#[test]
fn the_default_scope_starts_at_questionable() {
    assert_eq!(SafeModeScope::default(), SafeModeScope::Questionable);
    let f = Fixture::new();
    assert_eq!(f.library.safe_mode_scope(), SafeModeScope::Questionable);
    let (shown, _) = f.browse();
    assert_eq!(shown, set([&f.general, &f.sensitive, &f.unrated]));
}

/// 每种范围下，浏览、计数、词表、按 id 查看、参考视角都按同一条判定。
#[test]
fn every_surface_follows_the_chosen_scope() {
    let f = Fixture::new();
    let lens = f.library.take_reference_lens().unwrap();
    for (scope, hidden, hidden_tags) in [
        (
            SafeModeScope::Sensitive,
            vec![&f.sensitive, &f.questionable, &f.explicit],
            names(&["只在轻度", "只在敏感", "只在成人"]),
        ),
        (
            SafeModeScope::Questionable,
            vec![&f.questionable, &f.explicit],
            names(&["只在敏感", "只在成人"]),
        ),
        (
            SafeModeScope::Explicit,
            vec![&f.explicit],
            names(&["只在成人"]),
        ),
    ] {
        f.library.set_safe_mode_scope(scope).unwrap();
        let hidden = set(hidden);
        let visible: BTreeSet<String> = set(f.all()).difference(&hidden).cloned().collect();
        let (shown, total) = f.browse();
        assert_eq!(shown, visible, "{scope:?}：浏览");
        assert_eq!(total as usize, visible.len(), "{scope:?}：总数");
        assert_eq!(f.library.sidebar().unwrap().all as usize, visible.len());
        let all_tags = names(&[
            "只在全年龄",
            "只在轻度",
            "只在敏感",
            "只在成人",
            "只在未分级",
        ]);
        let expected: BTreeSet<String> = all_tags.difference(&hidden_tags).cloned().collect();
        assert_eq!(f.visible_tags(), expected, "{scope:?}：词表计数");
        for id in f.all() {
            let sealed = hidden.contains(id);
            assert_eq!(
                matches!(f.library.image(id), Err(Error::UnknownImage)),
                sealed,
                "{scope:?}：按 id 查看"
            );
            assert_eq!(
                lens.image(id).unwrap().sealed,
                sealed,
                "{scope:?}：参考视角"
            );
        }
    }
    // 安全模式关闭时范围不封印任何图。
    f.library.set_safe_mode(false);
    f.library
        .set_safe_mode_scope(SafeModeScope::Sensitive)
        .unwrap();
    assert_eq!(f.browse().0, set(f.all()));
    assert!(!lens.image(&f.sensitive).unwrap().sealed);
}

#[test]
fn browse_cards_mark_what_the_current_scope_would_seal() {
    let f = Fixture::new();
    f.library.set_safe_mode(false);
    f.library
        .set_safe_mode_scope(SafeModeScope::Sensitive)
        .unwrap();
    let mut q = query(None);
    q.limit = 10;
    let adult: BTreeSet<String> = f
        .library
        .browse(&q)
        .unwrap()
        .cards
        .into_iter()
        .filter(|c| c.adult)
        .map(|c| c.id)
        .collect();
    assert_eq!(adult, set([&f.sensitive, &f.questionable, &f.explicit]));
}

/// 改范围和开关安全模式一样处理：修订号前进、旧游标作废，推送列表与词表变化。
#[test]
fn changing_the_scope_expires_cursors_and_announces_the_change() {
    let f = Fixture::new();
    let page = f.library.browse(&query(None)).unwrap();
    let cursor = page.next_cursor.expect("还有下一页");
    let revision = f.library.vocabulary().unwrap().revision;
    let events = f.library.events();

    f.library
        .set_safe_mode_scope(SafeModeScope::Questionable)
        .unwrap();
    assert!(events.try_iter().next().is_none(), "范围没变时什么也不做");

    f.library
        .set_safe_mode_scope(SafeModeScope::Explicit)
        .unwrap();
    let got: Vec<LibraryEvent> = events.try_iter().collect();
    assert!(
        got.iter()
            .any(|e| matches!(e, LibraryEvent::ListStale { .. }))
    );
    let vocabulary = f.library.vocabulary().unwrap();
    assert_ne!(vocabulary.revision, revision);
    assert!(got.iter().any(|e| matches!(
        e,
        LibraryEvent::VocabularyChanged { revision, .. } if *revision == vocabulary.revision
    )));
    assert!(matches!(
        f.library.browse(&query(Some(cursor))),
        Err(Error::CursorExpired)
    ));
}

#[test]
fn a_rating_change_refreshes_the_wall_only_when_it_crosses_the_current_scope() {
    let f = Fixture::new();
    f.library
        .set_safe_mode_scope(SafeModeScope::Explicit)
        .unwrap();
    let events = f.library.events();
    let stale = || {
        events
            .try_iter()
            .filter(|e| matches!(e, LibraryEvent::ListStale { .. }))
            .count()
    };
    rate(&f.library, &f.unrated, ContentRating::Questionable);
    assert_eq!(stale(), 0, "敏感不在“仅成人”范围内");
    rate(&f.library, &f.unrated, ContentRating::Explicit);
    assert_eq!(stale(), 1);

    f.library
        .set_safe_mode_scope(SafeModeScope::Sensitive)
        .unwrap();
    let _ = stale();
    let id = std::slice::from_ref(&f.general);
    f.library
        .edit(
            id,
            &[ImageEdit::SetRating {
                rating: ContentRating::Sensitive,
            }],
        )
        .unwrap();
    let vocabulary = f.library.vocabulary().unwrap();
    assert!(
        !vocabulary
            .tags
            .iter()
            .any(|t| t.names.iter().any(|n| n.name == "只在全年龄")),
        "人工设为轻度：在“轻度及以上”范围内，标签跟着隐藏"
    );
}

#[test]
fn r18_means_the_ratings_in_scope() {
    let r18 = |safe: SafeMode| {
        rating_candidates("R18", safe)
            .into_iter()
            .find(|c| c.rating.name == "R18")
            .map(|c| c.rating.ratings)
    };
    use ContentRating::*;
    let off = |scope| SafeMode::new(false, scope);
    assert_eq!(
        r18(off(SafeModeScope::Sensitive)),
        Some(vec![Sensitive, Questionable, Explicit])
    );
    assert_eq!(
        r18(off(SafeModeScope::Questionable)),
        Some(vec![Questionable, Explicit])
    );
    assert_eq!(r18(off(SafeModeScope::Explicit)), Some(vec![Explicit]));
    // 开着安全模式时 R18 总在范围内，不出现。
    for scope in [
        SafeModeScope::Sensitive,
        SafeModeScope::Questionable,
        SafeModeScope::Explicit,
    ] {
        assert_eq!(r18(SafeMode::new(true, scope)), None);
    }
}

#[test]
fn safe_mode_leaves_out_rating_candidates_in_scope() {
    let shown = |text: &str, scope| {
        rating_candidates(text, SafeMode::new(true, scope))
            .into_iter()
            .map(|c| c.rating.name)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        shown("轻度", SafeModeScope::Sensitive),
        Vec::<String>::new()
    );
    assert_eq!(shown("轻度", SafeModeScope::Questionable), ["轻度"]);
    assert_eq!(shown("敏感", SafeModeScope::Explicit), ["敏感"]);
    assert_eq!(
        shown("explicit", SafeModeScope::Explicit),
        Vec::<String>::new()
    );
}

#[test]
fn search_uses_the_scope_of_its_vocabulary_snapshot() {
    let f = Fixture::new();
    f.library.set_safe_mode(false);
    f.library
        .set_safe_mode_scope(SafeModeScope::Sensitive)
        .unwrap();
    let vocabulary = f.library.vocabulary().unwrap();
    assert_eq!(vocabulary.safe_mode_scope, SafeModeScope::Sensitive);
    let search = Search::new(&vocabulary, &BuiltinApproxTable::bundled());
    let tree = search.resolve(
        &SearchInput {
            conditions: vec![ConditionInput {
                any: vec![TermInput::Text {
                    text: "R18".into(),
                    dismissed: Vec::new(),
                }],
                negate: false,
            }],
            ..Default::default()
        },
        ZH,
    );
    let Term::Text { ratings, .. } = &tree.conditions[0].any[0] else {
        panic!("文字条件");
    };
    let r18 = ratings.iter().find(|r| r.name == "R18").unwrap();
    assert_eq!(
        r18.ratings,
        [
            ContentRating::Sensitive,
            ContentRating::Questionable,
            ContentRating::Explicit
        ]
    );
}

#[test]
fn permanent_delete_previews_expire_when_the_scope_changes() {
    let f = Fixture::new();
    f.library
        .edit(std::slice::from_ref(&f.general), &[ImageEdit::Delete])
        .unwrap();
    let usage = NoGroups;
    let preview = f.library.preview_empty_trash(&usage).unwrap();
    f.library
        .set_safe_mode_scope(SafeModeScope::Sensitive)
        .unwrap();
    assert!(matches!(
        f.library
            .permanent_delete(&preview.image_ids, &preview.token, &usage),
        Err(Error::DeletePreviewStale)
    ));
}

#[test]
fn a_trashed_image_in_scope_cannot_be_permanently_deleted_while_sealed() {
    let f = Fixture::new();
    f.library.set_safe_mode(false);
    f.library
        .edit(std::slice::from_ref(&f.sensitive), &[ImageEdit::Delete])
        .unwrap();
    f.library.set_safe_mode(true);
    let usage = NoGroups;
    let ids = std::slice::from_ref(&f.sensitive);
    assert!(f.library.preview_permanent_delete(ids, &usage).is_ok());
    f.library
        .set_safe_mode_scope(SafeModeScope::Sensitive)
        .unwrap();
    assert!(matches!(
        f.library.preview_permanent_delete(ids, &usage),
        Err(Error::UnknownImage)
    ));
}

fn reference_pin(id: &str) -> SavedPin {
    let image = ReferenceImage {
        id: "img".into(),
        width: 10,
        height: 10,
        sealed: false,
    };
    SavedPin::reference(id, "lib", &image, None, Placement::default()).unwrap()
}

#[test]
fn tightening_the_scope_reveils_pins_and_loosening_keeps_reveals() {
    let mut veils = PinVeils::new(true);
    let pin = reference_pin("p");
    veils.reveal("p");
    assert!(!veils.veiled(&pin, Some(true)));

    assert!(veils.set_scope(SafeModeScope::Explicit), "放宽要重新核对");
    assert!(!veils.veiled(&pin, Some(true)), "放宽保留确认显示");
    assert!(!veils.set_scope(SafeModeScope::Explicit));

    assert!(veils.set_scope(SafeModeScope::Sensitive), "收紧要重新核对");
    assert!(veils.veiled(&pin, Some(true)), "收紧清空确认显示");
}

#[test]
fn the_scope_is_a_device_setting_that_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = kinshoko_core::AppSettings::open(dir.path()).unwrap();
    assert_eq!(settings.safe_mode_scope(), SafeModeScope::Questionable);
    settings
        .set_safe_mode_scope(SafeModeScope::Sensitive)
        .unwrap();
    let settings = kinshoko_core::AppSettings::open(dir.path()).unwrap();
    assert_eq!(settings.safe_mode_scope(), SafeModeScope::Sensitive);
}

#[test]
fn the_scope_travels_with_the_application_settings_backup() {
    use kinshoko_core::application_settings_backup::ApplicationSettingsBackup;
    use kinshoko_core::tag_catalog::TagCatalog;
    let dir = tempfile::tempdir().unwrap();
    let mut settings = kinshoko_core::AppSettings::open(&dir.path().join("source-config")).unwrap();
    settings
        .set_safe_mode_scope(SafeModeScope::Explicit)
        .unwrap();
    let source = TagCatalog::open(&dir.path().join("source")).unwrap();
    let package = dir.path().join("settings.kinshoko-settings");
    ApplicationSettingsBackup::export(&settings, &source, &package).unwrap();

    let mut target = TagCatalog::open(&dir.path().join("target")).unwrap();
    let mut restored = kinshoko_core::AppSettings::open(&dir.path().join("target-config")).unwrap();
    assert_eq!(restored.safe_mode_scope(), SafeModeScope::Questionable);
    ApplicationSettingsBackup::restore(&mut restored, &mut target, &package).unwrap();
    assert_eq!(restored.safe_mode_scope(), SafeModeScope::Explicit);
}

/// 参考组与钉图经 `References` 核对：活动库用自己句柄上的范围，其他库的只读视角用
/// `DetachedLenses` 上设好的本设备范围。
#[test]
fn references_mark_sealed_members_by_the_device_scope() {
    use kinshoko_core::RegisteredLibrary;
    use kinshoko_core::reference_groups::{DetachedLenses, ReferenceSource, References};
    let f = Fixture::new();
    let registry = [RegisteredLibrary {
        id: f.library.info().id.clone(),
        name: f.library.info().name.clone(),
        root: f.library.info().root.clone(),
    }];
    let detached = DetachedLenses::default();
    let refs = |current| References {
        current,
        registry: &registry,
        detached: &detached,
        safe_mode: true,
    };
    let id = f.library.info().id.clone();
    // 只读视角：默认范围不封印轻度，设成“轻度及以上”后封印。
    assert!(!refs(None).image(&id, &f.sensitive).unwrap().sealed);
    detached.set_safe_mode_scope(SafeModeScope::Sensitive);
    assert!(refs(None).image(&id, &f.sensitive).unwrap().sealed);
    // 活动库的参考视角跟随资料库句柄上的范围。
    let lens = f.library.take_reference_lens().unwrap();
    assert!(
        !refs(Some(lens.clone()))
            .image(&id, &f.sensitive)
            .unwrap()
            .sealed
    );
    f.library
        .set_safe_mode_scope(SafeModeScope::Sensitive)
        .unwrap();
    assert!(refs(Some(lens)).image(&id, &f.sensitive).unwrap().sealed);
}
