//! 打标子进程 adapter（#52，ADR-0004）：真的启动子进程，经标准输入输出交换结果；
//! 子进程崩溃、卡住都只结束子进程，调度重启后继续。
//!
//! 子进程就是本测试程序自己：设了环境变量时，测试 `child_tagger_worker` 扮演打标子进程，
//! 用按文件名决定行为的假推理后端跑 [`serve`]（名字含 crash 就直接中止进程、含 hang 就卡住、
//! 含 bad 就报告坏图，其余返回以文件名为外部名称的标签；也可以用环境变量指定会崩溃的原图）。

mod support;

use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use kinshoko_core::Library;
use kinshoko_core::library::{ImportOutcome, ImportSource};
use kinshoko_core::tagging::{
    Backend, Device, DeviceInfo, Engine, EngineError, GpuInfo, PreparedModel, ProcessTagger,
    RawTag, TagFailure, Tagger, Tagging, TaggingConfig, TaggingStatus, serve,
};

const CHILD: &str = "child_tagger_worker";
const CHILD_ENV: &str = "KINSHOKO_TEST_TAGGER_CHILD";
/// 打到这张原图时子进程中止。
const CRASH_ON_ENV: &str = "KINSHOKO_TEST_TAGGER_CRASH_ON";

struct FakeBackend;

struct FakeEngine;

impl Backend for FakeBackend {
    fn probe(&mut self) -> DeviceInfo {
        DeviceInfo {
            gpu: Some(GpuInfo {
                name: "子进程里的显卡".into(),
                vram_budget: 4_000_000_000,
            }),
            available_ram: 8_000_000_000,
        }
    }

    fn load(
        &mut self,
        onnx: &Path,
        _tags: &Path,
        _device: Device,
    ) -> Result<Box<dyn Engine>, EngineError> {
        if !onnx.is_file() {
            return Err(EngineError::Fatal("没有模型文件".into()));
        }
        Ok(Box::new(FakeEngine))
    }
}

impl Engine for FakeEngine {
    fn tag(&mut self, image: &Path) -> Result<Vec<RawTag>, EngineError> {
        let name = image.file_stem().unwrap().to_string_lossy().into_owned();
        let crash_on = std::env::var_os(CRASH_ON_ENV).map(PathBuf::from);
        if name.contains("crash") || crash_on.as_deref() == Some(image) {
            std::process::abort();
        }
        if name.contains("hang") {
            std::thread::sleep(Duration::from_secs(3600));
        }
        if name.contains("bad") {
            return Err(EngineError::BadImage("无法解码".into()));
        }
        Ok(vec![RawTag {
            name,
            category: 0,
            score: 0.9,
        }])
    }
}

/// 只在作为子进程启动时做事。
#[test]
fn child_tagger_worker() {
    if std::env::var_os(CHILD_ENV).is_none() {
        return;
    }
    let stdin = std::io::stdin();
    let code = serve(
        &mut FakeBackend,
        BufReader::new(stdin.lock()),
        std::io::stdout(),
    );
    std::process::exit(code);
}

fn tagger() -> ProcessTagger {
    let mut t = ProcessTagger::new(
        std::env::current_exe().unwrap(),
        vec![CHILD.into(), "--exact".into(), "--nocapture".into()],
    )
    .env(CHILD_ENV, "1");
    t.image_timeout = Duration::from_secs(2);
    t
}

fn model(dir: &Path) -> PreparedModel {
    let onnx = dir.join("model.onnx");
    std::fs::write(&onnx, b"model").unwrap();
    PreparedModel {
        spec: support::test_spec("proc", Device::DirectMl, b"model"),
        onnx,
        tags_csv: dir.join("selected_tags.csv"),
    }
}

#[test]
fn the_subprocess_reports_the_device_and_tags_images() {
    let dir = tempfile::tempdir().unwrap();
    let tagger = tagger();
    assert_eq!(
        tagger.probe().gpu.map(|g| g.name),
        Some("子进程里的显卡".to_owned())
    );

    let mut session = tagger.start(&model(dir.path()), Device::DirectMl).unwrap();
    let tags = session.tag(&dir.path().join("blue_eyes.png")).unwrap();
    assert_eq!(tags[0].name, "blue_eyes");
    assert_eq!(
        session.tag(&dir.path().join("bad.png")),
        Err(TagFailure::BadImage("无法解码".into()))
    );
    // 坏图之后会话照常可用。
    assert!(session.tag(&dir.path().join("smile.png")).is_ok());
}

#[test]
fn a_crash_or_hang_in_the_subprocess_ends_only_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let tagger = tagger();
    let model = model(dir.path());

    let mut session = tagger.start(&model, Device::DirectMl).unwrap();
    assert!(matches!(
        session.tag(&dir.path().join("crash.png")),
        Err(TagFailure::Crashed(_))
    ));

    let mut session = tagger.start(&model, Device::DirectMl).unwrap();
    let t = Instant::now();
    assert!(matches!(
        session.tag(&dir.path().join("hang.png")),
        Err(TagFailure::Crashed(_))
    ));
    assert!(t.elapsed() < Duration::from_secs(30), "按超时结束了子进程");

    let mut session = tagger.start(&model, Device::DirectMl).unwrap();
    assert!(session.tag(&dir.path().join("ok.png")).is_ok());
}

#[test]
fn stopping_a_session_ends_the_subprocess_in_the_middle_of_an_image() {
    let dir = tempfile::tempdir().unwrap();
    let mut tagger = tagger();
    tagger.image_timeout = Duration::from_secs(60);
    let mut session = tagger.start(&model(dir.path()), Device::DirectMl).unwrap();
    let stop = session.stopper();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        stop();
    });
    let t = Instant::now();
    assert!(matches!(
        session.tag(&dir.path().join("hang.png")),
        Err(TagFailure::Crashed(_))
    ));
    assert!(t.elapsed() < Duration::from_secs(10), "没有等到超时");
}

#[test]
fn loading_a_missing_model_fails_without_hanging() {
    let dir = tempfile::tempdir().unwrap();
    let mut model = model(dir.path());
    model.onnx = dir.path().join("missing.onnx");
    assert!(matches!(
        tagger().start(&model, Device::Cpu),
        Err(TagFailure::Crashed(_))
    ));
}

fn import(library: &Library, dir: &Path, names: &[&str]) -> Vec<String> {
    let paths: Vec<PathBuf> = names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let path = dir.join(format!("{name}.png"));
            image::RgbaImage::from_fn(4, 4, |x, y| image::Rgba([i as u8, x as u8, y as u8, 255]))
                .save(&path)
                .unwrap();
            path
        })
        .collect();
    library
        .import(ImportSource { paths })
        .wait()
        .items
        .into_iter()
        .map(|item| match item.outcome {
            ImportOutcome::Imported { image_id } => image_id,
            other => panic!("未导入：{other:?}"),
        })
        .collect()
}

#[test]
fn tagging_continues_after_the_subprocess_crashes() {
    let dir = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::create(&dir.path().join("lib"), "库").unwrap());
    let ids = import(&library, dir.path(), &["first", "second", "last"]);
    // 原图按 SHA-256 命名；告诉子进程哪一张原图会让它崩溃。
    let crashing = library.original_path(&ids[1]).unwrap();
    let tagger = tagger().env(CRASH_ON_ENV, crashing.to_str().unwrap());

    let server = support::ModelServer::start();
    let spec = server.publish("proc", Device::DirectMl, b"model");
    let mut config = TaggingConfig::new(dir.path().join("models"), vec![spec]);
    config.base_url = server.base_url().to_owned();
    config.retry_delay = Duration::from_millis(20);
    let tagging = Tagging::start(library.clone(), Arc::new(tagger), config);
    tagging.download();
    let deadline = Instant::now() + Duration::from_secs(60);
    while !matches!(tagging.status(), TaggingStatus::Idle { .. }) {
        assert!(Instant::now() < deadline, "{:?}", tagging.status());
        std::thread::sleep(Duration::from_millis(20));
    }
    for id in [&ids[0], &ids[2]] {
        assert_eq!(library.image_tags(id, "zh-CN").unwrap().tags.len(), 1);
    }
    assert!(
        library
            .image_tags(&ids[1], "zh-CN")
            .unwrap()
            .tags
            .is_empty()
    );
    assert!(
        library
            .images_to_tag(
                &kinshoko_core::library::FactSource::model("test-tagger"),
                10
            )
            .unwrap()
            .is_empty(),
        "反复崩溃的图记为无法打标，不再重试"
    );
}
