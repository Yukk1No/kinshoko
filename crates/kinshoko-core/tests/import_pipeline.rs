//! 导入的并行准备（#120）：读取、解码、哈希、暂存与占位图在工作线程上并行做，提交仍按文件顺序。
//! 全部通过 `Library` 的对外接口，用临时目录里的真 SQLite 与真文件。

use std::path::{Path, PathBuf};

use image::{Rgba, RgbaImage};
use kinshoko_core::Library;
use kinshoko_core::library::{BrowseQuery, ImportOutcome, ImportSource, LibraryEvent};

fn write_png(path: &Path, w: u32, h: u32, seed: u8) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    RgbaImage::from_fn(w, h, |x, y| Rgba([seed, x as u8, y as u8, 255]))
        .save(path)
        .unwrap();
    path.to_path_buf()
}

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
