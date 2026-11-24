//! 全设备一个打标调度覆盖所有资料库（ADR-0008 修订，#414）：不靠叫醒也会打到非优先库、合计状态、
//! 同一时间一个会话、优先库切换与暂停。

use super::*;
use kinshoko_core::CommandError;
use kinshoko_core::tagging::TaggingLibraries;

/// 夹具的库 A 之外再建一个库 B（同一临时目录下）。
fn second_library(f: &Fixture) -> Arc<Library> {
    let library = Arc::new(Library::create(&f.dir.path().join("lib-b"), "库 B").unwrap());
    library.set_safe_mode(false);
    library
}

fn start_with(f: &Fixture, libraries: Arc<dyn TaggingLibraries>, poll: Duration) -> Tagging {
    f.fake.set_gpu(Some(GPU_BUDGET));
    let spec = f.server.publish("gpu", Device::DirectMl, b"model");
    let mut config = f.config(vec![spec]);
    config.poll_interval = poll;
    let tagging = Tagging::start(libraries, Arc::new(f.fake.clone()), config);
    tagging.download();
    tagging
}

/// 假 tagger 打过的图里，属于 `library` 的有几张。
fn tagged_in(f: &Fixture, library: &Library) -> usize {
    let root = &library.info().root;
    f.fake
        .tagged()
        .iter()
        .filter(|(path, _)| path.starts_with(root))
        .count()
}

#[test]
fn images_saved_to_a_library_that_is_not_preferred_are_tagged_without_waking() {
    let f = Fixture::new(1);
    let b = second_library(&f);
    let tagging = start_with(
        &f,
        Arc::new(vec![f.library.clone(), b.clone()]),
        Duration::from_millis(300),
    );
    tagging.prefer(&f.library.info().id);
    idle(&tagging);
    assert_eq!(tagged_in(&f, &f.library), 1);

    // 像订阅那样直接写进 B：不叫醒调度器，也不把 B 设为优先。导入还没返回时图已经能被拉到，
    // 所以假输出要在导入前设好。
    f.fake.set_default_output(vec![raw("long_hair", 0, 0.5)]);
    let saved = import_into(&f.dir, &b, 100..102);
    wait_for(&tagging, "B 的图打上标", |_| tagged_in(&f, &b) == 2);
    idle(&tagging);
    let names: Vec<_> = tags_of(&b, &saved[0]).into_iter().map(|t| t.1).collect();
    assert_eq!(names, vec!["long hair"]);
}

#[test]
fn status_is_not_all_done_until_every_library_is_tagged() {
    let f = Fixture::new(2);
    let b = second_library(&f);
    import_into(&f.dir, &b, 100..103);
    f.fake.set_delay(Duration::from_millis(30));
    let tagging = start_with(
        &f,
        Arc::new(vec![f.library.clone(), b.clone()]),
        Duration::from_secs(60),
    );

    let status = wait_for(&tagging, "开始打标", |s| {
        matches!(s, TaggingStatus::Running { .. })
    });
    let TaggingStatus::Running { remaining, .. } = status else {
        unreachable!()
    };
    assert_eq!(remaining, 5, "两个库合计");
    let status = idle(&tagging);
    assert_eq!(
        (tagged_in(&f, &f.library), tagged_in(&f, &b)),
        (2, 3),
        "两个库都打完才报全部完成"
    );
    assert!(matches!(status, TaggingStatus::Idle { unknown: 0, .. }));
}

/// 登记了一个暂时打不开的库（例如移动盘拔掉了）。
struct WithUnavailable {
    libraries: Vec<Arc<Library>>,
}

impl TaggingLibraries for WithUnavailable {
    fn library_ids(&self) -> Vec<String> {
        let mut ids = vec!["unplugged".to_owned()];
        ids.extend(self.libraries.library_ids());
        ids
    }

    fn writer(&self, library_id: &str) -> Result<Arc<Library>, CommandError> {
        self.libraries.writer(library_id)
    }
}

#[test]
fn an_unavailable_library_is_skipped_and_keeps_the_status_from_reporting_all_done() {
    let f = Fixture::new(2);
    let tagging = start_with(
        &f,
        Arc::new(WithUnavailable {
            libraries: vec![f.library.clone()],
        }),
        Duration::from_millis(20),
    );
    let status = idle(&tagging);
    assert_eq!(tagged_in(&f, &f.library), 2, "打不开的库不挡住其他库");
    assert!(
        matches!(status, TaggingStatus::Idle { unknown: 1, .. }),
        "{status:?}"
    );
}

#[test]
fn one_session_at_a_time_and_the_next_batch_comes_from_the_preferred_library() {
    // 一批 16 张：A 有 20 张，打 A 的第一批时换成优先 B，B 的图接在这一批后面。
    let f = Fixture::new(20);
    let b = second_library(&f);
    import_into(&f.dir, &b, 100..102);
    f.fake.set_delay(Duration::from_millis(20));
    let tagging = start_with(
        &f,
        Arc::new(vec![f.library.clone(), b.clone()]),
        Duration::from_secs(60),
    );
    tagging.prefer(&f.library.info().id);
    wait_for(&tagging, "开始打 A", |s| {
        matches!(s, TaggingStatus::Running { .. })
    });
    assert_eq!(tagging.tagging_library(), Some(f.library.info().id.clone()));
    tagging.prefer(&b.info().id);

    let mut most = 0;
    while !matches!(tagging.status(), TaggingStatus::Idle { .. }) {
        most = most.max(f.fake.live_sessions());
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(most <= 1, "同一时间只有一个打标会话");
    assert_eq!(f.fake.started().len(), 1, "换库不重开会话");

    let root = &b.info().root;
    let order: Vec<bool> = f
        .fake
        .tagged()
        .iter()
        .map(|(path, _)| path.starts_with(root))
        .collect();
    assert_eq!(order.len(), 22);
    assert!(order[..16].iter().all(|in_b| !in_b), "手上这一批不打断");
    assert!(order[16..18].iter().all(|in_b| *in_b), "下一批从优先库取");
    assert!(order[18..].iter().all(|in_b| !in_b));
}

#[test]
fn pausing_survives_a_change_of_preferred_library() {
    let f = Fixture::new(3);
    let b = second_library(&f);
    import_into(&f.dir, &b, 100..102);
    f.fake.set_delay(Duration::from_millis(50));
    let tagging = start_with(
        &f,
        Arc::new(vec![f.library.clone(), b.clone()]),
        Duration::from_millis(20),
    );
    wait_for(&tagging, "开始打标", |s| {
        matches!(s, TaggingStatus::Running { .. })
    });
    tagging.pause();
    wait_for(&tagging, "暂停", |s| matches!(s, TaggingStatus::Paused));
    let done = f.fake.tagged().len();

    tagging.prefer(&b.info().id);
    std::thread::sleep(Duration::from_millis(200));
    assert!(matches!(tagging.status(), TaggingStatus::Paused));
    assert_eq!(f.fake.tagged().len(), done, "换了优先库仍暂停");

    tagging.resume();
    idle(&tagging);
    assert_eq!((tagged_in(&f, &f.library), tagged_in(&f, &b)), (3, 2));
}

/// 可以取消登记的库（像本设备的登记表那样）。
struct Registry(std::sync::Mutex<Vec<Arc<Library>>>);

impl TaggingLibraries for Registry {
    fn library_ids(&self) -> Vec<String> {
        self.0.lock().unwrap().library_ids()
    }

    fn writer(&self, library_id: &str) -> Result<Arc<Library>, CommandError> {
        self.0.lock().unwrap().writer(library_id)
    }
}

#[test]
fn unregistering_the_library_being_tagged_stops_its_batch_and_lets_go_of_it() {
    let f = Fixture::new(1);
    let b = second_library(&f);
    import_into(&f.dir, &b, 100..101);
    f.fake
        .set_output(&f.original(0), vec![raw("blue_eyes", 0, 0.9)]);
    // CPU 档一张约 29 秒：取消登记不能等这张打完。
    f.fake.set_delay(Duration::from_secs(30));
    let registry = Arc::new(Registry(std::sync::Mutex::new(vec![
        f.library.clone(),
        b.clone(),
    ])));
    let tagging = start_with(&f, registry.clone(), Duration::from_millis(20));
    tagging.prefer(&f.library.info().id);
    wait_for(&tagging, "开始打 A", |s| {
        matches!(s, TaggingStatus::Running { .. })
    });

    let a_id = f.library.info().id.clone();
    registry.0.lock().unwrap().retain(|l| l.info().id != a_id);
    let started = Instant::now();
    tagging.release(&a_id);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "不等手上这张打完"
    );
    assert_ne!(tagging.tagging_library(), Some(a_id.clone()), "已放下 A");
    assert!(
        tags_of(&f.library, &f.ids[0]).is_empty(),
        "取消登记后不再写进 A"
    );

    // 其余的库照常打（放下 A 后可能已经按 30 秒开始打 B 的那张，缩短耗时后它随之打完）。
    f.fake.set_delay(Duration::ZERO);
    wait_for(&tagging, "打 B", |_| tagged_in(&f, &b) == 1);
}
