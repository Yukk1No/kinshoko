//! 打标子进程 adapter（#52，ADR-0004）：真的启动子进程，经标准输入输出交换结果；
//! 子进程崩溃、卡住都只结束子进程，调度重启后继续。
//!
//! 子进程就是本测试程序自己：设了环境变量时，测试 `child_tagger_worker` 扮演打标子进程，
//! 用按文件名决定行为的假推理后端跑 [`serve`]（名字含 crash 就直接中止进程、含 hang 就卡住、
//! 含 bad 就报告坏图，其余返回以文件名为外部名称的标签；也可以用环境变量指定会崩溃的原图，
//! 或让第一次加载模型卡住，模拟 DirectML 编译图的漫长加载）。

mod support;

use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kinshoko_core::Library;
use kinshoko_core::library::{ImportOutcome, ImportSource};
use kinshoko_core::tagging::{
    Backend, Device, DeviceInfo, Engine, EngineError, GpuInfo, PreparedModel, ProcessTagger,
    RawTag, SessionStopper, TagFailure, Tagger, Tagging, TaggingConfig, TaggingStatus, serve,
};

const CHILD: &str = "child_tagger_worker";
const CHILD_ENV: &str = "KINSHOKO_TEST_TAGGER_CHILD";
/// 打到这张原图时子进程中止。
const CRASH_ON_ENV: &str = "KINSHOKO_TEST_TAGGER_CRASH_ON";
/// 这个文件还不存在时，加载模型先把子进程 PID 写进去，然后卡住；之后的加载照常。
const SLOW_LOAD_ENV: &str = "KINSHOKO_TEST_TAGGER_SLOW_LOAD";

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
        if let Some(marker) = std::env::var_os(SLOW_LOAD_ENV).map(PathBuf::from)
            && !marker.exists()
        {
            let tmp = marker.with_extension("tmp");
            std::fs::write(&tmp, std::process::id().to_string()).unwrap();
            std::fs::rename(&tmp, &marker).unwrap();
            std::thread::sleep(Duration::from_secs(3600));
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

    let mut session = tagger
        .start(&model(dir.path()), Device::DirectMl, &|_| {})
        .unwrap();
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

    let mut session = tagger.start(&model, Device::DirectMl, &|_| {}).unwrap();
    assert!(matches!(
        session.tag(&dir.path().join("crash.png")),
        Err(TagFailure::Crashed(_))
    ));

    let mut session = tagger.start(&model, Device::DirectMl, &|_| {}).unwrap();
    let t = Instant::now();
    assert!(matches!(
        session.tag(&dir.path().join("hang.png")),
        Err(TagFailure::Crashed(_))
    ));
    assert!(t.elapsed() < Duration::from_secs(30), "按超时结束了子进程");

    let mut session = tagger.start(&model, Device::DirectMl, &|_| {}).unwrap();
    assert!(session.tag(&dir.path().join("ok.png")).is_ok());
}

#[test]
fn stopping_a_session_ends_the_subprocess_in_the_middle_of_an_image() {
    let dir = tempfile::tempdir().unwrap();
    let mut tagger = tagger();
    tagger.image_timeout = Duration::from_secs(60);
    let slot: Arc<Mutex<Option<SessionStopper>>> = Arc::default();
    let mut session = tagger
        .start(&model(dir.path()), Device::DirectMl, &|stop| {
            *slot.lock().unwrap() = Some(stop)
        })
        .unwrap();
    let stop = slot.lock().unwrap().take().expect("开始时交出了结束开关");
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
        tagger().start(&model, Device::Cpu, &|_| {}),
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

/// 等子进程开始加载模型（卡住的那一次），返回它的 PID。
fn loading_child(marker: &Path, status: impl Fn() -> String) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(pid) = std::fs::read_to_string(marker)
            .ok()
            .and_then(|s| s.parse().ok())
        {
            return pid;
        }
        assert!(
            Instant::now() < deadline,
            "子进程没有开始加载：{}",
            status()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// 进程是否还在（包括已退出但没有被回收、句柄仍开着的僵尸）。
fn alive(pid: u32) -> bool {
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
}

/// 等到 `done` 成立；超过 `limit` 时失败。
fn within(limit: Duration, what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + limit;
    while !done() {
        assert!(Instant::now() < deadline, "{what}：超过 {limit:?}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// 带一张图的资料库与打标调度；第一次加载模型会卡住。
fn tagging_with_slow_load(dir: &Path) -> (Arc<Library>, String, Tagging, PathBuf) {
    let library = Arc::new(Library::create(&dir.join("lib"), "库").unwrap());
    let id = import(&library, dir, &["first"]).remove(0);
    let marker = dir.join("loading.pid");
    let tagger = tagger().env(SLOW_LOAD_ENV, marker.to_str().unwrap());
    let server = support::ModelServer::start();
    let spec = server.publish("proc", Device::DirectMl, b"model");
    let mut config = TaggingConfig::new(dir.join("models"), vec![spec]);
    config.base_url = server.base_url().to_owned();
    config.retry_delay = Duration::from_millis(20);
    config.poll_interval = Duration::from_millis(20);
    let tagging = Tagging::start(library.clone(), Arc::new(tagger), config);
    tagging.download();
    (library, id, tagging, marker)
}

/// 暂停要立刻结束正在加载模型的子进程、归还显存，不等加载完（#76 Core2）；恢复后照常打标。
#[test]
fn pausing_while_the_subprocess_loads_the_model_ends_it_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let (library, id, tagging, marker) = tagging_with_slow_load(dir.path());
    let pid = loading_child(&marker, || format!("{:?}", tagging.status()));

    tagging.pause();
    within(
        Duration::from_secs(5),
        "暂停后结束并回收子进程",
        || matches!(tagging.status(), TaggingStatus::Paused) && !alive(pid),
    );

    tagging.resume();
    within(Duration::from_secs(60), "恢复后打完", || {
        matches!(tagging.status(), TaggingStatus::Idle { .. })
    });
    assert_eq!(library.image_tags(&id, "zh-CN").unwrap().tags.len(), 1);
}

/// 关闭资料库（丢弃调度）时子进程正在加载模型：同样立刻结束并回收，不等加载完。
#[test]
fn dropping_tagging_while_the_subprocess_loads_the_model_ends_it_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let (_library, _id, tagging, marker) = tagging_with_slow_load(dir.path());
    let pid = loading_child(&marker, || format!("{:?}", tagging.status()));

    let t = Instant::now();
    drop(tagging);
    assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
    within(Duration::from_secs(5), "回收子进程", || !alive(pid));
}

/// 加载超时也要结束并回收子进程。
#[test]
fn a_load_timeout_ends_and_reaps_the_subprocess() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("loading.pid");
    let mut tagger = tagger().env(SLOW_LOAD_ENV, marker.to_str().unwrap());
    tagger.load_timeout = Duration::from_secs(1);
    let result = tagger.start(&model(dir.path()), Device::DirectMl, &|_| {});
    assert!(matches!(result, Err(TagFailure::Crashed(_))));
    let pid = loading_child(&marker, || "已超时".into());
    within(Duration::from_secs(5), "回收子进程", || !alive(pid));
}

/// 结束开关在子进程开始加载模型之前就交出来：加载中按下它，子进程立即结束并被回收（#76 Core2）。
#[test]
fn the_stopper_ends_the_subprocess_while_it_loads_the_model() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("loading.pid");
    let tagger = tagger().env(SLOW_LOAD_ENV, marker.to_str().unwrap());
    let model = model(dir.path());
    let slot: Arc<Mutex<Option<SessionStopper>>> = Arc::default();
    let registered = slot.clone();
    let loading = std::thread::spawn(move || {
        tagger
            .start(&model, Device::DirectMl, &|stop| {
                *registered.lock().unwrap() = Some(stop)
            })
            .map(|_| ())
    });
    let pid = loading_child(&marker, || "加载中".into());
    let stop = slot.lock().unwrap().take().expect("加载期间已有结束开关");

    let t = Instant::now();
    stop();
    assert!(matches!(
        loading.join().unwrap(),
        Err(TagFailure::Crashed(_))
    ));
    assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
    assert!(!alive(pid), "子进程已被回收");
}
