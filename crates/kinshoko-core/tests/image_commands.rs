//! 复制图片、在资源管理器中显示、从剪贴板导入（#102 T3，#105）：经 Library 的对外接口，用真库、真文件。
//! 应用壳只把这里给出的像素放进剪贴板、把这里给出的路径交给资源管理器、把这里写出的文件交给导入。

use std::path::Path;

use image::{Rgba, RgbaImage};
use kinshoko_core::Library;
use kinshoko_core::library::{
    ContentRating, Error, ImageEdit, ImportOutcome, ImportSource, forget_staged_clipboard_images,
    stage_clipboard_image,
};

fn import(library: &Library, path: &Path) -> String {
    let report = library
        .import(ImportSource {
            paths: vec![path.to_owned()],
        })
        .wait();
    match &report.items[0].outcome {
        ImportOutcome::Imported { image_id } => image_id.clone(),
        other => panic!("未导入：{other:?}"),
    }
}

/// 一张带半透明的图：每个像素都不同，复制后能逐像素核对。
fn sample(width: u32, height: u32) -> RgbaImage {
    RgbaImage::from_fn(width, height, |x, y| {
        Rgba([
            (x * 7 % 256) as u8,
            (y * 11 % 256) as u8,
            ((x + y) % 256) as u8,
            (90 + x % 3 * 80) as u8,
        ])
    })
}

fn library_with(image: &RgbaImage, name: &str) -> (tempfile::TempDir, Library, String) {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("参考"), "参考").unwrap();
    let input = dir.path().join(name);
    image.save(&input).unwrap();
    let id = import(&library, &input);
    (dir, library, id)
}

fn seal(library: &Library, id: &str) {
    library
        .edit(
            &[id.to_owned()],
            &[ImageEdit::SetRating {
                rating: ContentRating::Explicit,
            }],
        )
        .unwrap();
    library.set_safe_mode(true);
}

// ── 复制图片 ──

#[test]
fn copying_gives_the_original_pixels_at_full_size() {
    let original = sample(40, 24);
    let (_dir, library, id) = library_with(&original, "半透明.png");
    let copied = library.clipboard_pixels(&id).unwrap();
    assert_eq!(copied.dimensions(), (40, 24));
    assert_eq!(copied, original, "原图像素，不是缩略图或屏幕像素");
}

#[test]
fn copying_an_unknown_or_sealed_image_fails() {
    let (_dir, library, id) = library_with(&sample(8, 8), "a.png");
    assert!(matches!(
        library.clipboard_pixels("没有这张"),
        Err(Error::UnknownImage)
    ));
    seal(&library, &id);
    assert!(matches!(
        library.clipboard_pixels(&id),
        Err(Error::UnknownImage)
    ));
}

#[test]
fn copying_when_the_original_file_is_gone_names_the_missing_file() {
    let (_dir, library, id) = library_with(&sample(8, 8), "a.png");
    let path = library.original_path(&id).unwrap();
    std::fs::remove_file(&path).unwrap();
    match library.clipboard_pixels(&id) {
        Err(Error::OriginalMissing(missing)) => assert_eq!(missing, path),
        other => panic!("应报告原文件缺失：{other:?}"),
    }
}

// ── 在资源管理器中显示 ──

#[test]
fn revealing_gives_the_existing_original_inside_the_library() {
    let (_dir, library, id) = library_with(&sample(8, 8), "a.png");
    let path = library.reveal_original(&id).unwrap();
    assert!(path.is_file());
    assert!(path.starts_with(library.info().root.clone()));
    assert_eq!(path, library.original_path(&id).unwrap());
}

#[test]
fn revealing_a_missing_file_reports_it_instead_of_failing_silently() {
    let (_dir, library, id) = library_with(&sample(8, 8), "a.png");
    let path = library.original_path(&id).unwrap();
    std::fs::remove_file(&path).unwrap();
    let error = library.reveal_original(&id).unwrap_err();
    assert!(matches!(&error, Error::OriginalMissing(missing) if *missing == path));
    let message = error.to_string();
    assert!(message.contains("原文件不在了"), "{message}");
}

#[test]
fn revealing_an_unknown_or_sealed_image_fails() {
    let (_dir, library, id) = library_with(&sample(8, 8), "a.png");
    assert!(matches!(
        library.reveal_original("没有这张"),
        Err(Error::UnknownImage)
    ));
    seal(&library, &id);
    assert!(matches!(
        library.reveal_original(&id),
        Err(Error::UnknownImage)
    ));
}

// ── 从剪贴板导入 ──

#[test]
fn a_clipboard_image_is_staged_as_a_lossless_png_that_imports_normally() {
    let dir = tempfile::tempdir().unwrap();
    let staging = dir.path().join("clipboard-import");
    let pasted = sample(30, 20);
    let path = stage_clipboard_image(&staging, &pasted).unwrap();
    assert!(path.starts_with(&staging));
    assert_eq!(path.extension().unwrap(), "png");
    assert_eq!(image::open(&path).unwrap().to_rgba8(), pasted);

    // 走普通导入：进库的原图就是剪贴板里的像素。
    let library = Library::create(&dir.path().join("参考"), "参考").unwrap();
    let id = import(&library, &path);
    assert_eq!(library.clipboard_pixels(&id).unwrap(), pasted);
}

#[test]
fn each_paste_gets_its_own_file() {
    let dir = tempfile::tempdir().unwrap();
    let first = stage_clipboard_image(dir.path(), &sample(4, 4)).unwrap();
    let second = stage_clipboard_image(dir.path(), &sample(5, 5)).unwrap();
    assert_ne!(first, second);
    assert_eq!(
        image::open(&second).unwrap().to_rgba8().dimensions(),
        (5, 5)
    );
}

#[test]
fn staged_clipboard_images_older_than_a_day_are_cleaned_without_another_paste() {
    // 画师取消了保存位置、或之后再没粘贴过：启动时单独清理，一天前暂存的图不会一直留着。
    let dir = tempfile::tempdir().unwrap();
    let staging = dir.path().join("clipboard-import");
    let old = stage_clipboard_image(&staging, &sample(4, 4)).unwrap();
    let fresh = stage_clipboard_image(&staging, &sample(5, 5)).unwrap();
    let two_days_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(48 * 60 * 60);
    std::fs::File::options()
        .write(true)
        .open(&old)
        .unwrap()
        .set_modified(two_days_ago)
        .unwrap();

    forget_staged_clipboard_images(&staging);
    assert!(!old.exists(), "一天前暂存的剪贴板图片被清掉");
    assert!(fresh.exists(), "刚暂存的（可能还要重试导入）留着");

    // 暂存目录还不存在（从没粘贴过）时什么也不做。
    forget_staged_clipboard_images(&dir.path().join("不存在"));
}

#[test]
fn an_empty_clipboard_image_is_not_staged() {
    let dir = tempfile::tempdir().unwrap();
    let staging = dir.path().join("clipboard-import");
    assert!(matches!(
        stage_clipboard_image(&staging, &RgbaImage::new(0, 0)),
        Err(Error::ClipboardImage(_))
    ));
    assert!(
        !staging.exists() || std::fs::read_dir(&staging).unwrap().next().is_none(),
        "失败时不留下文件"
    );
}
