//! 缩略图渲染的内存上限与请求合并（#165）：图片墙一次要几十张缺缓存的大图时，
//! 同时在进行的整图解码估算内存不超过上限；同一张图、同一档位同时只渲染一次。
//! 整图解码的计数与预算是全进程的，本文件的测试互斥运行。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier, Mutex};

use image::RgbImage;
use kinshoko_core::Library;
use kinshoko_core::fidelity::{self, budget::probe};
use kinshoko_core::library::{ImportOutcome, ImportSource};

static SERIAL: Mutex<()> = Mutex::new(());

/// 导入时只生成占位图与默认网格档位；测试请求更大的档位，保证每次都现场渲染。
const TIER: u32 = 1024;

fn write_jpeg(path: &Path, w: u32, h: u32, seed: u8) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    RgbImage::from_fn(w, h, |x, y| {
        image::Rgb([seed, (x ^ y) as u8, (x / 7 + y / 3) as u8])
    })
    .save(path)
    .unwrap();
    path.to_path_buf()
}

fn library_with(dir: &Path, count: u8, w: u32, h: u32) -> (Library, Vec<(String, PathBuf)>) {
    let library = Library::create(&dir.join("lib"), "库").unwrap();
    let paths: Vec<PathBuf> = (0..count)
        .map(|i| write_jpeg(&dir.join(format!("in/{i}.jpg")), w, h, i))
        .collect();
    let report = library
        .import(ImportSource {
            paths: paths.clone(),
        })
        .wait();
    let images = report
        .items
        .iter()
        .zip(paths)
        .map(|(item, path)| match &item.outcome {
            ImportOutcome::Imported { image_id } => (image_id.clone(), path),
            other => panic!("{other:?}"),
        })
        .collect();
    (library, images)
}

#[test]
fn concurrent_thumbnails_of_large_images_stay_within_the_decode_budget() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    // 每张 1.2 MP，估算约 48 MB；预算只够两张同时解码。
    let (library, images) = library_with(dir.path(), 6, 1200, 1000);
    let budget = 100 * 1024 * 1024;
    probe::set_budget(budget);
    probe::reset();

    let library = Arc::new(library);
    let threads = 12;
    let start = Arc::new(Barrier::new(threads));
    let workers: Vec<_> = (0..threads)
        .map(|t| {
            let (library, images, start) = (library.clone(), images.clone(), start.clone());
            std::thread::spawn(move || {
                start.wait();
                // 每个线程从不同的一张开始，同一张图也有重复请求。
                (0..images.len())
                    .map(|i| {
                        let (id, _) = &images[(i + t) % images.len()];
                        (id.clone(), library.thumbnail(id, TIER).unwrap())
                    })
                    .collect::<Vec<_>>()
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .flat_map(|w| w.join().unwrap())
        .collect();

    assert!(
        probe::peak() <= budget,
        "同时在进行的整图解码估算 {} MB，超过上限 {} MB",
        probe::peak() / 1024 / 1024,
        budget / 1024 / 1024
    );
    // 排队的请求最终都拿到与单独渲染逐字节相同的缩略图。
    for (id, original) in &images {
        let expected = fidelity::render_sdr(
            &std::fs::read(original).unwrap(),
            TIER,
            fidelity::DEFAULT_DOWNSCALE,
        )
        .unwrap()
        .bytes;
        let mine: Vec<_> = results.iter().filter(|(i, _)| i == id).collect();
        assert_eq!(mine.len(), threads);
        for (_, path) in mine {
            assert_eq!(std::fs::read(path).unwrap(), expected);
        }
    }
}

#[test]
fn concurrent_requests_for_the_same_image_and_tier_render_once() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let (library, images) = library_with(dir.path(), 1, 1600, 1200);
    let (id, _) = images[0].clone();
    probe::set_budget(1 << 40);

    let library = Arc::new(library);
    let requests = 8;
    let start = Arc::new(Barrier::new(requests));
    let before = probe::renders();
    let paths: Vec<PathBuf> = (0..requests)
        .map(|_| {
            let (library, id, start) = (library.clone(), id.clone(), start.clone());
            std::thread::spawn(move || {
                start.wait();
                library.thumbnail(&id, TIER).unwrap()
            })
        })
        .collect::<Vec<_>>()
        .into_iter()
        .map(|w| w.join().unwrap())
        .collect();

    assert_eq!(probe::renders() - before, 1, "同一张图、同一档位只渲染一次");
    assert!(paths.iter().all(|p| p == &paths[0]));
    assert_eq!(image::image_dimensions(&paths[0]).unwrap(), (1024, 768));
}
