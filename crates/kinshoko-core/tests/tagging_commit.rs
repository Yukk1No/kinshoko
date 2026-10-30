//! 提交打标结果（#318）：一次成功推理的模型标签、分级建议与完成状态作为一份结果整体提交。
//! 任何一步失败（报错或进程中途结束）都整体回滚，不推送事件、不记完成；人工决定与其他来源不受影响。

use std::path::Path;

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::library::{
    ContentRating, FactSource, ImageEdit, ImportOutcome, ImportSource, LibraryEvent, RatingFact,
    SourceTag, TagEdit, TagNamespace, TagOrigin, TagRef, TaggingResult,
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
            LibraryEvent::ImagesChanged { image_ids, .. } if image_ids == &[id.clone()]
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
