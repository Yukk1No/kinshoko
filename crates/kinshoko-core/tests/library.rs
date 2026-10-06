//! 资料库：建库、导入静态图、分页浏览、关闭后重开（#44）。
//! 全部通过 `Library` 的对外接口，用临时目录里的真 SQLite 与真文件。

use std::path::{Path, PathBuf};

use image::{ImageEncoder, RgbImage, RgbaImage};
use kinshoko_core::Library;
use kinshoko_core::library::{BrowseQuery, ImportOutcome, ImportReport, ImportSource};
use sha2::{Digest, Sha256};

fn sha256(path: &Path) -> String {
    format!("{:x}", Sha256::digest(std::fs::read(path).unwrap()))
}

/// 每次调用生成内容不同的图（`seed` 改变像素），尺寸为 `w × h`。
fn write_png(path: &Path, w: u32, h: u32, seed: u8) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    RgbaImage::from_fn(w, h, |x, y| image::Rgba([seed, x as u8, y as u8, 200]))
        .save(path)
        .unwrap();
    path.to_path_buf()
}

fn write_jpeg(path: &Path, w: u32, h: u32, seed: u8, exif_orientation: Option<u16>) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let img = RgbImage::from_fn(w, h, |x, y| image::Rgb([seed, x as u8, y as u8]));
    let mut out = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new(&mut out);
    if let Some(o) = exif_orientation {
        encoder.set_exif_metadata(exif_with_orientation(o)).unwrap();
    }
    encoder
        .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgb8)
        .unwrap();
    std::fs::write(path, out).unwrap();
    path.to_path_buf()
}

fn write_webp(path: &Path, w: u32, h: u32, seed: u8) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    RgbaImage::from_fn(w, h, |x, y| image::Rgba([x as u8, seed, y as u8, 255]))
        .save(path)
        .unwrap();
    path.to_path_buf()
}

/// 最小的 TIFF 结构 EXIF：只含方向一项（小端）。
fn exif_with_orientation(o: u16) -> Vec<u8> {
    let mut e = b"II*\0".to_vec();
    e.extend(8u32.to_le_bytes());
    e.extend(1u16.to_le_bytes());
    e.extend(0x0112u16.to_le_bytes());
    e.extend(3u16.to_le_bytes());
    e.extend(1u32.to_le_bytes());
    e.extend(o.to_le_bytes());
    e.extend([0, 0]);
    e.extend(0u32.to_le_bytes());
    e
}

fn import(library: &Library, paths: &[PathBuf]) -> ImportReport {
    library
        .import(ImportSource {
            paths: paths.to_vec(),
        })
        .wait()
}

fn all(library: &Library) -> Vec<kinshoko_core::library::ImageCard> {
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
fn a_new_library_keeps_its_identity_and_name_after_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("工作参考");

    let created = Library::create(&root, "工作参考").unwrap();
    let id = created.info().id.clone();
    drop(created);

    let reopened = Library::open(&root).unwrap();
    assert_eq!(reopened.info().id, id);
    assert_eq!(reopened.info().name, "工作参考");
}

#[test]
fn imported_files_keep_their_bytes_and_show_at_their_upright_size() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let png = write_png(&dir.path().join("in/横图.png"), 60, 30, 1);
    let jpeg = write_jpeg(&dir.path().join("in/竖拍.jpg"), 40, 20, 2, Some(6));
    let webp = write_webp(&dir.path().join("in/c.webp"), 10, 50, 3);
    let before: Vec<String> = [&png, &jpeg, &webp].map(|p| sha256(p)).to_vec();

    let report = import(&library, &[png.clone(), jpeg.clone(), webp.clone()]);

    assert!(!report.cancelled);
    let ids: Vec<String> = report
        .items
        .iter()
        .map(|item| match &item.outcome {
            ImportOutcome::Imported { image_id } => image_id.clone(),
            other => panic!("{} 未导入：{other:?}", item.path.display()),
        })
        .collect();
    for (id, sha) in ids.iter().zip(&before) {
        assert_eq!(&sha256(&library.original_path(id).unwrap()), sha);
    }
    assert_eq!(before, [&png, &jpeg, &webp].map(|p| sha256(p)).to_vec());

    let sizes: Vec<(String, u32, u32)> = all(&library)
        .into_iter()
        .map(|c| (c.id, c.width, c.height))
        .collect();
    // 新导入的在前。竖拍的 JPEG 按 EXIF 方向 6 转正为 20 × 40。
    assert_eq!(
        sizes,
        vec![
            (ids[2].clone(), 10, 50),
            (ids[1].clone(), 20, 40),
            (ids[0].clone(), 60, 30),
        ]
    );
}

#[test]
fn a_folder_import_walks_subfolders_and_lists_each_file_that_did_not_come_in() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let src = dir.path().join("参考");
    write_png(&src.join("a.png"), 8, 8, 1);
    write_jpeg(&src.join("人物/b.jpg"), 8, 16, 2, None);
    write_webp(&src.join("人物/发型/c.webp"), 16, 8, 3);
    // 与 a.png 字节相同：合并为一条记录。
    std::fs::copy(src.join("a.png"), src.join("人物/a 副本.png")).unwrap();
    std::fs::write(src.join("说明.txt"), "不是图片").unwrap();
    // 扩展名是 .png，内容是文本：按内容识别，不支持。
    std::fs::write(src.join("假图.png"), "不是图片").unwrap();
    // PNG 头不完整：读取失败。
    let head = std::fs::read(src.join("a.png")).unwrap();
    std::fs::write(src.join("人物/坏图.png"), &head[..20]).unwrap();

    let report = import(&library, std::slice::from_ref(&src));

    let mut outcomes: Vec<(String, &str)> = report
        .items
        .iter()
        .map(|item| {
            let name = item.path.strip_prefix(&src).unwrap();
            let kind = match item.outcome {
                ImportOutcome::Imported { .. } => "imported",
                ImportOutcome::Merged { .. } => "merged",
                ImportOutcome::Unsupported => "unsupported",
                ImportOutcome::ReadFailed { .. } => "failed",
            };
            (name.to_string_lossy().replace('\\', "/"), kind)
        })
        .collect();
    outcomes.sort();
    assert_eq!(
        outcomes,
        vec![
            ("a.png".into(), "imported"),
            ("人物/a 副本.png".into(), "merged"),
            ("人物/b.jpg".into(), "imported"),
            ("人物/发型/c.webp".into(), "imported"),
            ("人物/坏图.png".into(), "failed"),
            ("假图.png".into(), "unsupported"),
            ("说明.txt".into(), "unsupported"),
        ]
    );
    assert_eq!(all(&library).len(), 3);
}

#[test]
fn browsing_pages_through_every_image_once_with_a_keyset_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let files: Vec<PathBuf> = (0..25)
        .map(|i| write_png(&dir.path().join(format!("in/{i:02}.png")), 4, 4, i))
        .collect();
    import(&library, &files);

    let mut seen = Vec::new();
    let mut cursor = None;
    let mut pages = 0;
    loop {
        let page = library
            .browse(&BrowseQuery {
                scope: Default::default(),
                conditions: Default::default(),
                cursor: cursor.take(),
                limit: 10,
                thumbnail_px: 256,
            })
            .unwrap();
        assert_eq!(page.total, 25);
        pages += 1;
        seen.extend(page.cards.into_iter().map(|c| c.id));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }

    assert_eq!(pages, 3);
    assert_eq!(
        seen,
        all(&library).into_iter().map(|c| c.id).collect::<Vec<_>>()
    );
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), 25);
}

#[test]
fn after_closing_and_reopening_the_wall_shows_the_same_images_in_the_same_order() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    let library = Library::create(&root, "库").unwrap();
    let files: Vec<PathBuf> = (0..5)
        .map(|i| {
            write_png(
                &dir.path().join(format!("in/{i}.png")),
                10 + i as u32,
                20,
                i,
            )
        })
        .collect();
    import(&library, &files);
    let before = all(&library);
    drop(library);

    let reopened = Library::open(&root).unwrap();

    assert_eq!(all(&reopened), before);
    for card in &before {
        let original = reopened.original_path(&card.id).unwrap();
        assert!(original.starts_with(std::path::absolute(&root).unwrap()));
    }
}

#[test]
fn an_import_reports_progress_and_stops_when_cancelled_keeping_what_came_in() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let files: Vec<PathBuf> = (0..200)
        .map(|i| write_png(&dir.path().join(format!("in/{i:03}.png")), 4, 4, i))
        .collect();
    let events = library.events();

    let task = library.import(ImportSource {
        paths: vec![dir.path().join("in")],
    });
    let task_id = task.id().to_owned();
    // 等到第一次有进度再取消。
    loop {
        match events
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap()
        {
            kinshoko_core::library::LibraryEvent::TaskProgress { progress, .. }
                if progress.done > 0 =>
            {
                break;
            }
            _ => {}
        }
    }
    task.cancel();
    let report = task.wait();

    assert!(report.cancelled);
    assert!(
        report.items.len() < files.len(),
        "取消后不应处理完全部 {} 项",
        files.len()
    );
    let imported = report
        .items
        .iter()
        .filter(|i| matches!(i.outcome, ImportOutcome::Imported { .. }))
        .count();
    assert_eq!(all(&library).len(), imported);

    let mut last_done = 0;
    let mut finished = None;
    while let Ok(event) = events.recv_timeout(std::time::Duration::from_secs(5)) {
        match event {
            kinshoko_core::library::LibraryEvent::TaskProgress {
                progress,
                task_id: t,
                ..
            } => {
                assert_eq!(t, task_id);
                assert!(progress.done >= last_done);
                assert_eq!(progress.total, 200);
                last_done = progress.done;
            }
            kinshoko_core::library::LibraryEvent::TaskFinished { report: r, .. } => {
                finished = Some(r);
                break;
            }
            _ => {}
        }
    }
    assert_eq!(finished, Some(report.clone()));
    assert_eq!(last_done as usize, report.items.len());
}

#[test]
fn thumbnails_are_a_rebuildable_cache_at_the_requested_width_tier() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    let library = Library::create(&root, "库").unwrap();
    let wide = write_png(&dir.path().join("in/wide.png"), 1000, 500, 1);
    let small = write_png(&dir.path().join("in/small.png"), 100, 300, 2);
    let tall = write_jpeg(&dir.path().join("in/tall.jpg"), 600, 300, 3, Some(6));
    let report = import(&library, &[wide, small, tall]);
    let id = |i: usize| match &report.items[i].outcome {
        ImportOutcome::Imported { image_id } => image_id.clone(),
        other => panic!("{other:?}"),
    };

    let thumb = library.thumbnail(&id(0), 250).unwrap();
    assert_eq!(image::image_dimensions(&thumb).unwrap(), (256, 128));
    assert_eq!(
        image::ImageFormat::from_path(&thumb).unwrap(),
        image::ImageFormat::WebP
    );
    // 原图比档位窄时不放大。
    assert_eq!(
        image::image_dimensions(library.thumbnail(&id(1), 250).unwrap()).unwrap(),
        (100, 300)
    );
    // 派生图已转正，不再带方向。
    assert_eq!(
        image::image_dimensions(library.thumbnail(&id(2), 250).unwrap()).unwrap(),
        (256, 512)
    );

    // 删除缓存后按同一地址重建。
    let bytes = std::fs::read(&thumb).unwrap();
    std::fs::remove_dir_all(root.join("cache")).unwrap();
    let rebuilt = library.thumbnail(&id(0), 250).unwrap();
    assert_eq!(rebuilt, thumb);
    assert_eq!(std::fs::read(&rebuilt).unwrap(), bytes);

    // 浏览卡片给出的缩略图地址按同一档位取整。
    let card = all(&library).into_iter().find(|c| c.id == id(0)).unwrap();
    assert_eq!(
        card.thumbnail,
        format!("{}/{}/256", library.info().id, id(0))
    );
}
