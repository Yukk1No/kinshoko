//! 打标对整机的负载探针（#212）：打标子进程跑着时，前台程序还剩多少 CPU。
//!
//! 用法（release 构建，图片目录里取前 N 张 jpg/png/webp）：
//!
//! ```text
//! cargo run -p kinshoko-tagger --release --example load_probe -- \
//!     --models-dir %LOCALAPPDATA%\Kinshoko\data\models --images <图片目录> \
//!     --device directml|cpu [--count 20] [--fg-threads 8]
//! ```
//!
//! 显卡档要先把 `target/release/DirectML.dll` 复制到 `target/release/examples/`。
//! 输出两行汇总：
//! - `idle`：只跑前台探针，作为基线；
//! - `tagging`：打标子进程逐张打图，同时跑前台探针。
//!
//! 前台探针是 `--fg-threads` 个普通优先级线程，反复做一块固定的计算（空闲时约 2 ms）。
//! `fg_rate` 是每秒做完的块数，`fg_p99_ms` 是单块耗时的 p99：前者掉得越多、后者涨得越多，
//! 画师同时开着的绘画软件就越卡；`fg_slowdown` 是两段 `fg_rate` 之比。`per_image_s` 是打一张图的平均耗时。
//! 模拟核数较少的机器：启动后把本进程的处理器亲和性限制到几个核（子进程继承），例如 PowerShell 里
//! `$p = Start-Process … -PassThru; $p.ProcessorAffinity = 0xFFF`（6 核 12 线程）。
//!
//! 子进程就是本示例自己（子命令 `worker`），走与应用相同的 [`kinshoko_tagger::run_worker`]。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use kinshoko_core::tagging::{Device, ModelStore, ProcessTagger, Tagger, catalog};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("worker") {
        std::process::exit(kinshoko_tagger::run_worker());
    }
    let opt = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let models_dir = PathBuf::from(opt("--models-dir").expect("缺少 --models-dir"));
    let images_dir = PathBuf::from(opt("--images").expect("缺少 --images"));
    let device = match opt("--device").as_deref() {
        Some("cpu") => Device::Cpu,
        _ => Device::DirectMl,
    };
    let count: usize = opt("--count").map_or(20, |v| v.parse().expect("--count"));
    let logical = std::thread::available_parallelism().map_or(4, |n| n.get());
    let fg_threads: usize =
        opt("--fg-threads").map_or(logical / 2, |v| v.parse().expect("--fg-threads"));

    // 只有显卡档的模型时，CPU 档也用它（线程与优先级的行为相同，只是更慢）。
    let store = ModelStore::new(models_dir, "");
    let model = catalog()
        .iter()
        .filter(|m| m.device == device)
        .chain(catalog().iter())
        .find_map(|m| store.ready(m))
        .expect("模型目录里没有已就绪的模型");
    let images = list_images(&images_dir, count);
    assert!(!images.is_empty(), "图片目录里没有图");

    let unit = calibrate();
    println!(
        "model={} device={device:?} images={} logical_cores={logical} fg_threads={fg_threads}",
        model.spec.key,
        images.len()
    );

    let idle = foreground(fg_threads, unit, || {
        std::thread::sleep(Duration::from_secs(8))
    });
    println!(
        "idle    fg_rate={:.0}/s fg_p99_ms={:.2}",
        idle.rate, idle.p99_ms
    );

    let exe = std::env::current_exe().expect("current_exe");
    let tagger = ProcessTagger::new(exe, vec!["worker".into()]);
    let mut session = tagger
        .start(&model, device, &|_| {})
        .unwrap_or_else(|e| panic!("无法开始打标：{e}"));
    // 先打一张预热（DirectML 首张要编译图），不计入。
    let _ = session.tag(&images[0]);
    let mut per_image = Duration::ZERO;
    let busy = foreground(fg_threads, unit, || {
        let start = Instant::now();
        for image in &images {
            session
                .tag(image)
                .unwrap_or_else(|e| panic!("打标失败：{e}"));
        }
        per_image = start.elapsed() / images.len() as u32;
    });
    println!(
        "tagging fg_rate={:.0}/s fg_p99_ms={:.2} per_image_s={:.2} fg_slowdown={:.2}x",
        busy.rate,
        busy.p99_ms,
        per_image.as_secs_f64(),
        idle.rate / busy.rate
    );
}

fn list_images(dir: &Path, count: usize) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = walk(dir)
        .into_iter()
        .filter(|p| {
            p.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                matches!(
                    e.to_ascii_lowercase().as_str(),
                    "jpg" | "jpeg" | "png" | "webp"
                )
            })
        })
        .collect();
    found.sort();
    found.truncate(count);
    found
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

/// 一块固定的整数计算；返回值防止被优化掉。
fn work(iterations: u64) -> u64 {
    let mut x = 0x9E37_79B9_7F4A_7C15u64;
    for i in 0..iterations {
        x = x.rotate_left(7) ^ i.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    }
    x
}

/// 让一块计算在空闲时约 2 ms。
fn calibrate() -> u64 {
    let mut n = 100_000u64;
    loop {
        let start = Instant::now();
        std::hint::black_box(work(n));
        let t = start.elapsed();
        if t >= Duration::from_millis(20) {
            return n * 2 / t.as_millis() as u64;
        }
        n *= 2;
    }
}

struct Foreground {
    rate: f64,
    p99_ms: f64,
}

/// 在 `during` 运行期间跑前台探针。
fn foreground(threads: usize, unit: u64, during: impl FnOnce()) -> Foreground {
    let stop = Arc::new(AtomicBool::new(false));
    let start = Instant::now();
    let handles: Vec<_> = (0..threads)
        .map(|_| {
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut times = Vec::new();
                while !stop.load(Ordering::Relaxed) {
                    let t = Instant::now();
                    std::hint::black_box(work(unit));
                    times.push(t.elapsed());
                }
                times
            })
        })
        .collect();
    during();
    stop.store(true, Ordering::Relaxed);
    let elapsed = start.elapsed();
    let mut times: Vec<Duration> = handles
        .into_iter()
        .flat_map(|h| h.join().unwrap())
        .collect();
    times.sort();
    let p99 = times[(times.len() * 99 / 100).min(times.len() - 1)];
    Foreground {
        rate: times.len() as f64 / elapsed.as_secs_f64(),
        p99_ms: p99.as_secs_f64() * 1000.0,
    }
}
