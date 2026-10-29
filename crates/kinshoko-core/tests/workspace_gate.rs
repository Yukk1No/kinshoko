//! 缩略图请求的放行（#313）：按工作区发布的快照判断，不拿全局锁、不重开资料库。快照不能代表
//! 现在时交还慢路（`None`），被封印的图绝不放行。全部经对外接口，用临时目录里的真 SQLite。

use std::sync::Arc;

use image::{Rgba, RgbaImage};
use kinshoko_core::library::{ContentRating, ImageEdit, ImportSource, SafeModeScope};
use kinshoko_core::tag_catalog::TagCatalog;
use kinshoko_core::workspace::{ImageGate, Workspace, WorkspaceQuery, WorkspaceScope};
use kinshoko_core::{DeviceLibraries, Library};

fn import(library: &Library, path: &std::path::Path) -> String {
    library
        .import(ImportSource {
            paths: vec![path.into()],
        })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned()
}

fn png(dir: &std::path::Path, red: u8) -> std::path::PathBuf {
    let path = dir.join(format!("{red}.png"));
    RgbaImage::from_pixel(4, 3, Rgba([red, 34, 56, 255]))
        .save(&path)
        .unwrap();
    path
}

fn rate(library: &Library, id: &str, rating: ContentRating) {
    library.set_safe_mode(false);
    library
        .edit(&[id.to_owned()], &[ImageEdit::SetRating { rating }])
        .unwrap();
}

/// 取一次快照（浏览），快照随之发布给放行。
fn refresh(workspace: &mut Workspace, device: &DeviceLibraries, catalog: &mut TagCatalog) {
    workspace
        .browse(
            device,
            catalog,
            &WorkspaceQuery {
                scope: WorkspaceScope::All,
                conditions: Default::default(),
                cursor: None,
                limit: 10,
                known_placeholders: Vec::new(),
            },
            false,
        )
        .unwrap();
}

const SCOPE: SafeModeScope = SafeModeScope::Questionable;

fn allowed(gate: &ImageGate, library: &Library, id: &str, safe: bool) -> Option<bool> {
    gate.authorize(&library.info().id, id, safe, SCOPE)
        .map(|r| r.is_ok())
}

#[test]
fn the_published_snapshot_authorizes_without_the_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let id = import(&a, &png(dir.path(), 1));
    let mut catalog = TagCatalog::open(&app).unwrap();
    let gate = Arc::new(ImageGate::default());
    assert_eq!(allowed(&gate, &a, &id, true), None, "还没有发布快照");

    let mut workspace = Workspace::open_with_gate(&app, gate.clone()).unwrap();
    refresh(&mut workspace, &device, &mut catalog);
    assert_eq!(allowed(&gate, &a, &id, true), Some(true));
    assert_eq!(
        allowed(&gate, &a, "no-such-image", true),
        Some(false),
        "不认识的图不放行"
    );
    let library = gate
        .authorize(&a.info().id, &id, true, SCOPE)
        .unwrap()
        .unwrap();
    assert!(library.thumbnail(&id, 128).is_ok());
    assert_eq!(
        allowed(&gate, &a, &id, true).map(|_| ()),
        allowed(&gate, &a, &id, true).map(|_| ()),
        "放行不改变任何状态"
    );
}

#[test]
fn a_seal_after_publishing_is_never_authorized_from_the_stale_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    // 同一份字节在两个库里：另一个库给它打成年分级，也封印这一份（全局否决）。
    let path = png(dir.path(), 2);
    let in_a = import(&a, &path);
    let in_b = import(&b, &path);
    let mut catalog = TagCatalog::open(&app).unwrap();
    let gate = Arc::new(ImageGate::default());
    let mut workspace = Workspace::open_with_gate(&app, gate.clone()).unwrap();
    refresh(&mut workspace, &device, &mut catalog);
    assert_eq!(allowed(&gate, &a, &in_a, true), Some(true));

    rate(&b, &in_b, ContentRating::Explicit);
    assert_eq!(
        allowed(&gate, &a, &in_a, true),
        None,
        "修订号变了：交还慢路，不按旧快照放行"
    );

    refresh(&mut workspace, &device, &mut catalog);
    assert_eq!(allowed(&gate, &a, &in_a, true), Some(false));
    assert_eq!(
        allowed(&gate, &a, &in_a, false),
        Some(true),
        "安全模式关着照常给"
    );
    assert_eq!(
        gate.authorize(&a.info().id, &in_a, true, SafeModeScope::Explicit)
            .map(|r| r.is_ok()),
        None,
        "安全模式范围与快照的不同：交还慢路"
    );
}

#[test]
fn a_registry_change_after_publishing_falls_back_to_the_locked_path() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let id = import(&a, &png(dir.path(), 3));
    let mut catalog = TagCatalog::open(&app).unwrap();
    let gate = Arc::new(ImageGate::default());
    let mut workspace = Workspace::open_with_gate(&app, gate.clone()).unwrap();
    refresh(&mut workspace, &device, &mut catalog);
    assert_eq!(allowed(&gate, &a, &id, true), Some(true));

    let a_id = a.info().id.clone();
    device.unregister(&a_id).unwrap();
    assert_eq!(
        gate.authorize(&a_id, &id, true, SCOPE).map(|r| r.is_ok()),
        None
    );
    refresh(&mut workspace, &device, &mut catalog);
    assert_eq!(
        gate.authorize(&a_id, &id, true, SCOPE).map(|r| r.is_ok()),
        Some(false),
        "取消登记的库不再放行"
    );

    gate.clear();
    assert_eq!(
        gate.authorize(&a_id, &id, true, SCOPE).map(|r| r.is_ok()),
        None
    );
}
