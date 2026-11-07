//! 图片墙上同一图集叠成一摞（#418）：浏览时按来源认出图集，每个图集占一格。

use image::{Rgba, RgbaImage};
use kinshoko_core::library::{
    BrowseScope, ContentRating, ImageEdit, ImportSource, SubscriptionPage,
};
use kinshoko_core::tag_catalog::TagCatalog;
use kinshoko_core::workspace::{Workspace, WorkspaceCard, WorkspaceQuery, WorkspaceScope};
use kinshoko_core::{DeviceLibraries, Library};

fn png(seed: u8) -> Vec<u8> {
    let mut bytes = Vec::new();
    RgbaImage::from_pixel(4, 3 + u32::from(seed % 3), Rgba([seed, 34, 56, 255]))
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}

fn subscription_page(work: &str, page: u32) -> SubscriptionPage {
    SubscriptionPage {
        source: "pixiv".into(),
        work_id: work.into(),
        page,
        original_name: format!("{work}_p{page}.png"),
        page_url: format!("https://www.pixiv.net/artworks/{work}"),
        author: None,
        tags: Vec::new(),
        explicit: false,
        collected_at: 1_700_000_000_000,
    }
}

fn plain(library: &Library, dir: &std::path::Path, seed: u8) -> String {
    let path = dir.join(format!("plain_{seed}.png"));
    std::fs::write(&path, png(seed)).unwrap();
    library
        .import(ImportSource { paths: vec![path] })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned()
}

fn query(stack_sets: bool) -> WorkspaceQuery {
    WorkspaceQuery {
        scope: WorkspaceScope::All,
        conditions: Default::default(),
        cursor: None,
        limit: 100,
        known_placeholders: Vec::new(),
        stack_sets,
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    device: DeviceLibraries,
    catalog: TagCatalog,
    workspace: Workspace,
    library: std::sync::Arc<Library>,
}

impl Fixture {
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("app");
        let mut device = DeviceLibraries::open(&app).unwrap();
        let library = device.create(&dir.path().join("a"), "A").unwrap();
        Fixture {
            catalog: TagCatalog::open(&app).unwrap(),
            workspace: Workspace::open(&app).unwrap(),
            device,
            library,
            dir,
        }
    }

    fn collect(&self, work: &str, page: u32, seed: u8) -> String {
        self.library
            .import_from_subscription(subscription_page(work, page), &png(seed))
            .unwrap()
    }

    fn browse(&mut self, query: &WorkspaceQuery, safe: bool) -> Vec<WorkspaceCard> {
        self.workspace
            .browse(&self.device, &mut self.catalog, query, safe)
            .unwrap()
            .cards
    }
}

fn page_ids(card: &WorkspaceCard) -> Vec<&str> {
    card.set
        .as_ref()
        .map(|set| set.pages.iter().map(|p| p.image_id.as_str()).collect())
        .unwrap_or_default()
}

#[test]
fn pages_of_one_work_share_a_cell_in_page_order_with_the_first_page_as_cover() {
    let mut f = Fixture::new();
    let older = plain(&f.library, f.dir.path(), 1);
    // 收进来的先后与页序无关：后两页先到。
    let p2 = f.collect("100", 2, 12);
    let p0 = f.collect("100", 0, 10);
    let p1 = f.collect("100", 1, 11);
    let newer = plain(&f.library, f.dir.path(), 2);

    let flat = f.browse(&query(false), false);
    assert_eq!(flat.len(), 5);
    assert!(flat.iter().all(|c| c.set.is_none()));

    let cells = f.browse(&query(true), false);
    let ids: Vec<&str> = cells.iter().map(|c| c.image_id.as_str()).collect();
    // 一摞占最新那一页的位置，卡片本身是封面。
    assert_eq!(ids, [newer.as_str(), p0.as_str(), older.as_str()]);
    let stack = &cells[1];
    assert_eq!(page_ids(stack), [p0.as_str(), p1.as_str(), p2.as_str()]);
    let set = stack.set.as_ref().unwrap();
    assert_eq!(set.key, "pixiv:100");
    assert_eq!(stack.id, set.pages[0].id);
    assert_eq!(
        (stack.width, stack.height),
        (set.pages[0].width, set.pages[0].height)
    );

    let page = f
        .workspace
        .browse(&f.device, &mut f.catalog, &query(true), false)
        .unwrap();
    assert_eq!((page.total, page.images), (3, Some(5)));
    let page = f
        .workspace
        .browse(&f.device, &mut f.catalog, &query(false), false)
        .unwrap();
    assert_eq!((page.total, page.images), (5, None));
}

#[test]
fn only_pages_in_scope_are_stacked_and_a_lone_page_is_a_plain_card() {
    let mut f = Fixture::new();
    let p0 = f.collect("200", 0, 20);
    let p1 = f.collect("200", 1, 21);
    let p2 = f.collect("200", 2, 22);
    let folder = f.library.create_folder("手部", None).unwrap();
    let add = |ids: &[&String]| {
        f.library
            .edit(
                &ids.iter().map(|s| (*s).clone()).collect::<Vec<_>>(),
                &[ImageEdit::AddToFolder {
                    folder_id: folder.clone(),
                }],
            )
            .unwrap();
    };
    add(&[&p1, &p2]);
    let in_folder = WorkspaceQuery {
        scope: WorkspaceScope::Library {
            library_id: f.library.info().id.clone(),
            scope: BrowseScope::Folder { id: folder.clone() },
        },
        ..query(true)
    };
    let cells = f.browse(&in_folder, false);
    assert_eq!(cells.len(), 1);
    assert_eq!(cells[0].image_id, p1);
    assert_eq!(page_ids(&cells[0]), [p1.as_str(), p2.as_str()]);

    // 只有一页符合时照常是单张。
    f.library
        .edit(
            std::slice::from_ref(&p2),
            &[ImageEdit::RemoveFromFolder {
                folder_id: folder.clone(),
            }],
        )
        .unwrap();
    let cells = f.browse(&in_folder, false);
    assert_eq!(cells.len(), 1);
    assert_eq!(cells[0].image_id, p1);
    assert!(cells[0].set.is_none());
    // 第一页不在这个文件夹里，在全部图片里三页叠在一起。
    let all = f.browse(&query(true), false);
    assert_eq!(page_ids(&all[0]), [p0.as_str(), p1.as_str(), p2.as_str()]);
}

#[test]
fn safe_mode_thins_the_stack_and_the_cover_moves_on() {
    let mut f = Fixture::new();
    let p0 = f.collect("300", 0, 30);
    let p1 = f.collect("300", 1, 31);
    let p2 = f.collect("300", 2, 32);
    f.library
        .edit(
            std::slice::from_ref(&p0),
            &[ImageEdit::SetRating {
                rating: ContentRating::Explicit,
            }],
        )
        .unwrap();
    let cells = f.browse(&query(true), true);
    assert_eq!(cells.len(), 1);
    assert_eq!(cells[0].image_id, p1);
    assert_eq!(page_ids(&cells[0]), [p1.as_str(), p2.as_str()]);
    assert!(
        cells[0]
            .set
            .as_ref()
            .unwrap()
            .pages
            .iter()
            .all(|p| !p.adult)
    );
}

#[test]
fn an_image_already_in_the_library_joins_the_set_when_its_work_is_collected() {
    let mut f = Fixture::new();
    // 先作为普通图导入，后来订阅收到同一份字节。
    let early = plain(&f.library, f.dir.path(), 40);
    let p1 = f.collect("400", 1, 41);
    let cells = f.browse(&query(true), false);
    assert_eq!(cells.len(), 2);
    // 这一步没有新图进来，只是已有的图多了来源层；快照也要重读。
    assert_eq!(f.collect("400", 0, 40), early);
    let cells = f.browse(&query(true), false);
    assert_eq!(cells.len(), 1);
    assert_eq!(page_ids(&cells[0]), [early.as_str(), p1.as_str()]);
}
