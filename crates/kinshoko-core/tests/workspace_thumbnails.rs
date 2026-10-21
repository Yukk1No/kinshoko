//! 工作区（全部图片）浏览返回的缩略图地址（#200）。

use image::{Rgba, RgbaImage};
use kinshoko_core::DeviceLibraries;
use kinshoko_core::library::ImportSource;
use kinshoko_core::tag_catalog::TagCatalog;
use kinshoko_core::workspace::{Workspace, WorkspaceQuery, WorkspaceScope};

/// 缩略图地址按档位取整，与单库浏览相同：图片墙缩放时请求的像素在同一档位内变化，
/// 卡片的地址不变，WebView 不必把已显示的缩略图全部重新请求一遍。
#[test]
fn thumbnail_addresses_round_to_the_tier_like_library_browse() {
    let dir = tempfile::tempdir().unwrap();
    let mut device = DeviceLibraries::open(&dir.path().join("app")).unwrap();
    let library = device.create(&dir.path().join("a"), "A").unwrap();
    let file = dir.path().join("one.png");
    RgbaImage::from_pixel(4, 3, Rgba([12, 34, 56, 255]))
        .save(&file)
        .unwrap();
    let id = library
        .import(ImportSource { paths: vec![file] })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();
    let library_id = library.info().id.clone();
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    let mut workspace = Workspace::open(&dir.path().join("app")).unwrap();
    for px in [360, 375] {
        let page = workspace
            .browse(
                &device,
                &mut catalog,
                &WorkspaceQuery {
                    scope: WorkspaceScope::All,
                    conditions: Default::default(),
                    cursor: None,
                    limit: 1,
                    thumbnail_px: px,
                },
                true,
            )
            .unwrap();
        assert_eq!(page.cards[0].thumbnail, format!("{library_id}/{id}/384"));
        let card = workspace
            .card(&device, &mut catalog, &library_id, &id, true, px)
            .unwrap();
        assert_eq!(card.thumbnail, format!("{library_id}/{id}/384"));
    }
}
