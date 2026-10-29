//! 工作区（全部图片）浏览页里的缩略图地址与占位图（#200、#313）。

use image::{Rgba, RgbaImage};
use kinshoko_core::DeviceLibraries;
use kinshoko_core::library::ImportSource;
use kinshoko_core::tag_catalog::TagCatalog;
use kinshoko_core::workspace::{Workspace, WorkspaceQuery, WorkspaceScope};

fn query(known: Vec<String>) -> WorkspaceQuery {
    WorkspaceQuery {
        scope: WorkspaceScope::All,
        conditions: Default::default(),
        cursor: None,
        limit: 10,
        known_placeholders: known,
    }
}

/// 卡片不带缩略图地址：界面按显示用的来源与档位拼（`<资料库 id>/<参考图 id>/<档位>`），换档位不必
/// 重新浏览。占位图按内容寻址、永远不变：请求时报为已有的卡片不再带，其余照常带。
#[test]
fn known_placeholders_are_not_sent_again() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let library = device.create(&dir.path().join("a"), "A").unwrap();
    for red in [12, 34] {
        let file = dir.path().join(format!("{red}.png"));
        RgbaImage::from_pixel(4, 3, Rgba([red, 34, 56, 255]))
            .save(&file)
            .unwrap();
        library.import(ImportSource { paths: vec![file] }).wait();
    }
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();

    let first = workspace
        .browse(&device, &mut catalog, &query(Vec::new()), true)
        .unwrap();
    assert_eq!(first.cards.len(), 2);
    assert!(first.cards.iter().all(|c| c.placeholder.is_some()));
    for card in &first.cards {
        assert_eq!(card.library_id, library.info().id);
        let shown = workspace
            .card(
                &device,
                &mut catalog,
                &card.library_id,
                &card.image_id,
                true,
            )
            .unwrap();
        assert_eq!(shown.placeholder, card.placeholder, "单张卡片照常带占位图");
    }

    let known = first.cards[0].id.clone();
    let again = workspace
        .browse(&device, &mut catalog, &query(vec![known.clone()]), true)
        .unwrap();
    for card in &again.cards {
        assert_eq!(card.placeholder.is_none(), card.id == known, "{}", card.id);
    }
}
