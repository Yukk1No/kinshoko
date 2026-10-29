//! 占位图存在资料库里（#313）。过渡期（expand）：同时仍存成文件，不改资料库的版本号，旧版本照样
//! 能打开；旧资料库打开后把文件读进库里，文件留着；永久删除原图时两处一并删掉。读写数据库文件检查
//! 存储、模拟旧格式，其余经 `Library` 的对外接口。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use image::{Rgba, RgbaImage};
use kinshoko_core::Library;
use kinshoko_core::library::{BrowseQuery, ImageCard, ImageEdit, ImportSource};
use kinshoko_core::reference_groups::{GroupError, GroupUsage, ReferenceGroupUsage};

fn import(library: &Library, dir: &Path, seed: u8) -> String {
    let path = dir.join(format!("{seed}.png"));
    RgbaImage::from_fn(60 + u32::from(seed), 40, |x, y| {
        Rgba([seed, x as u8, y as u8, 255])
    })
    .save(&path)
    .unwrap();
    library
        .import(ImportSource { paths: vec![path] })
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

fn db(root: &Path) -> rusqlite::Connection {
    rusqlite::Connection::open(root.join("library.sqlite")).unwrap()
}

/// 库里存的占位图：SHA-256 → (内容类型, 字节)。
fn stored(root: &Path) -> BTreeMap<String, (String, Vec<u8>)> {
    let conn = db(root);
    let mut stmt = conn
        .prepare("SELECT sha256, mime, bytes FROM placeholder")
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// 缓存目录里的占位图文件（#313 之前的存法）。
fn placeholder_files(root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.to_string_lossy().contains("-p32.") {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    walk(&root.join("cache"), &mut out);
    out
}

fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !done() {
        assert!(std::time::Instant::now() < deadline, "{what}");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

fn user_version(root: &Path) -> i64 {
    db(root)
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn imported_placeholders_are_stored_in_the_database_and_still_as_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    let library = Library::create(&root, "库").unwrap();
    import(&library, dir.path(), 1);
    import(&library, dir.path(), 2);

    assert_eq!(stored(&root).len(), 2);
    assert_eq!(placeholder_files(&root).len(), 2, "过渡期仍存文件");
    assert!(cards(&library).iter().all(|c| c.placeholder.is_some()));
}

/// #313 之前的资料库：占位图只有 `cache/thumbs/<管线>/sdr/<前两位>/<sha>-p32.<webp|png>` 文件，没有
/// `placeholder` 表。只读打开照样能浏览（从文件读）；打开后后台把文件原样读进库里，文件留着，
/// 版本号不变，旧版本仍能打开。
#[test]
fn a_library_from_before_the_table_stays_compatible_and_imports_its_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    let library = Library::create(&root, "库").unwrap();
    let library_id = library.info().id.clone();
    for seed in 0..3 {
        import(&library, dir.path(), seed);
    }
    drop(library);

    // 退回旧格式：占位图只有文件（导入时已同时存了，这里照旧格式再写一遍），去掉表。
    let before = stored(&root);
    assert_eq!(before.len(), 3);
    let sdr = std::fs::read_dir(root.join("cache/thumbs"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
        .join("sdr");
    for (sha, (mime, bytes)) in &before {
        let ext = if mime == "image/png" { "png" } else { "webp" };
        let file = sdr.join(&sha[..2]).join(format!("{sha}-p32.{ext}"));
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, bytes).unwrap();
    }
    db(&root).execute_batch("DROP TABLE placeholder;").unwrap();
    let version = user_version(&root);
    assert_eq!(placeholder_files(&root).len(), 3);
    let read_only = Library::open_read_only(&root, &library_id).unwrap();
    assert!(cards(&read_only).iter().all(|c| c.placeholder.is_some()));
    drop(read_only);

    let library = Library::open(&root).unwrap();
    wait_until("旧文件读进库里", || stored(&root).len() == 3);
    assert_eq!(placeholder_files(&root).len(), 3, "文件留着");
    assert_eq!(user_version(&root), version, "不改版本号，旧版本照样能打开");
    assert_eq!(stored(&root), before, "原样读进来，不重新生成");
    for card in cards(&library) {
        let url = card.placeholder.expect("有占位图");
        let (_, payload) = url.split_once(";base64,").unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload)
            .unwrap();
        assert!(before.values().any(|(_, b)| *b == bytes));
    }
}

struct NoGroups;

impl ReferenceGroupUsage for NoGroups {
    fn groups_using(&self, _: &str, _: &[String]) -> Result<Vec<GroupUsage>, GroupError> {
        Ok(Vec::new())
    }
}

#[test]
fn permanently_deleting_an_image_removes_its_placeholder() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    let library = Library::create(&root, "库").unwrap();
    let gone = vec![import(&library, dir.path(), 1)];
    import(&library, dir.path(), 2);
    assert_eq!(stored(&root).len(), 2);

    library.edit(&gone, &[ImageEdit::Delete]).unwrap();
    let preview = library.preview_permanent_delete(&gone, &NoGroups).unwrap();
    library
        .permanent_delete(&gone, &preview.token, &NoGroups)
        .unwrap();

    assert_eq!(stored(&root).len(), 1);
    assert_eq!(placeholder_files(&root).len(), 1);
    assert!(cards(&library)[0].placeholder.is_some());
}
