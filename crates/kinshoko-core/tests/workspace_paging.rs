//! 工作区浏览的结果复用与大图库翻页耗时（#288）。
use image::{Rgba, RgbaImage};
use kinshoko_core::DeviceLibraries;
use kinshoko_core::library::{ImageEdit, ImportSource, Library};
use kinshoko_core::tag_catalog::TagCatalog;
use kinshoko_core::workspace::{Workspace, WorkspaceQuery, WorkspaceScope};

fn query() -> WorkspaceQuery {
    WorkspaceQuery {
        scope: WorkspaceScope::All,
        conditions: Default::default(),
        cursor: None,
        limit: 1,
        thumbnail_px: 240,
    }
}
/// 同一份字节导入到每个资料库，返回各自的图片 id。
fn files(dir: &std::path::Path, libraries: &[&Library], red: u8) -> Vec<String> {
    let path = dir.join(format!("{red}.png"));
    RgbaImage::from_pixel(4, 3, Rgba([red, 34, 56, 255]))
        .save(&path)
        .unwrap();
    libraries
        .iter()
        .map(|library| {
            library
                .import(ImportSource {
                    paths: vec![path.clone()],
                })
                .wait()
                .items[0]
                .outcome
                .image_id()
                .unwrap()
                .to_owned()
        })
        .collect()
}
/// 大图库打开与翻页的分段耗时（#288）：两个资料库各 1000 张，按瀑布流的节奏每页 500 张，
/// 冷启动取第一页、接着翻到底、再从头重读。耗时，手动以 release 运行：
/// `cargo test --release --test integration workspace_paging::large_library -- --ignored --nocapture`。
#[test]
#[ignore]
fn large_library_paging_timings() {
    const PER_LIBRARY: usize = 1000;
    const PAGE: u32 = 500;
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let libraries = ["a", "b"].map(|name| device.create(&dir.path().join(name), name).unwrap());
    for (n, library) in libraries.iter().enumerate() {
        let paths = (0..PER_LIBRARY)
            .map(|i| {
                let i = n * PER_LIBRARY + i;
                let path = dir.path().join("in").join(format!("ref_{i}.png"));
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                RgbaImage::from_fn(2, 2, |x, y| {
                    Rgba([(i % 256) as u8, (i / 256) as u8, x as u8, y as u8])
                })
                .save(&path)
                .unwrap();
                path
            })
            .collect();
        library.import(ImportSource { paths }).wait();
    }
    let ms = |started: std::time::Instant| started.elapsed().as_secs_f64() * 1e3;
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let page = |workspace: &mut Workspace, catalog: &mut TagCatalog, cursor| {
        workspace
            .browse(
                &device,
                catalog,
                &WorkspaceQuery {
                    cursor,
                    limit: PAGE,
                    ..query()
                },
                true,
            )
            .unwrap()
    };
    let started = std::time::Instant::now();
    workspace.status(&device, &mut catalog, true).unwrap();
    let cold_status = ms(started);
    let mut timings = Vec::new();
    for _ in 0..2 {
        let mut cursor = None;
        loop {
            let started = std::time::Instant::now();
            let next = page(&mut workspace, &mut catalog, cursor);
            timings.push(ms(started));
            assert_eq!(next.total as usize, 2 * PER_LIBRARY);
            cursor = next.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
    }
    let started = std::time::Instant::now();
    workspace.status(&device, &mut catalog, true).unwrap();
    let warm_status = ms(started);
    let pages = PER_LIBRARY * 2 / PAGE as usize;
    let fmt = |t: &[f64]| {
        t.iter()
            .map(|t| format!("{t:.1}"))
            .collect::<Vec<_>>()
            .join(" ")
    };
    println!(
        "#288 2x{PER_LIBRARY} images, {PAGE}/page: cold status={cold_status:.1}ms first pass=[{}]ms reload=[{}]ms warm status={warm_status:.1}ms",
        fmt(&timings[..pages]),
        fmt(&timings[pages..])
    );
}
/// 同一组结果（修订号、范围、条件都没变）翻页和从头重读只切片，不再查询、分组、排序（#288）；
/// 资料库一变、安全模式一换就重算。缩略图尺寸不属于结果，换尺寸照样切片，地址按新尺寸给出。
#[test]
fn pages_and_reloads_of_one_result_reuse_it_until_a_revision_changes() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    files(dir.path(), &[&a, &b], 11);
    files(dir.path(), &[&a], 22);
    let id = files(dir.path(), &[&b], 33).remove(0);
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let mut browse = |workspace: &mut Workspace, cursor, thumbnail_px, safe| {
        workspace
            .browse(
                &device,
                &mut catalog,
                &WorkspaceQuery {
                    cursor,
                    thumbnail_px,
                    ..query()
                },
                safe,
            )
            .unwrap()
    };
    let first = browse(&mut workspace, None, 240, true);
    let second = browse(&mut workspace, first.next_cursor.clone(), 240, true);
    let again = browse(&mut workspace, None, 240, true);
    assert_eq!(workspace.browse_builds(), 1);
    assert_eq!(again.cards, first.cards);
    assert_ne!(second.cards[0].id, first.cards[0].id);

    let larger = browse(&mut workspace, None, 480, true);
    assert_eq!(workspace.browse_builds(), 1);
    assert_eq!(larger.cards[0].id, first.cards[0].id);
    assert_ne!(larger.cards[0].thumbnail, first.cards[0].thumbnail);

    // 安全模式换一下是另一组结果；换回来时原来那组还留着。
    browse(&mut workspace, None, 240, false);
    assert_eq!(workspace.browse_builds(), 2);
    browse(&mut workspace, None, 240, true);
    assert_eq!(workspace.browse_builds(), 2);

    b.edit(&[id], &[ImageEdit::Delete]).unwrap();
    let after = browse(&mut workspace, None, 240, true);
    assert_eq!(workspace.browse_builds(), 3);
    assert_eq!(after.total, 2);
}
