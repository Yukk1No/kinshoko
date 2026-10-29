//! 占位图存在资料库里（#313）：不另存文件；#313 之前存成文件的旧资料库升级后读进库里再删掉文件；
//! 永久删除原图时一并删掉。读写数据库文件检查存储、模拟旧格式，其余经 `Library` 的对外接口。

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

#[test]
fn imported_placeholders_live_in_the_library_database_not_in_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    let library = Library::create(&root, "库").unwrap();
    import(&library, dir.path(), 1);
    import(&library, dir.path(), 2);

    assert_eq!(stored(&root).len(), 2);
    assert_eq!(placeholder_files(&root), Vec::<PathBuf>::new());
    assert!(cards(&library).iter().all(|c| c.placeholder.is_some()));
}

/// #313 之前的资料库：占位图是 `cache/thumbs/<管线>/sdr/<前两位>/<sha>-p32.<webp|png>` 文件，没有
/// `placeholder` 表。只读打开要先升级；打开（升级）后后台把这些文件原样读进库里，再删掉文件。
#[test]
fn a_library_from_before_the_move_imports_its_placeholder_files_once() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    let library = Library::create(&root, "库").unwrap();
    let library_id = library.info().id.clone();
    for seed in 0..3 {
        import(&library, dir.path(), seed);
    }
    drop(library);

    // 退回旧格式：占位图写成升级前的文件，去掉表，版本号退一。
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
    {
        let conn = db(&root);
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        conn.execute_batch(&format!(
            "DROP TABLE placeholder; PRAGMA user_version = {};",
            version - 1
        ))
        .unwrap();
    }
    assert_eq!(placeholder_files(&root).len(), 3);
    assert!(matches!(
        Library::open_read_only(&root, &library_id),
        Err(kinshoko_core::library::Error::OutdatedLibrary)
    ));

    let library = Library::open(&root).unwrap();
    wait_until("旧文件读进库里并删掉", || {
        placeholder_files(&root).is_empty() && stored(&root).len() == 3
    });
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
    assert!(cards(&library)[0].placeholder.is_some());
}
