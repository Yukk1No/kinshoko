//! 应用壳的翻译表装配（#76 Core3、#77 C1）：走生产代码同一条路径——[`LibraryState::new`]
//! 取 [`bundled_translations`]，[`forward_events`] 调 [`LibraryState::configure_library`]。
//! 不启动 Tauri；资料库是临时目录里的真库。

use kinshoko_core::library::{FactSource, ImportOutcome, SourceTag, TagNamespace, TagRef};
use kinshoko_core::search::Search;

use super::*;

fn library_with_image(dir: &Path, name: &str) -> (Library, String) {
    let library = Library::create(&dir.join(name), name).unwrap();
    let path = dir.join(format!("{name}.png"));
    image::RgbaImage::from_pixel(4, 4, image::Rgba([1, 2, 3, 255]))
        .save(&path)
        .unwrap();
    let report = library.import(ImportSource { paths: vec![path] }).wait();
    let ImportOutcome::Imported { image_id } = &report.items[0].outcome else {
        panic!("未导入：{:?}", report.items[0].outcome);
    };
    let id = image_id.clone();
    (library, id)
}

fn tag_blue_eyes(library: &Library, image_id: &str) {
    library
        .replace_source_tags(
            &FactSource::model("pixai-v1.0"),
            image_id,
            &[SourceTag {
                tag: TagRef::External {
                    namespace: TagNamespace::General,
                    name: "blue_eyes".into(),
                },
                score: Some(0.9),
            }],
        )
        .unwrap();
}

fn names(library: &Library, image_id: &str) -> Vec<(String, bool)> {
    library
        .image_tags(image_id, "zh-CN")
        .unwrap()
        .tags
        .into_iter()
        .map(|t| (t.tag.name, t.tag.untranslated))
        .collect()
}

fn state() -> (tempfile::TempDir, LibraryState) {
    let dir = tempfile::tempdir().unwrap();
    let state = LibraryState::new(dir.path().join("device"), SafeMode::from(true));
    (dir, state)
}

#[test]
fn creating_an_unopened_library_waits_for_the_transition() {
    use crate::app_notice::AppNotices;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

    let (dir, state) = state();
    let app = mock_builder()
        .manage(state)
        .manage(AppNotices::<MockRuntime>::new(vec![]))
        .build(mock_context(noop_assets()))
        .unwrap();
    let session = &app.state::<LibraryState>().inner().session;
    let registered = std::thread::scope(|scope| {
        let transition = session.transition();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let app_handle = app.handle().clone();
        let parent = dir.path().to_path_buf();
        scope.spawn(move || {
            started_tx.send(()).unwrap();
            let result = tauri::async_runtime::block_on(create_library_unopened(
                app_handle,
                parent,
                "new".into(),
            ));
            done_tx.send(result).unwrap();
        });

        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            done_rx.recv_timeout(Duration::from_millis(200)).err(),
            Some(mpsc::RecvTimeoutError::Timeout)
        );
        assert!(!dir.path().join("new").exists());
        drop(transition);

        done_rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .unwrap()
    });
    session
        .with_libraries(|libraries| {
            assert_eq!(libraries.libraries(), &[registered]);
            assert!(libraries.current().is_none());
            Ok(())
        })
        .unwrap();
}

#[test]
fn the_injection_point_hands_out_the_shipped_table() {
    let (_dir, state) = state();
    assert_eq!(*state.translations, TagTranslations::bundled());
    assert!(
        state
            .translations
            .entries
            .iter()
            .any(|e| e.external == "blue_eyes" && e.names["zh-CN"] == "蓝瞳")
    );
}

#[test]
fn a_library_assembled_by_the_app_names_model_tags_and_finds_them_by_chinese_names() {
    let (dir, state) = state();
    let (library, image) = library_with_image(dir.path(), "new");
    state.configure_library(&library);
    tag_blue_eyes(&library, &image);

    assert_eq!(names(&library, &image), [("蓝瞳".to_owned(), false)]);
    let search = Search::new(
        &library.vocabulary().unwrap(),
        state.search().builtin_approx(),
    );
    for text in ["蓝瞳", "蓝眼睛"] {
        let found = search.candidates(text, "zh-CN", 5);
        assert_eq!(found.len(), 1, "{text}");
        assert_eq!(found[0].tag.name, "蓝瞳");
    }
}

#[test]
fn opening_a_legacy_library_preserves_untranslated_display_until_explicit_migration() {
    let (dir, state) = state();
    let (library, image) = library_with_image(dir.path(), "old");
    tag_blue_eyes(&library, &image);
    assert_eq!(names(&library, &image), [("blue eyes".to_owned(), true)]);

    state.configure_library(&library);
    assert_eq!(names(&library, &image), [("blue eyes".to_owned(), true)]);
}

#[test]
fn the_eagle_wizard_matches_chinese_tag_names_with_the_same_table() {
    let (_dir, state) = state();
    let vocabulary = ExternalVocabulary::new(Vec::new(), &state.translations);
    assert_eq!(vocabulary.by_translation("蓝瞳"), ["blue_eyes"]);
}
