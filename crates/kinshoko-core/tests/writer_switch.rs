//! 按需切换可写资料库（ADR-0008，#112）：画师整理哪个库，后端就把唯一的可写句柄切过去；
//! 目标库或当前持有者有导入在收尾时，等它结束再执行。只经 `DeviceLibraries` 的对外接口，
//! 用临时目录里的真 SQLite 与真文件。

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kinshoko_core::library::{BrowseQuery, ImportSource, LibraryInfo};
use kinshoko_core::{
    DeviceLibraries, DeviceLibraryError, Library, WriterAccess, WriterWaitError, wait_for_writer,
};

fn query() -> BrowseQuery {
    BrowseQuery {
        scope: Default::default(),
        conditions: Default::default(),
        cursor: None,
        limit: 200,
        thumbnail_px: 256,
    }
}

fn create(root: &Path, name: &str) -> LibraryInfo {
    Library::create(root, name).unwrap().info().clone()
}

fn png(dir: &Path) -> std::path::PathBuf {
    let png = dir.join("参考.png");
    image::RgbImage::from_pixel(8, 12, image::Rgb([20, 40, 60]))
        .save(&png)
        .unwrap();
    png
}

/// A、B 两个已登记的库，A 是后端此刻持有可写句柄的库。
fn two_libraries(dir: &Path) -> (DeviceLibraries, LibraryInfo, LibraryInfo) {
    let a = create(&dir.join("工作参考"), "工作参考");
    let b = create(&dir.join("私人收藏"), "私人收藏");
    let mut device = DeviceLibraries::open(&dir.join("app")).unwrap();
    device.register(&b.root).unwrap();
    device.register(&a.root).unwrap();
    (device, a, b)
}

fn ready(access: WriterAccess) -> (Arc<Library>, bool) {
    match access {
        WriterAccess::Ready { library, switched } => (library, switched),
        WriterAccess::Waiting(wait) => panic!("不应等待：{:?}", wait.notice),
    }
}

fn folder_names(library: &Library) -> Vec<String> {
    library
        .sidebar()
        .unwrap()
        .folders
        .iter()
        .map(|folder| folder.name.clone())
        .collect()
}

/// 等导入内容处理完（进入收尾），不等定义发布。
fn wait_content_done(device: &Mutex<DeviceLibraries>, task: &str) {
    for _ in 0..2000 {
        if device
            .lock()
            .unwrap()
            .import_task(task)
            .is_some_and(|t| t.report.is_some())
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("导入内容一直没有处理完");
}

#[test]
fn organizing_another_library_switches_the_writable_handle_to_it() {
    let dir = tempfile::tempdir().unwrap();
    let (mut device, a, b) = two_libraries(dir.path());

    let (library, switched) = ready(device.organize(&b.id).unwrap());
    assert!(switched, "整理另一个库时后端切换可写句柄");
    assert_eq!(library.info().id, b.id);
    assert_eq!(device.current().unwrap().info().id, b.id);
    library.create_folder("发型", None).unwrap();

    assert_eq!(folder_names(&library), ["发型"]);
    let a_library = ready(device.organize(&a.id).unwrap()).0;
    assert!(folder_names(&a_library).is_empty(), "整理不落到另一个库");
}

#[test]
fn organizing_the_library_that_already_holds_the_handle_does_not_switch() {
    let dir = tempfile::tempdir().unwrap();
    let (mut device, a, _) = two_libraries(dir.path());
    let held = device.current().unwrap();

    let (library, switched) = ready(device.organize(&a.id).unwrap());
    assert!(!switched);
    assert!(Arc::ptr_eq(&library, &held), "沿用同一个可写句柄");
}

#[test]
fn an_on_demand_switch_is_not_the_artists_last_opened_choice() {
    let dir = tempfile::tempdir().unwrap();
    let (mut device, a, b) = two_libraries(dir.path());
    ready(device.organize(&b.id).unwrap());
    drop(device);

    let mut reopened = DeviceLibraries::open(&dir.path().join("app")).unwrap();
    assert_eq!(
        reopened.restore_last_opened().unwrap().unwrap().info().id,
        a.id,
        "按需切换只是后端细节，不改画师上次打开的库"
    );
}

#[test]
fn organizing_an_unregistered_or_unavailable_library_is_refused_and_keeps_the_holder() {
    let dir = tempfile::tempdir().unwrap();
    let (mut device, a, b) = two_libraries(dir.path());
    assert!(matches!(
        device.organize("没有这个库"),
        Err(DeviceLibraryError::UnknownLibrary)
    ));
    std::fs::rename(&b.root, dir.path().join("盘已拔出")).unwrap();
    assert!(matches!(
        device.organize(&b.id),
        Err(DeviceLibraryError::Unavailable { .. })
    ));
    assert_eq!(device.current().unwrap().info().id, a.id);
}

/// A 库导入中（内容仍在处理），整理 B 库文件夹：立即执行，A 的导入照常完成在 A，回执仍归 A。
#[test]
fn organizing_b_while_a_imports_runs_at_once_and_keeps_the_import_in_a() {
    let dir = tempfile::tempdir().unwrap();
    let (device, a, b) = two_libraries(dir.path());
    let png = png(dir.path());
    let device = Mutex::new(device);
    let task = {
        let mut device = device.lock().unwrap();
        let task = device
            .start_import(
                &a.id,
                ImportSource {
                    paths: vec![png; 200],
                },
            )
            .unwrap();
        device.defer_import_completion(&task).unwrap();
        task
    };

    let (library, switched) = ready(device.lock().unwrap().organize(&b.id).unwrap());
    assert!(switched);
    library.create_folder("姿势", None).unwrap();

    wait_content_done(&device, &task);
    let mut guard = device.lock().unwrap();
    guard
        .complete_import_publication(&a.id, &task, None)
        .unwrap();
    let receipt = guard.import_task(&task).unwrap();
    assert_eq!(receipt.destination.library_id, a.id, "回执仍归 A");
    let report = receipt.report.unwrap();
    assert!(!report.cancelled, "切换可写句柄不得取消 A 的导入");
    assert_eq!(report.items.len(), 200);
    let a_library = guard.read(&a.id).unwrap();
    assert_eq!(a_library.browse(&query()).unwrap().total, 1);
    assert!(folder_names(&a_library).is_empty());
    assert_eq!(library.browse(&query()).unwrap().total, 0, "导入不落到 B");
    assert_eq!(folder_names(&library), ["姿势"]);
}

/// 目标库有导入在收尾：整理等待，收尾结束后执行一次，不丢失也不重复。
#[test]
fn organizing_a_library_whose_import_is_finishing_waits_then_runs_once() {
    let dir = tempfile::tempdir().unwrap();
    let (device, a, b) = two_libraries(dir.path());
    let png = png(dir.path());
    let device = Arc::new(Mutex::new(device));
    let task = {
        let mut device = device.lock().unwrap();
        let task = device
            .start_import(&b.id, ImportSource { paths: vec![png] })
            .unwrap();
        device.defer_import_completion(&task).unwrap();
        task
    };
    wait_content_done(&device, &task);

    let wait = match device.lock().unwrap().organize(&b.id).unwrap() {
        WriterAccess::Waiting(wait) => wait,
        WriterAccess::Ready { .. } => panic!("目标库导入收尾时应等待"),
    };
    assert_eq!(wait.notice.library_id, b.id);
    assert_eq!(wait.notice.finishing, ["私人收藏"], "轻提示说出在收尾的库");
    assert_eq!(device.lock().unwrap().current().unwrap().info().id, a.id);

    let worker = {
        let device = device.clone();
        let b = b.id.clone();
        std::thread::spawn(move || {
            let mut waits = 0;
            let library = loop {
                let access = device.lock().unwrap().organize(&b).unwrap();
                match access {
                    WriterAccess::Ready { library, .. } => break library,
                    WriterAccess::Waiting(wait) => {
                        waits += 1;
                        wait.wait(Duration::from_secs(5));
                    }
                }
            };
            library.create_folder("等待后执行", None).unwrap();
            (library, waits)
        })
    };
    std::thread::sleep(Duration::from_millis(100));
    device
        .lock()
        .unwrap()
        .complete_import_publication(&b.id, &task, None)
        .unwrap();
    let (library, waits) = worker.join().unwrap();

    assert!(waits >= 1, "收尾结束前一直等待");
    assert_eq!(library.info().id, b.id);
    assert_eq!(
        folder_names(&library),
        ["等待后执行"],
        "执行一次，不丢失不重复"
    );
    assert_eq!(device.lock().unwrap().current().unwrap().info().id, b.id);
}

/// 当前持有者有导入在收尾：切到另一个库也要等它结束。
#[test]
fn switching_away_from_a_holder_whose_import_is_finishing_waits() {
    let dir = tempfile::tempdir().unwrap();
    let (device, a, b) = two_libraries(dir.path());
    let png = png(dir.path());
    let device = Mutex::new(device);
    let task = {
        let mut device = device.lock().unwrap();
        let task = device
            .start_import(&a.id, ImportSource { paths: vec![png] })
            .unwrap();
        device.defer_import_completion(&task).unwrap();
        task
    };
    wait_content_done(&device, &task);

    let mut device = device.into_inner().unwrap();
    match device.organize(&b.id).unwrap() {
        WriterAccess::Waiting(wait) => {
            assert_eq!(wait.notice.library_id, b.id);
            assert_eq!(wait.notice.finishing, ["工作参考"]);
        }
        WriterAccess::Ready { .. } => panic!("当前持有者导入收尾时应等待"),
    }
    assert_eq!(device.current().unwrap().info().id, a.id, "等待期间不切换");

    device
        .complete_import_publication(&a.id, &task, None)
        .unwrap();
    let (library, switched) = ready(device.organize(&b.id).unwrap());
    assert!(switched);
    assert_eq!(library.info().id, b.id);
}

/// 等待的唤醒有上限：即使没有收尾通知也会按时返回，调用方重新检查。
#[test]
fn a_wait_returns_by_its_timeout_without_a_notification() {
    let dir = tempfile::tempdir().unwrap();
    let (device, _, b) = two_libraries(dir.path());
    let png = png(dir.path());
    let device = Mutex::new(device);
    let task = {
        let mut device = device.lock().unwrap();
        let task = device
            .start_import(&b.id, ImportSource { paths: vec![png] })
            .unwrap();
        device.defer_import_completion(&task).unwrap();
        task
    };
    wait_content_done(&device, &task);
    let WriterAccess::Waiting(wait) = device.lock().unwrap().organize(&b.id).unwrap() else {
        panic!("应等待");
    };
    let started = std::time::Instant::now();
    wait.wait(Duration::from_millis(50));
    assert!(started.elapsed() < Duration::from_secs(2));
}

/// 窗口打开的是 A，在 B 里整理后（可写句柄切到 B），A 的浏览、详情与目录仍读得到；
/// 读不切换可写句柄。读可写库本身时沿用它的句柄。
#[test]
fn reading_a_library_does_not_require_it_to_hold_the_writable_handle() {
    let dir = tempfile::tempdir().unwrap();
    let (mut device, a, b) = two_libraries(dir.path());
    let png = png(dir.path());
    device
        .current()
        .unwrap()
        .import(ImportSource { paths: vec![png] })
        .wait();
    let folder = device
        .current()
        .unwrap()
        .create_folder("手部", None)
        .unwrap();
    let b_writer = ready(device.organize(&b.id).unwrap()).0;
    b_writer.create_folder("发型", None).unwrap();
    assert!(
        matches!(device.require(&a.id), Err(DeviceLibraryError::StaleLibrary)),
        "整理 B 后旧的“当前资料库”核对会拒绝 A"
    );

    let a_reader = device.resolve(&a.id, true).unwrap();
    let page = a_reader.browse(&query()).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(a_reader.image(&page.cards[0].id).unwrap().width, 8);
    assert_eq!(a_reader.sidebar().unwrap().folders[0].id, folder);
    assert!(a_reader.safe_mode(), "按调用方给的安全模式读");
    assert!(!device.resolve(&a.id, false).unwrap().safe_mode());
    assert_eq!(
        device.current().unwrap().info().id,
        b.id,
        "读不切换可写句柄"
    );

    let b_reader = device.resolve(&b.id, true).unwrap();
    assert!(Arc::ptr_eq(&b_reader, &b_writer), "可写库本身沿用它的句柄");
    assert!(matches!(
        device.resolve("没有这个库", true),
        Err(DeviceLibraryError::UnknownLibrary)
    ));
}

/// 安全模式开关设给所有开着的可写句柄：后台导入仍持有的旧库不会留着旧视角。
#[test]
fn the_safe_mode_setting_reaches_every_open_writable_library() {
    let dir = tempfile::tempdir().unwrap();
    let (device, a, b) = two_libraries(dir.path());
    let png = png(dir.path());
    let device = Mutex::new(device);
    let task = {
        let mut device = device.lock().unwrap();
        let task = device
            .start_import(
                &a.id,
                ImportSource {
                    paths: vec![png; 50],
                },
            )
            .unwrap();
        device.defer_import_completion(&task).unwrap();
        task
    };
    let a_handle = device.lock().unwrap().current().unwrap();
    let b_writer = ready(device.lock().unwrap().organize(&b.id).unwrap()).0;

    device.lock().unwrap().set_safe_mode(false);
    assert!(!b_writer.safe_mode());
    assert!(!a_handle.safe_mode(), "导入仍持有的 A 也跟着设置");
    device.lock().unwrap().set_safe_mode(true);
    assert!(b_writer.safe_mode() && a_handle.safe_mode());

    wait_content_done(&device, &task);
    device
        .lock()
        .unwrap()
        .complete_import_publication(&a.id, &task, None)
        .unwrap();
}

/// 导入收尾一直不结束时，整理不会永远等下去：到上限后返回错误给界面，轻提示只给一次。
#[test]
fn waiting_for_a_finishing_import_gives_up_after_the_limit() {
    let dir = tempfile::tempdir().unwrap();
    let (device, _, b) = two_libraries(dir.path());
    let png = png(dir.path());
    let device = Mutex::new(device);
    let task = {
        let mut device = device.lock().unwrap();
        let task = device
            .start_import(&b.id, ImportSource { paths: vec![png] })
            .unwrap();
        device.defer_import_completion(&task).unwrap();
        task
    };
    wait_content_done(&device, &task);

    let mut hints = Vec::new();
    let started = std::time::Instant::now();
    let error = wait_for_writer(
        || device.lock().unwrap().organize(&b.id),
        |notice| hints.push(notice.clone()),
        Duration::from_millis(20),
        Duration::from_millis(200),
    )
    .err()
    .expect("收尾不结束时应放弃");
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(hints.len(), 1, "轻提示只给一次");
    match &error {
        WriterWaitError::TimedOut(notice) => assert_eq!(notice.finishing, ["私人收藏"]),
        WriterWaitError::Request(error) => panic!("不应是请求错误：{error}"),
    }
    assert!(error.to_string().contains("「私人收藏」"), "{error}");
    assert!(error.to_string().contains("没有执行"), "{error}");

    // 收尾结束后同一个请求立即完成，不提示。
    device
        .lock()
        .unwrap()
        .complete_import_publication(&b.id, &task, None)
        .unwrap();
    let mut later = 0;
    let library = wait_for_writer(
        || device.lock().unwrap().organize(&b.id),
        |_| later += 1,
        Duration::from_millis(20),
        Duration::from_millis(200),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(library.info().id, b.id);
    assert_eq!(later, 0);
}
