//! 占位图（#110）：导入时生成约 32 px 的极小 `sdr` 派生图，随浏览页一起返回。
//! 全部通过 `Library` 与 `Workspace` 的对外接口，用临时目录里的真 SQLite 与真文件。

use std::path::{Path, PathBuf};

use base64::Engine;
use image::{Rgba, RgbaImage};
use kinshoko_core::Library;
use kinshoko_core::library::{BrowseQuery, ImageCard, ImportSource};

fn write_png(path: &Path, w: u32, h: u32, seed: u8) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    RgbaImage::from_fn(w, h, |x, y| Rgba([seed, x as u8, y as u8, 255]))
        .save(path)
        .unwrap();
    path.to_path_buf()
}

fn import(library: &Library, path: &Path) -> String {
    library
        .import(ImportSource {
            paths: vec![path.to_path_buf()],
        })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned()
}

fn cards(library: &Library) -> Vec<ImageCard> {
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

/// `data:<mime>;base64,<字节>` → (mime, 字节)。
fn data_url(url: &str) -> (String, Vec<u8>) {
    let rest = url.strip_prefix("data:").expect("data URL");
    let (mime, payload) = rest.split_once(";base64,").expect("base64 data URL");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .unwrap();
    (mime.to_owned(), bytes)
}

#[test]
fn an_imported_image_is_browsed_with_a_tiny_placeholder_of_the_same_shape() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let id = import(
        &library,
        &write_png(&dir.path().join("wide.png"), 400, 200, 7),
    );

    let card = cards(&library).into_iter().find(|c| c.id == id).unwrap();
    let (mime, bytes) = data_url(card.placeholder.as_deref().expect("有占位图"));
    assert_eq!(mime, "image/webp");
    let placeholder = image::load_from_memory(&bytes).unwrap();
    assert_eq!((placeholder.width(), placeholder.height()), (32, 16));
}

/// 派生图字节的格式、颜色类型与嵌入的 ICC。
fn container_of(bytes: &[u8]) -> (image::ImageFormat, image::ColorType, Option<Vec<u8>>) {
    use image::ImageDecoder;
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .unwrap();
    let format = reader.format().unwrap();
    let mut decoder = reader.into_decoder().unwrap();
    (format, decoder.color_type(), decoder.icc_profile().unwrap())
}

/// 按存储编码值（0～1）求各通道平均，不做色彩转换：同一 ICC 下可以直接比较。
fn mean(bytes: &[u8]) -> [f32; 3] {
    let image = image::load_from_memory(bytes).unwrap().into_rgb32f();
    let n = (image.width() * image.height()) as f32;
    let mut sum = [0f32; 3];
    for p in image.pixels() {
        for (s, v) in sum.iter_mut().zip(p.0) {
            *s += v;
        }
    }
    sum.map(|s| s / n)
}

#[test]
fn a_placeholder_is_colour_managed_like_the_thumbnail() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let mut failures = Vec::new();
    for sample in kinshoko_core::fidelity::gate::samples() {
        let path = dir.path().join("samples").join(&sample.file_name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &sample.bytes).unwrap();
        let id = import(&library, &path);
        let card = cards(&library).into_iter().find(|c| c.id == id).unwrap();
        let (mime, placeholder) = data_url(card.placeholder.as_deref().expect("有占位图"));
        let thumbnail = std::fs::read(library.thumbnail(&id, 128).unwrap()).unwrap();

        let ours = container_of(&placeholder);
        assert_eq!(mime, ours.0.to_mime_type(), "{}", sample.file_name);
        if ours != container_of(&thumbnail) {
            failures.push(format!("{}：容器或 ICC 与缩略图不同", sample.file_name));
        }
        let (a, b) = (mean(&placeholder), mean(&thumbnail));
        if a.iter().zip(b).any(|(x, y)| (x - y).abs() > 0.03) {
            failures.push(format!("{}：平均色 {a:?}／缩略图 {b:?}", sample.file_name));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

/// 已有资料库里缺占位图的图：浏览先给空（界面退回中性底色），打开资料库后在后台补齐。
#[test]
fn opening_a_library_fills_in_missing_placeholders_in_the_background() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    let library = Library::create(&root, "库").unwrap();
    let library_id = library.info().id.clone();
    let ids: Vec<String> = (0..3)
        .map(|i| {
            import(
                &library,
                &write_png(&dir.path().join(format!("{i}.png")), 64, 48, i),
            )
        })
        .collect();
    drop(library);
    std::fs::remove_dir_all(root.join("cache")).unwrap();

    let before = Library::open_read_only(&root, &library_id).unwrap();
    assert!(cards(&before).iter().all(|c| c.placeholder.is_none()));
    drop(before);

    let library = Library::open(&root).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let filled = cards(&library)
            .iter()
            .filter(|c| c.placeholder.is_some())
            .count();
        if filled == ids.len() {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "只补齐了 {filled} 张");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// 全部图片（工作区）的浏览页同样带回占位图，不需要逐卡片另取。
#[test]
fn workspace_cards_carry_the_placeholder_of_their_display_source() {
    use kinshoko_core::DeviceLibraries;
    use kinshoko_core::tag_catalog::TagCatalog;
    use kinshoko_core::workspace::{Workspace, WorkspaceQuery, WorkspaceScope};

    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    import(&a, &write_png(&dir.path().join("a.png"), 40, 80, 1));
    import(&b, &write_png(&dir.path().join("b.png"), 80, 40, 2));
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();

    let page = workspace
        .browse(
            &device,
            &mut catalog,
            &WorkspaceQuery {
                scope: WorkspaceScope::All,
                conditions: Default::default(),
                cursor: None,
                limit: 100,
                thumbnail_px: 256,
            },
            true,
        )
        .unwrap();
    assert_eq!(page.cards.len(), 2);
    for card in &page.cards {
        let (_, bytes) = data_url(card.placeholder.as_deref().expect("有占位图"));
        let placeholder = image::load_from_memory(&bytes).unwrap();
        let expected = if card.width < card.height {
            (16, 32)
        } else {
            (32, 16)
        };
        assert_eq!((placeholder.width(), placeholder.height()), expected);
    }
}

/// 管线版本是缓存键的一部分：旧版本目录里的占位图不再使用。
#[test]
fn placeholders_of_an_older_pipeline_version_are_not_shown() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    let library = Library::create(&root, "库").unwrap();
    let library_id = library.info().id.clone();
    import(&library, &write_png(&dir.path().join("a.png"), 64, 48, 1));
    assert!(cards(&library)[0].placeholder.is_some());
    drop(library);

    let thumbs = root.join("cache/thumbs");
    let current = std::fs::read_dir(&thumbs)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    std::fs::rename(current, thumbs.join("v0")).unwrap();

    let library = Library::open_read_only(&root, &library_id).unwrap();
    assert!(cards(&library)[0].placeholder.is_none());
}
