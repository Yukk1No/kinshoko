// #158：选中一张参考图时详情面板要读的后端查询（详情、标签、文件夹树、来源检查）各花多少时间。
// 规模按模型打过标的资料库：1000 张图、2000 个带外部对应的标签、每张 25 个、40 个文件夹。
// 只打印耗时，不设门槛（调试构建与发行构建差一个数量级）：
// cargo test -p kinshoko-core --test integration inspector_reads:: -- --ignored --nocapture

use std::time::{Duration, Instant};

use image::{Rgba, RgbaImage};
use kinshoko_core::DeviceLibraries;
use kinshoko_core::library::{
    FactSource, ImageEdit, ImportSource, SourceTag, TagNamespace, TagRef,
};
use kinshoko_core::tag_catalog::TagCatalog;
use kinshoko_core::workspace::{Workspace, WorkspaceQuery, WorkspaceSourceTarget};

const IMAGES: usize = 1000;
const VOCABULARY: usize = 2000;
const TAGS_PER_IMAGE: usize = 25;
const FOLDERS: usize = 40;
const SAMPLES: usize = 50;

fn mean(total: Duration) -> f64 {
    total.as_secs_f64() * 1000.0 / SAMPLES as f64
}

#[test]
#[ignore = "耗时测量，手动运行"]
fn selection_reads_for_the_inspector() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let library = device.create(&dir.path().join("lib"), "库").unwrap();
    let paths = (0..IMAGES)
        .map(|i| {
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
    let ids: Vec<String> = library
        .import(ImportSource { paths })
        .wait()
        .items
        .into_iter()
        .map(|item| item.outcome.image_id().unwrap().to_owned())
        .collect();
    assert_eq!(ids.len(), IMAGES);
    for (i, id) in ids.iter().enumerate() {
        let tags = (0..TAGS_PER_IMAGE)
            .map(|k| SourceTag {
                tag: TagRef::External {
                    namespace: TagNamespace::General,
                    name: format!("tag_{}", (i * 7 + k * 79) % VOCABULARY),
                },
                score: Some(0.5),
            })
            .collect::<Vec<_>>();
        library
            .replace_source_tags(&FactSource::model("test"), id, &tags)
            .unwrap();
    }
    for f in 0..FOLDERS {
        let folder = library.create_folder(&format!("文件夹 {f}"), None).unwrap();
        library
            .edit(
                &ids[f * 20..f * 20 + 20],
                &[ImageEdit::AddToFolder { folder_id: folder }],
            )
            .unwrap();
    }
    assert_eq!(library.vocabulary().unwrap().tags.len(), VOCABULARY);

    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    // 第一次同步把整份词表登记进统一标签目录；之后每次读都是“已经同步过”的情形。
    catalog.image_tags(&library, &ids[0], "zh-CN").unwrap();
    let page = workspace
        .browse(
            &device,
            &mut catalog,
            &WorkspaceQuery {
                scope: Default::default(),
                conditions: Default::default(),
                cursor: None,
                limit: SAMPLES as u32,
                known_placeholders: Vec::new(),
            },
            true,
        )
        .unwrap();
    assert_eq!(page.cards.len(), SAMPLES);

    let library_id = library.info().id.clone();
    let (mut detail, mut tags, mut sidebar, mut inspection) = (
        Duration::ZERO,
        Duration::ZERO,
        Duration::ZERO,
        Duration::ZERO,
    );
    for card in &page.cards {
        let source = &card.sources[0];
        let started = Instant::now();
        library.image(&source.image_id).unwrap();
        detail += started.elapsed();
        let started = Instant::now();
        catalog
            .image_tags(&library, &source.image_id, "zh-CN")
            .unwrap();
        tags += started.elapsed();
        let started = Instant::now();
        workspace
            .sidebar(&device, &mut catalog, &library_id, true)
            .unwrap();
        sidebar += started.elapsed();
        let target = WorkspaceSourceTarget {
            library_id: library_id.clone(),
            image_id: source.image_id.clone(),
            content_id: card.id.clone(),
        };
        let started = Instant::now();
        workspace
            .inspect_source(&device, &mut catalog, &target, true, "zh-CN")
            .unwrap();
        inspection += started.elapsed();
    }
    println!(
        "#158 {IMAGES} images/{VOCABULARY} tags/{TAGS_PER_IMAGE} per image/{FOLDERS} folders, mean of {SAMPLES}: \
         image={:.2}ms catalog_image_tags={:.2}ms workspace_sidebar={:.2}ms workspace_source_inspection={:.2}ms",
        mean(detail),
        mean(tags),
        mean(sidebar),
        mean(inspection),
    );
}
