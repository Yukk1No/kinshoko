//! #200 / #212 图片墙重新浏览的后端开销：导入一个文件夹后，按图片墙“重新浏览”的方式（工作区“全部图片”，
//! 每页 500 张）读完整个资料库，打印每轮的总耗时、每页耗时与传给界面的 JSON 大小。缩放换档、自动打标
//! 每写一批图都会让图片墙这样从头读一遍已加载的卡片。第 0 轮是冷的（占位图还没读过），之后是热的。
//!
//! 用法（务必 release）：
//!   node scripts/perf/wall-fixture.mjs <样本目录> 5000 1
//!   cargo run --release -p kinshoko-core --example wall_rebrowse_cost -- <样本目录> [轮数=5]
//! 环境变量 `PAGE` 改每页张数（默认 500，与图片墙相同），用来区分每页固定开销与每张卡片的开销。
//!
//! 数据目录与资料库都建在系统临时目录里，结束时删除；不碰本设备登记的资料库。

use std::time::Instant;

use kinshoko_core::DeviceLibraries;
use kinshoko_core::library::ImportSource;
use kinshoko_core::tag_catalog::TagCatalog;
use kinshoko_core::workspace::{Workspace, WorkspaceQuery, WorkspaceScope};

fn main() {
    let mut args = std::env::args_os().skip(1);
    let samples = std::path::PathBuf::from(args.next().expect("样本目录"));
    let rounds: usize = args
        .next()
        .map(|a| a.to_string_lossy().parse().expect("轮数"))
        .unwrap_or(5);
    let dir = tempfile::tempdir().expect("临时目录");
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).expect("数据目录");
    let library = device
        .create(&dir.path().join("lib"), "重新浏览开销")
        .expect("新建资料库");
    library
        .import(ImportSource {
            paths: vec![samples],
        })
        .wait();
    let mut catalog = TagCatalog::open(&app).expect("标签目录");
    let mut workspace = Workspace::open(&app).expect("工作区");

    for round in 0..rounds {
        let start = Instant::now();
        let (mut cards, mut bytes, mut placeholders) = (0usize, 0usize, 0usize);
        let mut cursor = None;
        let mut pages = Vec::new();
        loop {
            let page_start = Instant::now();
            let page = workspace
                .browse(
                    &device,
                    &mut catalog,
                    &WorkspaceQuery {
                        scope: WorkspaceScope::All,
                        conditions: Default::default(),
                        cursor: cursor.take(),
                        limit: std::env::var("PAGE").map_or(500, |v| v.parse().unwrap()),
                        known_placeholders: Vec::new(),
                    },
                    false,
                )
                .expect("浏览");
            pages.push(format!(
                "{:.0}",
                page_start.elapsed().as_secs_f64() * 1000.0
            ));
            bytes += serde_json::to_string(&page).expect("序列化").len();
            cards += page.cards.len();
            placeholders += page
                .cards
                .iter()
                .filter(|c| c.placeholder.is_some())
                .count();
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        println!(
            "round={round} cards={cards} placeholders={placeholders} json_kb={} ms={:.1} pages_ms=[{}]",
            bytes / 1024,
            start.elapsed().as_secs_f64() * 1000.0,
            pages.join(",")
        );
    }
}
