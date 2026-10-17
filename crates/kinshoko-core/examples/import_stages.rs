//! #120 导入分阶段测量：在一个新建的临时资料库里导入一个文件夹，打印各阶段耗时与吞吐量（JSON）。
//!
//! 用法（务必 release）：
//!   node scripts/perf/wall-fixture.mjs <样本目录> 5000 1
//!   cargo run --release -p kinshoko-core --example import_stages -- <样本目录> [缩略图像素=384]
//!
//! 导入结束后再为每张图生成一次网格缩略图（浏览时 `thumb` 协议现场生成的同一条路），单独计时：
//! 缩略图不在导入任务里生成，但画师等到“图都出来了”包含这一段。
//! 资料库建在系统临时目录里，结束时删除；不碰本设备登记的资料库。

use std::time::{Duration, Instant};

use kinshoko_core::Library;
use kinshoko_core::library::{BrowseQuery, BrowseScope, ImportOutcome, ImportSource};

fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 1000.0 * 10.0).round() / 10.0
}

fn main() {
    let mut args = std::env::args_os().skip(1);
    let samples = std::path::PathBuf::from(args.next().expect("样本目录"));
    let thumb_px: u32 = args
        .next()
        .map(|a| a.to_string_lossy().parse().expect("缩略图像素"))
        .unwrap_or(384);
    let dir = tempfile::tempdir().expect("临时目录");
    let library = Library::create(&dir.path().join("lib"), "分阶段测量").expect("新建资料库");

    let (report, stages) = library
        .import(ImportSource {
            paths: vec![samples.clone()],
        })
        .wait_with_stages();
    let imported = report
        .items
        .iter()
        .filter(|item| matches!(item.outcome, ImportOutcome::Imported { .. }))
        .count();

    // 网格缩略图：按浏览顺序逐张生成，与界面滚动时的请求顺序一致。
    let mut ids = Vec::new();
    let mut cursor = None;
    loop {
        let page = library
            .browse(&BrowseQuery {
                scope: BrowseScope::default(),
                conditions: Default::default(),
                cursor: cursor.take(),
                limit: 1000,
                thumbnail_px: thumb_px,
            })
            .expect("浏览");
        ids.extend(page.cards.into_iter().map(|card| card.id));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    let start = Instant::now();
    let mut each = Vec::with_capacity(ids.len());
    for id in &ids {
        let one = Instant::now();
        library.thumbnail(id, thumb_px).expect("缩略图");
        each.push(one.elapsed());
    }
    let thumbs = start.elapsed();
    each.sort();
    let pct =
        |p: f64| each.get(((each.len() as f64 * p) as usize).min(each.len().saturating_sub(1)));
    let import_secs = stages.total.as_secs_f64();

    let out = serde_json::json!({
        "samples": samples.display().to_string(),
        "files": report.items.len(),
        "imported": imported,
        "importMs": {
            "total": ms(stages.total),
            "scan": ms(stages.scan),
            "read": ms(stages.read),
            "decode": ms(stages.decode),
            "hash": ms(stages.hash),
            "stage": ms(stages.stage),
            "commit": ms(stages.commit),
            "placeholder": ms(stages.placeholder),
            "finish": ms(stages.finish),
            "other": ms(stages.total.saturating_sub(
                stages.scan + stages.read + stages.decode + stages.hash + stages.stage
                    + stages.commit + stages.placeholder + stages.finish)),
        },
        "importImagesPerSec": (imported as f64 / import_secs * 10.0).round() / 10.0,
        "thumbnails": {
            "px": thumb_px,
            "count": ids.len(),
            "totalMs": ms(thumbs),
            "p50Ms": pct(0.5).map(|d| ms(*d)),
            "p95Ms": pct(0.95).map(|d| ms(*d)),
        },
    });
    println!("{}", serde_json::to_string_pretty(&out).expect("JSON"));
}
