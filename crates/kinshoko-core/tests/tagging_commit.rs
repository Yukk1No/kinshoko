//! 提交打标结果（#318）：一次成功推理的模型标签、分级建议与完成状态作为一份结果整体提交。
//! 任何一步失败（报错或进程中途结束）都整体回滚，不推送事件、不记完成；人工决定与其他来源不受影响。

use std::path::Path;

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::library::{
    ContentRating, FactSource, FailedTagging, ImageEdit, ImportOutcome, ImportSource, LibraryEvent,
    RatingFact, RetryTagging, SourceTag, TagEdit, TagNamespace, TagOrigin, TagRef, TaggingFailure,
    TaggingOutcome, TaggingResult,
};

const ZH: &str = "zh-CN";

fn model() -> FactSource {
    FactSource::model("test-tagger")
}

fn external(name: &str) -> TagRef {
    TagRef::External {
        namespace: TagNamespace::General,
        name: name.into(),
    }
}

fn result() -> TaggingResult {
    TaggingResult {
        tags: ["blue_eyes", "long_hair"]
            .into_iter()
            .map(|name| SourceTag {
                tag: external(name),
                score: Some(0.9),
            })
            .collect(),
        rating: Some(RatingFact {
            rating: ContentRating::Explicit,
            score: Some(0.7),
        }),
    }
}

fn library_with_image(root: &Path) -> (Library, String) {
    let library = Library::create(root, "库").unwrap();
    let path = root.with_extension("png");
    RgbaImage::from_fn(4, 4, |x, y| image::Rgba([1, x as u8, y as u8, 255]))
        .save(&path)
        .unwrap();
    let id = match library
        .import(ImportSource { paths: vec![path] })
        .wait()
        .items
        .remove(0)
        .outcome
    {
        ImportOutcome::Imported { image_id } => image_id,
        other => panic!("未导入：{other:?}"),
    };
    (library, id)
}

/// 画师已有的决定与其他来源的事实：否决了模型会给的 blue_eyes、人工分级为全年龄、导入带来“风景”。
fn with_decisions_and_other_sources(library: &Library, id: &str) {
    library.set_safe_mode(false);
    let ids = [id.to_owned()];
    library
        .edit_tags(
            &ids,
            &[TagEdit::Reject {
                tag: external("blue_eyes"),
            }],
        )
        .unwrap();
    library
        .edit(
            &ids,
            &[ImageEdit::SetRating {
                rating: ContentRating::General,
            }],
        )
        .unwrap();
    library
        .replace_source_tags(
            &FactSource::file(),
            id,
            &[SourceTag {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: "风景".into(),
                    lang: ZH.into(),
                },
                score: None,
            }],
        )
        .unwrap();
}

/// 有效标签的出处（来源名或人工），排好序。
fn origins(library: &Library, id: &str) -> Vec<String> {
    let mut out: Vec<String> = library
        .image_tags(id, ZH)
        .unwrap()
        .tags
        .into_iter()
        .flat_map(|t| t.origins)
        .map(|o| match o {
            TagOrigin::Source { source, .. } => source,
            other => format!("{other:?}"),
        })
        .collect();
    out.sort();
    out
}

/// 断言模型的这一层完全不在：没有模型标签、没有分级建议、仍是待打标的图；人工决定与导入来源照旧。
fn assert_untouched(library: &Library, id: &str) {
    library.set_safe_mode(false);
    assert_eq!(origins(library, id), vec!["file".to_owned()]);
    assert_eq!(library.image_tags(id, ZH).unwrap().rejected.len(), 1);
    let rating = library.image_rating(id).unwrap();
    assert_eq!(rating.suggested, None);
    assert_eq!(rating.manual, Some(ContentRating::General));
    assert_eq!(
        library.images_to_tag(&model(), 10).unwrap(),
        vec![id.to_owned()],
        "没有留下完成状态"
    );
}

/// 断言整份结果都在：模型标签（被否决的除外）、分级建议与完成状态；人工决定与导入来源照旧。
fn assert_committed(library: &Library, id: &str) {
    library.set_safe_mode(false);
    assert_eq!(
        origins(library, id),
        vec!["file".to_owned(), "model:test-tagger".to_owned()],
        "被否决的 blue_eyes 不出现，long_hair 出现"
    );
    assert_eq!(library.image_tags(id, ZH).unwrap().rejected.len(), 1);
    let rating = library.image_rating(id).unwrap();
    assert_eq!(rating.suggested, Some(ContentRating::Explicit));
    assert_eq!(rating.manual, Some(ContentRating::General), "人工分级优先");
    assert_eq!(rating.effective, Some(ContentRating::General));
    assert!(library.images_to_tag(&model(), 10).unwrap().is_empty());
}

#[test]
fn a_tagging_result_is_committed_whole_and_published_after_commit() {
    let dir = tempfile::tempdir().unwrap();
    let (library, id) = library_with_image(&dir.path().join("lib"));
    library.set_safe_mode(true);
    let events = library.events();

    library
        .commit_tagging_result(&model(), &id, &result())
        .unwrap();

    let events: Vec<_> = events.try_iter().collect();
    assert!(
        events.iter().any(|e| matches!(
            e,
            LibraryEvent::ImagesChanged { image_ids, .. } if image_ids == std::slice::from_ref(&id)
        )),
        "{events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, LibraryEvent::VocabularyChanged { .. }))
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, LibraryEvent::ListStale { .. })),
        "露骨的建议让这张图在安全模式下被封印"
    );
    library.set_safe_mode(false);
    assert_eq!(
        origins(&library, &id),
        vec!["model:test-tagger".to_owned(); 2]
    );
    assert_eq!(
        library.image_rating(&id).unwrap().effective,
        Some(ContentRating::Explicit)
    );
    assert!(library.images_to_tag(&model(), 10).unwrap().is_empty());
}

#[test]
fn committing_keeps_manual_decisions_manual_rating_and_other_sources() {
    let dir = tempfile::tempdir().unwrap();
    let (library, id) = library_with_image(&dir.path().join("lib"));
    with_decisions_and_other_sources(&library, &id);

    library
        .commit_tagging_result(&model(), &id, &result())
        .unwrap();
    assert_committed(&library, &id);

    // 重打只替换模型自己的那一层。
    library
        .commit_tagging_result(&model(), &id, &TaggingResult::default())
        .unwrap();
    assert_eq!(origins(&library, &id), vec!["file".to_owned()]);
    assert_eq!(library.image_rating(&id).unwrap().suggested, None);
    assert!(library.images_to_tag(&model(), 10).unwrap().is_empty());
}

const COMMIT_CHILD: &str = "child_commits_until_tagging_fault";
const DIR_ENV: &str = "KINSHOKO_TEST_TAGGING_COMMIT_DIR";
const ID_ENV: &str = "KINSHOKO_TEST_TAGGING_COMMIT_ID";

#[test]
#[ignore = "executed by the fault parent with a real persistent library"]
fn child_commits_until_tagging_fault() {
    let root = std::path::PathBuf::from(std::env::var_os(DIR_ENV).unwrap());
    let id = std::env::var(ID_ENV).unwrap();
    let library = Library::open(&root).unwrap();
    // 安全模式开着：这份结果让图跨进封印范围，回滚也要撤回列表修订号。
    library.set_safe_mode(true);
    let events = library.events();
    let committed = library.commit_tagging_result(&model(), &id, &result());
    assert!(committed.is_err(), "注入的失败要报给调用方");
    let events: Vec<_> = events.try_iter().collect();
    assert!(events.is_empty(), "回滚后不推送事件：{events:?}");
}

#[test]
fn a_failure_at_any_step_rolls_back_the_whole_result() {
    for point in [
        "tagging_commit_after_tags",
        "tagging_commit_after_rating",
        "tagging_commit_after_state",
    ] {
        for action in ["crash", "error"] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("lib");
            let (library, id) = library_with_image(&root);
            with_decisions_and_other_sources(&library, &id);
            drop(library);

            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([COMMIT_CHILD, "--exact", "--ignored", "--nocapture"])
                .env(DIR_ENV, &root)
                .env(ID_ENV, &id)
                .env("KINSHOKO_FAULT", point)
                .env("KINSHOKO_FAULT_ACTION", action)
                .status()
                .unwrap();
            assert_eq!(
                status.code(),
                Some(if action == "error" { 0 } else { 99 }),
                "{point} {action}"
            );

            let library = Library::open(&root).unwrap();
            assert_untouched(&library, &id);
            // 回滚后重打一次，整份结果连同完成状态一起提交。
            library
                .commit_tagging_result(&model(), &id, &result())
                .unwrap();
            assert_committed(&library, &id);
        }
    }
}

// 打不上标的图（#475）：数得出来，不再算待打标；崩溃导致的可以单独重试，手动重试两类都清掉。
#[test]
fn failed_images_are_counted_and_can_be_retried() {
    let dir = tempfile::tempdir().unwrap();
    let (library, bad) = library_with_image(&dir.path().join("lib"));
    let crashed = import_more(&library, dir.path(), 2);
    library
        .finish_tagging(&model(), &bad, TaggingOutcome::BadImage("无法解码".into()))
        .unwrap();
    library
        .finish_tagging(&model(), &crashed, TaggingOutcome::Crashed("崩溃".into()))
        .unwrap();
    assert_eq!(
        library.count_failed_tagging(&model()).unwrap(),
        failed(1, 1)
    );
    assert_eq!(library.count_images_to_tag(&model()).unwrap(), 0);
    // 别的模型来源不受影响。
    assert_eq!(
        library
            .count_failed_tagging(&FactSource::model("other"))
            .unwrap(),
        failed(0, 0)
    );

    assert_eq!(
        library
            .retry_failed_tagging(&model(), RetryTagging::CrashedOnly)
            .unwrap(),
        1
    );
    assert_eq!(
        library.images_to_tag(&model(), 10).unwrap(),
        vec![crashed.clone()]
    );
    assert_eq!(
        library.count_failed_tagging(&model()).unwrap(),
        failed(1, 0)
    );

    assert_eq!(
        library
            .retry_failed_tagging(&model(), RetryTagging::AllFailed)
            .unwrap(),
        1
    );
    assert_eq!(
        library.count_failed_tagging(&model()).unwrap(),
        failed(0, 0)
    );
    assert_eq!(library.count_images_to_tag(&model()).unwrap(), 2);
}

#[test]
fn failed_images_in_the_trash_are_not_counted() {
    let dir = tempfile::tempdir().unwrap();
    let (library, id) = library_with_image(&dir.path().join("lib"));
    library
        .finish_tagging(&model(), &id, TaggingOutcome::BadImage("无法解码".into()))
        .unwrap();
    library
        .edit(std::slice::from_ref(&id), &[ImageEdit::Delete])
        .unwrap();
    assert_eq!(
        library.count_failed_tagging(&model()).unwrap(),
        failed(0, 0)
    );
}

// 升级前记下的失败只有原因文字：按反复崩溃的原因前缀分出两类，崩溃的才在启动时重试。
#[test]
fn failures_recorded_before_the_upgrade_are_sorted_by_their_reason() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    let (library, bad) = library_with_image(&root);
    let crashed = import_more(&library, dir.path(), 2);
    library
        .finish_tagging(&model(), &bad, TaggingOutcome::BadImage("无法解码".into()))
        .unwrap();
    library
        .finish_tagging(&model(), &crashed, TaggingOutcome::Crashed("崩溃".into()))
        .unwrap();
    drop(library);
    {
        let conn = rusqlite::Connection::open(root.join("library.sqlite")).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        conn.execute_batch(&format!(
            "UPDATE tagging_state SET reason = '打标子进程在这张图上反复出错：会话结束'
               WHERE image_id = '{crashed}';
             ALTER TABLE tagging_state DROP COLUMN failure;
             PRAGMA user_version = {};",
            version - 1
        ))
        .unwrap();
    }

    let library = Library::open(&root).unwrap();
    assert_eq!(
        library.count_failed_tagging(&model()).unwrap(),
        failed(1, 1)
    );
    library
        .retry_failed_tagging(&model(), RetryTagging::CrashedOnly)
        .unwrap();
    assert_eq!(library.images_to_tag(&model(), 10).unwrap(), vec![crashed]);
}

// 详情里看得到单张图属于哪类失败；重试只清掉这张的失败记录，之后照常待打标。
#[test]
fn an_image_shows_why_it_was_not_tagged_and_can_be_retried_alone() {
    let dir = tempfile::tempdir().unwrap();
    let (library, bad) = library_with_image(&dir.path().join("lib"));
    let crashed = import_more(&library, dir.path(), 2);
    let done = import_more(&library, dir.path(), 3);
    library
        .finish_tagging(&model(), &bad, TaggingOutcome::BadImage("无法解码".into()))
        .unwrap();
    library
        .finish_tagging(&model(), &crashed, TaggingOutcome::Crashed("崩溃".into()))
        .unwrap();
    library
        .finish_tagging(&model(), &done, TaggingOutcome::Done)
        .unwrap();
    assert_eq!(
        library.image(&bad).unwrap().tagging_failure,
        Some(TaggingFailure::Unreadable)
    );
    assert_eq!(
        library.image(&crashed).unwrap().tagging_failure,
        Some(TaggingFailure::Crashed)
    );
    assert_eq!(library.image(&done).unwrap().tagging_failure, None);

    let details = library
        .edit(&[bad.clone(), done.clone()], &[ImageEdit::RetryTagging])
        .unwrap();
    assert!(details.iter().all(|d| d.tagging_failure.is_none()));
    assert_eq!(library.images_to_tag(&model(), 10).unwrap(), vec![bad]);
    assert_eq!(
        library.count_failed_tagging(&model()).unwrap(),
        failed(0, 1)
    );
}

// 查找条件「自动标签未完成」只留下打不上标的图；排除时留下其余的。
#[test]
fn searching_for_unfinished_tagging_finds_the_images_that_could_not_be_tagged() {
    use kinshoko_core::approx::BuiltinApproxTable;
    use kinshoko_core::library::BrowseQuery;
    use kinshoko_core::search::{ConditionInput, Search, SearchInput, TermInput};

    let dir = tempfile::tempdir().unwrap();
    let (library, bad) = library_with_image(&dir.path().join("lib"));
    let crashed = import_more(&library, dir.path(), 2);
    let done = import_more(&library, dir.path(), 3);
    let waiting = import_more(&library, dir.path(), 4);
    library
        .finish_tagging(&model(), &bad, TaggingOutcome::BadImage("无法解码".into()))
        .unwrap();
    library
        .finish_tagging(&model(), &crashed, TaggingOutcome::Crashed("崩溃".into()))
        .unwrap();
    library
        .finish_tagging(&model(), &done, TaggingOutcome::Done)
        .unwrap();
    let search = |negate: bool| {
        let input = SearchInput {
            conditions: vec![ConditionInput {
                any: vec![TermInput::TaggingUnfinished],
                negate,
            }],
            exact: false,
        };
        let tree = Search::new(
            &library.vocabulary().unwrap(),
            &BuiltinApproxTable::bundled(),
        )
        .resolve(&input, ZH);
        let mut ids: Vec<String> = library
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
            .collect();
        ids.sort();
        ids
    };
    let sorted = |mut v: Vec<String>| {
        v.sort();
        v
    };
    assert_eq!(search(false), sorted(vec![bad, crashed]));
    assert_eq!(search(true), sorted(vec![done, waiting]));
}

fn failed(unreadable: u32, crashed: u32) -> FailedTagging {
    FailedTagging {
        unreadable,
        crashed,
    }
}

fn import_more(library: &Library, dir: &Path, seed: u8) -> String {
    let path = dir.join(format!("more-{seed}.png"));
    RgbaImage::from_fn(4, 4, |x, y| image::Rgba([seed, x as u8, y as u8, 255]))
        .save(&path)
        .unwrap();
    match library
        .import(ImportSource { paths: vec![path] })
        .wait()
        .items
        .remove(0)
        .outcome
    {
        ImportOutcome::Imported { image_id } => image_id,
        other => panic!("未导入：{other:?}"),
    }
}
