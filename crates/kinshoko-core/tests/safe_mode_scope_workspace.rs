//! 安全模式范围（#223）在工作区（全部资料库）里：范围是本设备的设置，设给 `DeviceLibraries`，
//! 可写句柄、只读打开的句柄与工作区快照都按它；改范围后工作区修订号变化，旧游标作废。

use image::{Rgba, RgbaImage};
use kinshoko_core::library::{ContentRating, ImageEdit, ImportSource, SafeModeScope};
use kinshoko_core::tag_catalog::TagCatalog;
use kinshoko_core::workspace::{Workspace, WorkspaceQuery, WorkspaceScope};
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

fn file(dir: &std::path::Path, red: u8) -> std::path::PathBuf {
    let path = dir.join(format!("{red}.png"));
    RgbaImage::from_pixel(4, 3, Rgba([red, 34, 56, 255]))
        .save(&path)
        .unwrap();
    path
}

fn set_rating(library: &Library, id: &str, rating: ContentRating) {
    library.set_safe_mode(false);
    library
        .edit(&[id.to_owned()], &[ImageEdit::SetRating { rating }])
        .unwrap();
    library.set_safe_mode(true);
}

fn query(limit: u32, cursor: Option<String>) -> WorkspaceQuery {
    WorkspaceQuery {
        scope: WorkspaceScope::All,
        conditions: Default::default(),
        cursor,
        limit,
        thumbnail_px: 256,
    }
}

#[test]
fn the_workspace_seals_by_the_device_scope_and_expires_cursors_when_it_changes() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    // 同一张图在两个库：A 没分级，B 分为轻度。另有 A 里分为敏感的一张、没分级的一张。
    let shared = file(dir.path(), 10);
    import(&a, &shared);
    let shared_b = import(&b, &shared);
    set_rating(&b, &shared_b, ContentRating::Sensitive);
    let questionable = import(&a, &file(dir.path(), 20));
    set_rating(&a, &questionable, ContentRating::Questionable);
    import(&a, &file(dir.path(), 30));

    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let total = |workspace: &mut Workspace, device: &DeviceLibraries, catalog: &mut TagCatalog| {
        workspace
            .browse(device, catalog, &query(100, None), true)
            .unwrap()
            .total
    };
    assert_eq!(device.safe_mode_scope(), SafeModeScope::Questionable);
    assert_eq!(
        total(&mut workspace, &device, &mut catalog),
        2,
        "默认：敏感被封印"
    );

    let first = workspace
        .browse(&device, &mut catalog, &query(1, None), true)
        .unwrap();
    let cursor = first.next_cursor.expect("还有下一页");
    let before = workspace
        .status(&device, &mut catalog, true)
        .unwrap()
        .revision;

    device
        .set_safe_mode_scope(SafeModeScope::Sensitive)
        .unwrap();
    assert_eq!(
        b.safe_mode_scope(),
        SafeModeScope::Sensitive,
        "开着的可写句柄跟着设置"
    );
    assert_ne!(
        workspace
            .status(&device, &mut catalog, true)
            .unwrap()
            .revision,
        before,
        "范围变了，工作区修订号也变"
    );
    assert!(
        workspace
            .browse(&device, &mut catalog, &query(1, Some(cursor)), true)
            .is_err(),
        "旧游标作废"
    );
    assert_eq!(
        total(&mut workspace, &device, &mut catalog),
        1,
        "轻度及以上：另一个库里分为轻度的同一张图也被封印"
    );

    device.set_safe_mode_scope(SafeModeScope::Explicit).unwrap();
    assert_eq!(total(&mut workspace, &device, &mut catalog), 3, "仅成人");

    // 安全模式关着：卡片标出当前范围会封印哪些图。
    device
        .set_safe_mode_scope(SafeModeScope::Sensitive)
        .unwrap();
    let page = workspace
        .browse(&device, &mut catalog, &query(100, None), false)
        .unwrap();
    assert_eq!(page.total, 3);
    assert_eq!(page.cards.iter().filter(|c| c.adult).count(), 2);
}

#[test]
fn libraries_opened_later_and_read_only_handles_follow_the_device_scope() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    device.set_safe_mode_scope(SafeModeScope::Explicit).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    assert_eq!(a.safe_mode_scope(), SafeModeScope::Explicit);
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    assert_eq!(b.safe_mode_scope(), SafeModeScope::Explicit);
    let reader = device.resolve(&a.info().id, true).unwrap();
    assert_eq!(reader.safe_mode_scope(), SafeModeScope::Explicit);
    let reader = device.read(&a.info().id).unwrap();
    assert_eq!(reader.safe_mode_scope(), SafeModeScope::Explicit);
}
