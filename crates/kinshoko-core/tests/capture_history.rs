//! 截图与截图历史（#62）：截图存成带显示器配置文件的无损文件，历史可查看、删除，
//! 旧截图按规则丢弃，收藏经资料库的普通导入入口成为参考图。
//! 全部通过 `kinshoko_core::desktop` 的对外接口，用临时目录里的真文件。

use std::path::Path;

use image::{ImageDecoder, RgbaImage};
use kinshoko_core::Library;
use kinshoko_core::desktop::{CaptureHistory, HISTORY_LIMIT, Screenshot};
use kinshoko_core::library::{BrowseQuery, LibraryEvent};

/// 一张内容由 `seed` 决定的截图。
fn shot(w: u32, h: u32, seed: u8, icc: Option<&[u8]>) -> Screenshot {
    Screenshot {
        image: RgbaImage::from_fn(w, h, |x, y| image::Rgba([seed, x as u8, y as u8, 255])),
        icc: icc.map(<[u8]>::to_vec),
    }
}

/// 读回文件的像素与内嵌配置文件。
fn read_back(path: &Path) -> (RgbaImage, Option<Vec<u8>>) {
    let mut decoder = image::ImageReader::open(path)
        .unwrap()
        .with_guessed_format()
        .unwrap()
        .into_decoder()
        .unwrap();
    let icc = decoder.icc_profile().unwrap();
    let image = image::DynamicImage::from_decoder(decoder)
        .unwrap()
        .to_rgba8();
    (image, icc)
}

/// 测试用的“显示器配置文件”：内容无关紧要，只看是否原样嵌入。
const PROFILE: &[u8] = b"fake display profile bytes for the identity round trip";

#[test]
fn a_capture_is_kept_losslessly_with_the_display_profile_it_was_taken_under() {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(dir.path()).unwrap();
    let original = shot(37, 21, 7, Some(PROFILE));

    let entry = history.add(&original).unwrap();

    assert_eq!((entry.width, entry.height), (37, 21));
    assert_eq!(history.entries(), vec![entry.clone()]);
    let (pixels, icc) = read_back(&history.file(&entry.id).unwrap());
    assert_eq!(pixels, original.image, "像素与截取时一致");
    assert_eq!(icc.as_deref(), Some(PROFILE), "标注截取时的显示器配置文件");
}

#[test]
fn old_captures_beyond_the_limit_are_discarded() {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(dir.path()).unwrap();
    let added: Vec<_> = (0..HISTORY_LIMIT as u8 + 2)
        .map(|i| history.add(&shot(4, 4, i, None)).unwrap())
        .collect();
    let paths: Vec<_> = added[..2]
        .iter()
        .map(|e| dir.path().join(format!("{}.png", e.id)))
        .collect();

    let ids: Vec<_> = history.entries().into_iter().map(|e| e.id).collect();
    let newest: Vec<_> = added
        .iter()
        .rev()
        .take(HISTORY_LIMIT)
        .map(|e| e.id.clone())
        .collect();
    assert_eq!(ids, newest, "只留最近 {HISTORY_LIMIT} 张");
    assert!(history.file(&added[0].id).is_none());
    assert!(paths.iter().all(|p| !p.exists()), "丢弃的截图文件已删除");
}

#[test]
fn a_pinned_capture_is_kept_until_its_pin_closes() {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(dir.path()).unwrap();
    let pinned = history.add(&shot(4, 4, 99, None)).unwrap();
    history.pin(&pinned.id);
    for i in 0..HISTORY_LIMIT as u8 + 3 {
        history.add(&shot(4, 4, i, None)).unwrap();
    }

    let kept = history.entries();
    assert_eq!(kept.len(), HISTORY_LIMIT + 1);
    assert_eq!(
        kept.last().map(|e| (&e.id, e.pinned)),
        Some((&pinned.id, true))
    );
    let file = history.file(&pinned.id).expect("钉住的截图不丢弃");
    assert!(file.exists());

    history.unpin(&pinned.id);

    assert_eq!(history.entries().len(), HISTORY_LIMIT);
    assert!(history.file(&pinned.id).is_none());
    assert!(!file.exists(), "钉图关闭后按规则丢弃");
}

#[test]
fn deleting_a_capture_removes_it_and_its_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(dir.path()).unwrap();
    let keep = history.add(&shot(4, 4, 1, None)).unwrap();
    let unwanted = history.add(&shot(4, 4, 2, None)).unwrap();
    let file = history.file(&unwanted.id).unwrap();

    history.delete(&unwanted.id).unwrap();

    assert_eq!(history.entries(), vec![keep]);
    assert!(!file.exists());
    drop(history);
    assert!(
        CaptureHistory::open(dir.path())
            .unwrap()
            .file(&unwanted.id)
            .is_none()
    );
}

#[test]
fn deleting_a_pinned_capture_hides_it_but_the_pin_keeps_showing_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(dir.path()).unwrap();
    let pinned = history.add(&shot(4, 4, 1, None)).unwrap();
    history.pin(&pinned.id);

    history.delete(&pinned.id).unwrap();

    assert_eq!(history.entries(), vec![], "历史里不再列出");
    let file = history.file(&pinned.id).expect("钉图还能读到截图");
    assert!(file.exists());

    history.unpin(&pinned.id);

    assert!(history.file(&pinned.id).is_none());
    assert!(!file.exists(), "钉图关闭后删除文件");
}

#[test]
fn deleting_an_unknown_capture_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(dir.path()).unwrap();
    assert!(history.delete("nope").is_err());
}

#[test]
fn collecting_a_capture_imports_it_as_a_reference_image() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("库"), "参考").unwrap();
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let entry = history.add(&shot(30, 20, 5, Some(PROFILE))).unwrap();
    let capture_bytes = std::fs::read(history.file(&entry.id).unwrap()).unwrap();

    let collected = history.collect(&entry.id, &library).unwrap();

    let page = library
        .browse(&BrowseQuery {
            scope: Default::default(),
            conditions: Default::default(),
            cursor: None,
            limit: 10,
            thumbnail_px: 64,
        })
        .unwrap();
    assert_eq!(page.cards.len(), 1);
    assert_eq!(page.cards[0].id, collected.image_id);
    assert_eq!((page.cards[0].width, page.cards[0].height), (30, 20));
    let original = library.original_path(&collected.image_id).unwrap();
    assert_eq!(
        std::fs::read(original).unwrap(),
        capture_bytes,
        "原样收进资料库，配置文件随文件保留"
    );
    assert_eq!(collected.library_id, library.info().id);
    assert_eq!(history.entries()[0].collected, vec![collected.clone()]);

    // 再收藏一次：资料库按内容去重，仍是同一张参考图。
    assert_eq!(history.collect(&entry.id, &library).unwrap(), collected);
    assert_eq!(history.entries()[0].collected, vec![collected]);
}

#[test]
fn collecting_reports_progress_to_the_library_like_any_import() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("库"), "参考").unwrap();
    let events = library.events();
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let entry = history.add(&shot(8, 8, 5, None)).unwrap();

    history.collect(&entry.id, &library).unwrap();

    let finished = events
        .try_iter()
        .any(|e| matches!(e, LibraryEvent::TaskFinished { .. }));
    assert!(finished, "经普通导入入口，界面照常收到导入完成");
}

#[test]
fn opening_cleans_up_files_left_behind_by_an_interrupted_run() {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(dir.path()).unwrap();
    let kept = history.add(&shot(4, 4, 1, None)).unwrap();
    drop(history);
    let stray = dir.path().join("0123456789abcdef0123456789abcdef.png");
    let half_written = dir.path().join("fedcba9876543210fedcba9876543210.png.tmp");
    std::fs::write(&stray, b"x").unwrap();
    std::fs::write(&half_written, b"x").unwrap();
    let unrelated = dir.path().join("说明.txt");
    std::fs::write(&unrelated, b"x").unwrap();

    let history = CaptureHistory::open(dir.path()).unwrap();

    assert!(!stray.exists() && !half_written.exists());
    assert!(unrelated.exists(), "只清理截图历史自己的文件");
    assert!(history.file(&kept.id).unwrap().exists());
}

#[test]
fn an_unreadable_index_starts_an_empty_history_without_deleting_captures() {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(dir.path()).unwrap();
    let entry = history.add(&shot(4, 4, 1, None)).unwrap();
    let file = history.file(&entry.id).unwrap();
    drop(history);
    std::fs::write(dir.path().join("history.json"), b"{ not json").unwrap();

    let history = CaptureHistory::open(dir.path()).unwrap();

    assert_eq!(history.entries(), vec![]);
    assert!(file.exists(), "索引坏了不连带删除截图文件");
}

#[test]
fn history_survives_closing_and_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(dir.path()).unwrap();
    let first = history.add(&shot(5, 5, 1, None)).unwrap();
    let second = history.add(&shot(6, 6, 2, Some(PROFILE))).unwrap();
    drop(history);

    let history = CaptureHistory::open(dir.path()).unwrap();

    assert_eq!(history.entries(), vec![second, first.clone()], "从新到旧");
    assert_eq!(
        read_back(&history.file(&first.id).unwrap()).0,
        shot(5, 5, 1, None).image
    );
}
