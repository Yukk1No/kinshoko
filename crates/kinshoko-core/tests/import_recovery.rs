//! 导入的中断恢复、去重、重试与长路径（#46）。
//! 全部通过 `Library` 的对外接口，用临时目录里的真 SQLite 与真文件。

use std::path::{Path, PathBuf};

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::library::{BrowseQuery, ImportOutcome, ImportReport, ImportSource};

/// 每个 `seed` 生成内容不同的 PNG。
fn write_png(path: &Path, seed: u8) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    RgbaImage::from_fn(12, 8, |x, y| image::Rgba([seed, x as u8, y as u8, 255]))
        .save(path)
        .unwrap();
    path.to_path_buf()
}

fn import(library: &Library, paths: &[PathBuf]) -> ImportReport {
    library
        .import(ImportSource {
            paths: paths.to_vec(),
        })
        .wait()
}

fn count(library: &Library) -> u32 {
    library
        .browse(&BrowseQuery {
            scope: Default::default(),
            cursor: None,
            limit: 1,
            thumbnail_px: 256,
        })
        .unwrap()
        .total
}

fn kind(outcome: &ImportOutcome) -> &'static str {
    match outcome {
        ImportOutcome::Imported { .. } => "imported",
        ImportOutcome::Merged { .. } => "merged",
        ImportOutcome::Unsupported => "unsupported",
        ImportOutcome::ReadFailed { .. } => "failed",
    }
}

#[test]
fn retrying_after_a_partial_failure_only_processes_the_failed_items_and_never_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let src = dir.path().join("参考");
    let good = write_png(&src.join("好图.png"), 1);
    write_png(&src.join("子/另一张.png"), 2);
    let broken = src.join("子/坏图.png");
    let head = std::fs::read(&good).unwrap();
    std::fs::write(&broken, &head[..20]).unwrap();

    let first = import(&library, std::slice::from_ref(&src));
    assert_eq!(count(&library), 2);
    let retry = first.retry_source().expect("有失败项可重试");
    assert_eq!(retry.paths, vec![broken.clone()]);

    // 没修好就重试：仍然失败，不多出记录。
    let again = import(&library, &retry.paths);
    assert_eq!(again.items.len(), 1);
    assert_eq!(kind(&again.items[0].outcome), "failed");
    assert_eq!(count(&library), 2);

    // 修好后重试：只补上那一项。
    write_png(&broken, 3);
    let fixed = import(&library, &again.retry_source().unwrap().paths);
    assert_eq!(fixed.items.len(), 1);
    assert_eq!(kind(&fixed.items[0].outcome), "imported");
    assert_eq!(fixed.retry_source(), None);
    assert_eq!(count(&library), 3);

    // 整个文件夹再导一遍也不会重复。
    let whole = import(&library, std::slice::from_ref(&src));
    assert!(whole.items.iter().all(|i| kind(&i.outcome) == "merged"));
    assert_eq!(count(&library), 3);
}

/// 在 `base` 下拼出一条总长超过 `min_len` 个字符的文件夹路径。
fn deep_dir(base: &Path, min_len: usize) -> PathBuf {
    let mut dir = std::path::absolute(base).unwrap();
    let mut i = 0;
    while dir.as_os_str().len() <= min_len {
        dir.push(format!("很长的文件夹名称_{i:02}_abcdefghijklmnopqrstuvwxyz"));
        i += 1;
    }
    dir
}

#[test]
fn files_and_libraries_deeper_than_260_characters_import_and_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let src = deep_dir(&dir.path().join("来源"), 300);
    let file = write_png_long(&src.join("长路径里的图.png"), 9);
    assert!(file.as_os_str().len() > 260);
    // 资料库本身也放在超过 260 个字符的位置。
    let root = deep_dir(&dir.path().join("库"), 270);

    let library = Library::create(&root, "深处的库").unwrap();
    let report = import(&library, std::slice::from_ref(&src));
    let ImportOutcome::Imported { image_id } = &report.items[0].outcome else {
        panic!("{:?}", report.items[0].outcome)
    };
    let original = library.original_path(image_id).unwrap();
    assert!(original.as_os_str().len() > 260);
    assert_eq!(
        std::fs::read(&original).unwrap(),
        std::fs::read(&file).unwrap()
    );
    library.thumbnail(image_id, 256).unwrap();
    drop(library);

    let reopened = Library::open(&root).unwrap();
    assert_eq!(count(&reopened), 1);
}

/// `image::save` 不一定支持长路径，先编码到内存再用标准库写。
fn write_png_long(path: &Path, seed: u8) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut bytes = Vec::new();
    RgbaImage::from_fn(12, 8, |x, y| image::Rgba([seed, x as u8, y as u8, 255]))
        .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
        .unwrap();
    std::fs::write(path, bytes).unwrap();
    path.to_path_buf()
}

#[test]
fn importing_the_same_bytes_twice_keeps_one_image_with_both_sources() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let first = write_png(&dir.path().join("下载/原图.png"), 7);
    let second = dir.path().join("另一处/复制的.png");
    std::fs::create_dir_all(second.parent().unwrap()).unwrap();
    std::fs::copy(&first, &second).unwrap();

    let a = import(&library, std::slice::from_ref(&first));
    let b = import(&library, std::slice::from_ref(&second));

    let ImportOutcome::Imported { image_id } = &a.items[0].outcome else {
        panic!("{:?}", a.items[0].outcome)
    };
    assert_eq!(
        b.items[0].outcome,
        ImportOutcome::Merged {
            image_id: image_id.clone()
        }
    );
    assert_eq!(count(&library), 1);
    let mut locations: Vec<PathBuf> = library
        .image_sources(image_id)
        .unwrap()
        .into_iter()
        .map(|s| s.location)
        .collect();
    locations.sort();
    let mut expected = vec![
        std::path::absolute(&first).unwrap(),
        std::path::absolute(&second).unwrap(),
    ];
    expected.sort();
    assert_eq!(locations, expected);
}
