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
fn collecting_a_capture_pin_makes_it_a_group_member_without_changing_its_crop_or_placement() {
    use kinshoko_core::desktop::{PinContent, Placement, Region, SavedPin};
    use kinshoko_core::reference_groups::ReferenceGroups;
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let capture = history.add(&shot(37, 21, 7, None)).unwrap();
    let library = Library::create(&dir.path().join("library"), "参考").unwrap();
    // 已经手动收藏的截图也使用同一入口，按字节合并。
    let collected = history.collect(&capture.id, &library).unwrap();
    let pin = SavedPin {
        id: "capture-pin".into(),
        content: PinContent::Capture {
            capture_id: capture.id,
        },
        crop: Some(Region {
            x: 2,
            y: 3,
            width: 10,
            height: 8,
        }),
        width: 10,
        height: 8,
        placement: Placement {
            x: 100,
            y: 50,
            scale: 1.5,
            rotation: 1,
            ..Default::default()
        },
        opacity: 0.6,
        locked: true,
        member: None,
    };
    let mut prepared = history.collect_pin(&pin, &library).unwrap();
    assert_eq!(prepared.crop, pin.crop);
    assert_eq!(prepared.placement, pin.placement);
    assert_eq!((prepared.opacity, prepared.locked), (0.6, true));
    let groups = ReferenceGroups::open(&dir.path().join("groups")).unwrap();
    let group = groups
        .create("截图参考", std::slice::from_mut(&mut prepared))
        .unwrap();
    assert_eq!(group.members.len(), 1);
    assert_eq!(group.members[0].library_id, collected.library_id);
    assert_eq!(group.members[0].image_id, collected.image_id);
    assert_eq!(group.members[0].crop, pin.crop);
    assert_eq!(group.members[0].placement, pin.placement);
}

#[test]
fn a_capture_is_kept_losslessly_with_the_display_profile_it_was_taken_under() {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(dir.path()).unwrap();
    let original = shot(37, 21, 7, Some(PROFILE));

    let prepared = CaptureHistory::prepare(&original).unwrap();
    assert!(history.entries().is_empty());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    let entry = history.add_prepared(prepared).unwrap();

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
    let pending = history.prepare_collect(&first.id).unwrap();
    drop(history);
    drop(pending); // Exiting a valid history must not unlink persisted captures.

    let history = CaptureHistory::open(dir.path()).unwrap();

    assert_eq!(history.entries(), vec![second, first.clone()], "从新到旧");
    assert_eq!(
        read_back(&history.file(&first.id).unwrap()).0,
        shot(5, 5, 1, None).image
    );
}

#[test]
fn concurrent_collections_retain_a_deleted_file_without_claiming_a_desktop_pin() {
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("library"), "收藏").unwrap();
    let history = Arc::new(Mutex::new(
        CaptureHistory::open(&dir.path().join("captures")).unwrap(),
    ));
    let (entry, file, first, second) = {
        let mut history = history.lock().unwrap();
        let entry = history.add(&shot(37, 21, 7, Some(PROFILE))).unwrap();
        let file = history.file(&entry.id).unwrap();
        let first = history.prepare_collect(&entry.id).unwrap();
        let second = history.prepare_collect(&entry.id).unwrap();
        assert!(!history.entry(&entry.id).unwrap().pinned);
        (entry, file, first, second)
    };
    let bytes = std::fs::read(&file).unwrap();
    let mut guard = history.lock().unwrap();
    guard.delete(&entry.id).unwrap();
    assert!(guard.entries().is_empty());
    assert!(guard.file(&entry.id).is_none());
    assert!(file.exists());
    drop(first);
    assert!(file.exists(), "第二个收藏请求仍需要原文件");
    let (send, receive) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        send.send((second.import(&library), library)).unwrap();
    });
    // 完整的真实导入必须在历史锁仍由本线程持有时结束。
    let (result, library) = receive.recv_timeout(Duration::from_secs(10)).unwrap();
    worker.join().unwrap();
    let collected = guard.finish_collect(result.unwrap()).unwrap();
    assert!(
        guard.entries().is_empty(),
        "收藏完成不能恢复用户已删除的历史条目"
    );
    assert!(!file.exists(), "最后一个收藏请求结束后回收已删除的文件");
    assert_eq!(
        std::fs::read(library.original_path(&collected.image_id).unwrap()).unwrap(),
        bytes
    );
}

#[test]
fn abandoning_or_failing_a_collection_releases_the_deleted_file() {
    for fail_import in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::create(&dir.path().join("library"), "收藏").unwrap();
        let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
        let entry = history.add(&shot(7, 5, 1, None)).unwrap();
        let file = history.file(&entry.id).unwrap();
        let pending = history.prepare_collect(&entry.id).unwrap();
        history.delete(&entry.id).unwrap();
        assert!(file.exists());
        if fail_import {
            std::fs::write(&file, b"unreadable image").unwrap();
            assert!(pending.import(&library).is_err());
        } else {
            drop(pending);
        }
        assert!(!file.exists());
        assert!(history.entries().is_empty());
    }
}

#[test]
fn collection_retention_does_not_expand_the_visible_history_limit() {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(dir.path()).unwrap();
    let entry = history.add(&shot(7, 5, 99, None)).unwrap();
    let file = history.file(&entry.id).unwrap();
    let pending = history.prepare_collect(&entry.id).unwrap();
    for i in 0..HISTORY_LIMIT as u8 {
        history.add(&shot(4, 4, i, None)).unwrap();
    }
    let kept = history.entries();
    assert_eq!(kept.len(), HISTORY_LIMIT);
    assert!(kept.iter().all(|entry| !entry.pinned));
    assert!(history.file(&entry.id).is_none());
    assert!(file.exists());
    drop(pending);
    assert!(!file.exists());
    drop(history);
    let reopened = CaptureHistory::open(dir.path()).unwrap();
    assert_eq!(reopened.entries(), kept);
    assert!(
        kept.iter()
            .all(|entry| reopened.file(&entry.id).unwrap().exists())
    );
}

#[test]
fn collecting_a_deleted_pin_preserves_its_layout_after_the_original_pin_closes() {
    use kinshoko_core::desktop::{GroupMemberRef, PinContent, Placement, Region, SavedPin};
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("library"), "收藏").unwrap();
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let entry = history.add(&shot(37, 21, 7, None)).unwrap();
    let file = history.file(&entry.id).unwrap();
    history.pin(&entry.id);
    let pin = SavedPin {
        id: "capture-pin".into(),
        content: PinContent::Capture {
            capture_id: entry.id.clone(),
        },
        crop: Some(Region {
            x: 2,
            y: 3,
            width: 10,
            height: 8,
        }),
        width: 10,
        height: 8,
        placement: Placement {
            x: 100,
            y: 50,
            scale: 1.5,
            flip_h: true,
            rotation: 1,
            ..Default::default()
        },
        opacity: 0.6,
        locked: true,
        member: Some(GroupMemberRef {
            group_id: "group".into(),
            member_id: "member".into(),
        }),
    };
    let pending = history.prepare_collect(&entry.id).unwrap();
    history.delete(&entry.id).unwrap();
    assert!(history.entry(&entry.id).unwrap().pinned);
    assert!(file.exists());
    let completed_while_pinned = history
        .prepare_collect(&entry.id)
        .unwrap()
        .import(&library)
        .unwrap();
    let reference_while_pinned = history
        .finish_collect_pin(&pin, completed_while_pinned)
        .unwrap();
    assert!(history.entry(&entry.id).unwrap().pinned);
    assert!(file.exists(), "收藏请求结束不能删除仍有真实钉图的文件");
    history.unpin(&entry.id);
    assert!(history.entry(&entry.id).is_none());
    assert!(file.exists(), "收藏保护与真实钉图计数独立");
    let collected = pending.import(&library).unwrap();
    let reference: SavedPin = history.finish_collect_pin(&pin, collected).unwrap();
    let PinContent::Reference {
        ref library_id,
        ref image_id,
        source_width,
        source_height,
    } = reference.content
    else {
        panic!("收藏必须成为资料库参考图");
    };
    assert_eq!(library_id, &library.info().id);
    assert_eq!((source_width, source_height), (37, 21));
    assert_eq!(
        read_back(&library.original_path(image_id).unwrap()).0,
        shot(37, 21, 7, None).image
    );
    let mut expected = pin;
    expected.content = reference.content.clone();
    assert_eq!(reference, expected);
    assert_eq!(reference, reference_while_pinned);
    assert!(!file.exists());
    assert!(history.entries().is_empty());
}
