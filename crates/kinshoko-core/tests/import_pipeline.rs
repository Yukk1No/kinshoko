//! 导入的并行准备（#120）：读取、解码、哈希、暂存与占位图在工作线程上并行做，提交仍按文件顺序。
//! 通过资料库与工作区会话的对外接口，用临时目录里的真 SQLite 与真文件。

use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::time::Duration;

use image::{Rgba, RgbaImage};
use kinshoko_core::approx::BuiltinApproxTable;
use kinshoko_core::command_error::ErrorKind;
use kinshoko_core::library::{
    BrowseQuery, ContentRating, ImageEdit, ImportOutcome, ImportSource, LibraryEvent, SafeMode,
    SafeModeScope, TagTranslations,
};
use kinshoko_core::safe_mode::LensStale;
use kinshoko_core::search::CatalogSearch;
use kinshoko_core::{Library, VisibilityPermit, WorkspaceSession};

#[path = "support/library.rs"]
mod support_library;
use support_library::write_png;

fn browse(library: &Library) -> Vec<kinshoko_core::library::ImageCard> {
    library
        .browse(&BrowseQuery {
            scope: Default::default(),
            conditions: Default::default(),
            cursor: None,
            limit: 1000,
            thumbnail_px: 256,
        })
        .unwrap()
        .cards
}

#[test]
fn parallel_preparation_keeps_items_and_browse_order_in_file_order() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    // 尺寸不一，准备耗时不同，工作线程完成的先后与文件顺序不一致。
    let mut files: Vec<PathBuf> = (0..60u32)
        .map(|i| {
            let side = if i % 7 == 0 { 400 } else { 8 + i };
            write_png(
                &dir.path().join(format!("in/{i:03}.png")),
                side,
                side,
                i as u8,
            )
        })
        .collect();
    // 两张字节相同的图：后一张合并到前一张。
    std::fs::copy(&files[3], dir.path().join("in/003-copy.png")).unwrap();
    files.push(dir.path().join("in/003-copy.png"));
    files.sort();

    let report = library
        .import(ImportSource {
            paths: vec![dir.path().join("in")],
        })
        .wait();
    assert!(!report.cancelled);
    let paths: Vec<PathBuf> = report.items.iter().map(|i| i.path.clone()).collect();
    assert_eq!(paths, files, "逐项结果按文件顺序");

    let imported: Vec<String> = report
        .items
        .iter()
        .filter_map(|i| match &i.outcome {
            ImportOutcome::Imported { image_id } => Some(image_id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(imported.len(), 60);
    assert!(
        report
            .items
            .iter()
            .any(|i| matches!(i.outcome, ImportOutcome::Merged { .. })),
        "字节相同的第二份合并"
    );
    // 浏览从新到旧：正好是文件顺序倒过来，与串行导入时相同。
    let browsed: Vec<String> = browse(&library).into_iter().map(|c| c.id).collect();
    assert_eq!(browsed, imported.into_iter().rev().collect::<Vec<_>>());
    assert!(browse(&library).iter().all(|c| c.placeholder.is_some()));
}

#[test]
fn import_time_placeholders_match_the_ones_rebuilt_from_the_original() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    let library = Library::create(&root, "库").unwrap();
    for (i, (w, h)) in [(300, 200), (90, 400), (64, 64)].into_iter().enumerate() {
        write_png(&dir.path().join(format!("in/{i}.png")), w, h, 40 * i as u8);
    }
    library
        .import(ImportSource {
            paths: vec![dir.path().join("in")],
        })
        .wait();
    let at_import: Vec<_> = browse(&library)
        .into_iter()
        .map(|c| c.placeholder)
        .collect();
    drop(library);

    // 删掉缓存后重开：后台补齐从原文件单独解码重建，结果应逐字节相同。
    std::fs::remove_dir_all(root.join("cache")).unwrap();
    let library = Library::open(&root).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let rebuilt = loop {
        let cards: Vec<_> = browse(&library)
            .into_iter()
            .map(|c| c.placeholder)
            .collect();
        if cards.iter().all(Option::is_some) || std::time::Instant::now() > deadline {
            break cards;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    assert!(at_import.iter().all(Option::is_some));
    assert_eq!(at_import, rebuilt);
}

#[test]
fn cancelling_discards_prepared_items_without_leaving_staging_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    let library = Library::create(&root, "库").unwrap();
    for i in 0..300u32 {
        write_png(&dir.path().join(format!("in/{i:03}.png")), 64, 64, i as u8);
    }
    let events = library.events();
    let task = library.import(ImportSource {
        paths: vec![dir.path().join("in")],
    });
    loop {
        if let LibraryEvent::TaskProgress { progress, .. } = events
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap()
            && progress.done > 0
        {
            break;
        }
    }
    task.cancel();
    let report = task.wait();
    assert!(report.cancelled);
    assert!(report.items.len() < 300);
    let staging: Vec<_> = std::fs::read_dir(root.join(".staging"))
        .unwrap()
        .flatten()
        .collect();
    assert!(staging.is_empty(), "取消后没有遗留暂存文件：{staging:?}");
    assert_eq!(
        browse(&library).len(),
        report
            .items
            .iter()
            .filter(|i| i.outcome.image_id().is_some())
            .count()
    );
}

#[test]
fn cancelling_a_waiting_import_keeps_a_concurrent_import_of_the_same_original_intact() {
    use kinshoko_core::PublicationGate;
    use sha2::{Digest, Sha256};
    use std::sync::mpsc::RecvTimeoutError;
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    let library = Library::create(&root, "库").unwrap();
    let path = write_png(&dir.path().join("same.png"), 12, 8, 42);
    let bytes = std::fs::read(&path).unwrap();
    let sha = format!("{:x}", Sha256::digest(&bytes));
    let original = root
        .join("originals")
        .join(&sha[..2])
        .join(format!("{sha}.png"));
    let gate = PublicationGate::default();
    library.use_package_publication_gate(gate.clone());
    let events = library.events();
    let guard = gate.lock();
    let start = || {
        library.import(ImportSource {
            paths: vec![path.clone()],
        })
    };
    let first = start();
    let second = start();
    for _ in 0..2 {
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(5)).unwrap(),
            LibraryEvent::TaskProgress { progress, .. } if progress.done == 0 && progress.total == 1
        ));
    }
    assert!(matches!(
        events.recv_timeout(Duration::from_secs(1)),
        Err(RecvTimeoutError::Timeout)
    ));
    assert!(
        !original.exists(),
        "an import published its original before acquiring the gate"
    );

    first.cancel();
    let cancelled = loop {
        if let LibraryEvent::TaskFinished {
            task_id, report, ..
        } = events.recv_timeout(Duration::from_secs(5)).unwrap()
        {
            assert_eq!(task_id, first.id());
            break report;
        }
    };
    assert!(
        cancelled
            .items
            .iter()
            .all(|item| item.outcome.image_id().is_none())
    );
    first.wait();
    drop(guard);
    let report = second.wait();
    let id = report.items[0].outcome.image_id().unwrap();
    assert_eq!(
        std::fs::read(library.original_path(id).unwrap()).unwrap(),
        bytes
    );
}

/// 缓存目录里以 `-<后缀>.` 结尾命名的派生图（相对路径排序）。
fn derivatives(root: &Path, suffix: &str) -> Vec<PathBuf> {
    fn walk(dir: &Path, suffix: &str, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, suffix, out);
            } else if path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().contains(&format!("-{suffix}.")))
            {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    walk(&root.join("cache"), suffix, &mut out);
    out.sort();
    out
}

#[test]
fn import_pre_renders_grid_thumbnails_identical_to_on_demand_ones() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    let library = Library::create(&root, "库").unwrap();
    for (i, (w, h)) in [(900, 600), (300, 1200), (200, 200)]
        .into_iter()
        .enumerate()
    {
        write_png(&dir.path().join(format!("in/{i}.png")), w, h, 70 * i as u8);
    }
    library
        .import(ImportSource {
            paths: vec![dir.path().join("in")],
        })
        .wait();
    // 还没浏览过：按默认图片大小的档位（384）预先生成，三张都有。
    let at_import = derivatives(&root, "384");
    assert_eq!(at_import.len(), 3);
    let bytes: Vec<Vec<u8>> = at_import
        .iter()
        .map(|p| std::fs::read(p).unwrap())
        .collect();

    // 删掉后由浏览时的现场生成重建：逐字节相同，路径也相同（浏览时直接命中导入时生成的那份）。
    for path in &at_import {
        std::fs::remove_file(path).unwrap();
    }
    for card in browse(&library) {
        library.thumbnail(&card.id, 360).unwrap();
    }
    assert_eq!(derivatives(&root, "384"), at_import);
    let rebuilt: Vec<Vec<u8>> = at_import
        .iter()
        .map(|p| std::fs::read(p).unwrap())
        .collect();
    assert_eq!(bytes, rebuilt);
}

struct PreviewFixture {
    dir: tempfile::TempDir,
    session: Arc<WorkspaceSession>,
}

impl PreviewFixture {
    fn new(on: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("app");
        let search = CatalogSearch::new(
            app.clone(),
            TagTranslations::default(),
            BuiltinApproxTable::bundled(),
        );
        let session =
            WorkspaceSession::new(app, SafeMode::new(on, SafeModeScope::Explicit), search);
        Self {
            dir,
            session: Arc::new(session),
        }
    }

    fn library(&self, name: &str) -> Arc<Library> {
        let root = self.dir.path().join(name);
        let library = self
            .session
            .with_libraries(|device| device.create(&root, name))
            .unwrap();
        self.session.configure_library(&library);
        library
    }
}

fn rate(library: &Library, id: &str, rating: ContentRating) {
    library.set_safe_mode(false);
    library
        .edit(&[id.to_owned()], &[ImageEdit::SetRating { rating }])
        .unwrap();
}

#[test]
fn no_chunk_is_sent_after_safe_mode_is_committed() {
    let f = PreviewFixture::new(true);
    let grant = f.session.import_preview_grant().unwrap();
    let committed = AtomicBool::new(false);
    let chunks = AtomicUsize::new(0);
    let (first_tx, first) = mpsc::channel();
    let result = std::thread::scope(|scope| {
        let session = &f.session;
        let committed = &committed;
        scope.spawn(move || {
            first.recv().unwrap();
            let permit = session.visibility();
            permit
                .try_commit_safe_mode(|mode| mode.on = true, |_| Ok::<_, ()>(()))
                .unwrap();
            committed.store(true, Ordering::SeqCst);
        });
        VisibilityPermit::stream(&f.session, grant, |_| {
            assert!(!committed.load(Ordering::SeqCst), "提交之后又发送了一块");
            if chunks.fetch_add(1, Ordering::SeqCst) == 0 {
                first_tx.send(()).unwrap();
            }
            // 块与块之间出门：等着的提交迟早能进门，流随即停下。
            Ok::<_, LensStale>(ControlFlow::Continue(()))
        })
    });
    assert_eq!(result, Err::<(), _>(LensStale));
    assert!(chunks.load(Ordering::SeqCst) >= 1);
}

#[test]
fn a_fence_without_the_permit_stops_the_next_chunk() {
    let f = PreviewFixture::new(true);
    let grant = f.session.import_preview_grant().unwrap();
    let mut chunks = 0;
    let result = VisibilityPermit::stream(&f.session, grant, |_| {
        chunks += 1;
        // 窗口线程不能等许可，只让导入预览代次前进。
        f.session.fence_import_preview();
        Ok::<_, LensStale>(ControlFlow::Continue(()))
    });
    assert_eq!(result, Err::<(), _>(LensStale));
    assert_eq!(chunks, 1);
}

#[test]
fn a_stream_ends_when_the_last_chunk_is_sent() {
    let f = PreviewFixture::new(true);
    let grant = f.session.import_preview_grant().unwrap();
    let mut sent = Vec::new();
    let result = VisibilityPermit::stream(&f.session, grant, |_| {
        sent.push(sent.len());
        Ok::<_, LensStale>(if sent.len() == 3 {
            ControlFlow::Break("完")
        } else {
            ControlFlow::Continue(())
        })
    });
    assert_eq!(result, Ok("完"));
    assert_eq!(sent, [0, 1, 2]);
}

#[test]
fn import_preview_grants_need_safe_mode_on() {
    assert_eq!(
        PreviewFixture::new(false).session.import_preview_grant(),
        Err(LensStale)
    );
}

/// 一份几千字节的 PNG（像素不规则，压不小），分好几块才发完。
fn noisy_png(dir: &std::path::Path) -> std::path::PathBuf {
    let path = dir.join("noisy.png");
    let mut seed = 0x2545_f491_u32;
    RgbaImage::from_fn(40, 40, |_, _| {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        let [r, g, b, _] = seed.to_le_bytes();
        Rgba([r, g, b, 255])
    })
    .save(&path)
    .unwrap();
    path
}

/// 安全模式开启时，把一份已在别的库评为成人的图导入 `target`：回执里它被封印，只能经预览显示。
/// 返回打开的预览、要读的项与原图字节。
fn sealed_duplicate_preview(f: &PreviewFixture) -> (String, String, Vec<u8>) {
    use kinshoko_core::library::{ImportOptions, SaveDestination};
    let adult = f.library("adult");
    let target = f.library("target");
    let same = noisy_png(f.dir.path());
    let adult_image = adult
        .import(ImportSource {
            paths: vec![same.clone()],
        })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();
    rate(&adult, &adult_image, ContentRating::Explicit);
    let target_id = target.info().id.clone();
    let task = f
        .session
        .with_libraries(|device| {
            device.start_import_to(
                SaveDestination {
                    library_id: target_id.clone(),
                    folder_id: None,
                },
                ImportSource {
                    paths: vec![same.clone()],
                },
                ImportOptions::default(),
            )
        })
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while f
        .session
        .with_libraries(|device| Ok(device.import_task(&task).unwrap().report.is_none()))
        .unwrap()
    {
        assert!(std::time::Instant::now() < deadline, "导入没有收尾");
        std::thread::sleep(Duration::from_millis(5));
    }
    let grant = f.session.begin_import_preview().unwrap();
    let preview = f
        .session
        .open_import_preview(grant, &target_id, &task)
        .unwrap();
    let bytes = std::fs::read(&same).unwrap();
    assert!(bytes.len() > 3 * kinshoko_core::session::IMPORT_PREVIEW_CHUNK_BYTES);
    (preview.id, preview.items[0].clone(), bytes)
}

#[test]
fn an_import_preview_sends_the_original_bytes_in_chunks() {
    let f = PreviewFixture::new(true);
    let (preview, item, bytes) = sealed_duplicate_preview(&f);
    let mut chunks = Vec::new();
    f.session
        .read_import_preview(
            f.session.import_preview_grant().unwrap(),
            &preview,
            &item,
            240,
            |chunk| {
                chunks.push(chunk.to_vec());
                Ok(())
            },
        )
        .unwrap();
    assert!(chunks.len() > 3, "{} 块", chunks.len());
    assert_eq!(chunks.concat(), bytes);
}

#[test]
fn an_import_preview_stops_sending_once_safe_mode_is_committed() {
    let f = PreviewFixture::new(true);
    let (preview, item, bytes) = sealed_duplicate_preview(&f);
    let committed = AtomicBool::new(false);
    let mut sent = 0;
    let (first_tx, first) = mpsc::channel();
    let result = std::thread::scope(|scope| {
        let session = &f.session;
        let committed = &committed;
        scope.spawn(move || {
            first.recv().unwrap();
            let permit = session.visibility();
            permit
                .try_commit_safe_mode(|mode| mode.on = true, |_| Ok::<_, ()>(()))
                .unwrap();
            committed.store(true, Ordering::SeqCst);
        });
        f.session.read_import_preview(
            f.session.import_preview_grant().unwrap(),
            &preview,
            &item,
            240,
            |chunk| {
                assert!(
                    !committed.load(Ordering::SeqCst),
                    "提交之后又发送了预览字节"
                );
                if sent == 0 {
                    first_tx.send(()).unwrap();
                }
                sent += chunk.len();
                Ok(())
            },
        )
    });
    // 提交不一定赶在最后一块之前进门；赶上了就必须停下，不再发送（回调里的断言守着这一点）。
    // 字节发完、收尾那一轮之前才进门时，字节已经全部发出，但预览仍以“视角变了”结束，没有收尾。
    match result {
        Ok(()) => assert_eq!(sent, bytes.len()),
        Err(error) => {
            assert_eq!(error.kind, ErrorKind::LensChanged);
            assert!(sent <= bytes.len());
        }
    }
    let after = f.session.read_import_preview(
        f.session.import_preview_grant().unwrap(),
        &preview,
        &item,
        240,
        |_| panic!("安全模式提交后预览同意已作废"),
    );
    assert!(after.is_err());
}

#[test]
fn closing_the_window_fences_an_import_preview_before_the_next_chunk() {
    let f = PreviewFixture::new(true);
    let (preview, item, bytes) = sealed_duplicate_preview(&f);
    let mut sent = 0;
    let result = f.session.read_import_preview(
        f.session.import_preview_grant().unwrap(),
        &preview,
        &item,
        240,
        |chunk| {
            sent += chunk.len();
            // 窗口线程不等许可，只让导入预览代次前进。
            f.session.fence_import_preview();
            Ok(())
        },
    );
    assert_eq!(result.unwrap_err().kind, ErrorKind::LensChanged);
    assert_eq!(sent, kinshoko_core::session::IMPORT_PREVIEW_CHUNK_BYTES);
    assert!(sent < bytes.len());
}
