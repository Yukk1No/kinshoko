use super::*;
use crate::app_notice::AppNotices;
use kinshoko_core::approx::PersonalApprox;
use kinshoko_core::library::{FactSource, SourceTag, TagRef};
use kinshoko_core::tag_catalog::CatalogApproxEdit;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

#[derive(Default)]
struct Revisions(Mutex<Vec<String>>);

fn record_revision(app: &AppHandle<MockRuntime>, notice: &AppNotice) {
    if let AppNotice::WorkspaceChanged(status) = notice {
        lock(&app.state::<Revisions>().0).push(status.revision.clone());
    }
}

#[test]
fn tag_group_and_personal_approx_writes_wake_the_same_revision_publisher() {
    let dir = tempfile::tempdir().unwrap();
    let app = mock_builder()
        .manage(LibraryState::new(
            dir.path().join("device"),
            SafeMode::new(true, SafeModeScope::default()),
        ))
        .manage(Revisions::default())
        .manage(AppNotices::<MockRuntime>::new(vec![
            wake_on_notice,
            record_revision,
        ]))
        .build(mock_context(noop_assets()))
        .unwrap();
    let app = app.handle();
    let state = app.state::<LibraryState>();
    let library = state
        .session
        .with_libraries(|device| device.create(&dir.path().join("library"), "Library"))
        .unwrap();
    let path = dir.path().join("reference.png");
    image::RgbaImage::from_pixel(4, 3, image::Rgba([10, 20, 30, 255]))
        .save(&path)
        .unwrap();
    let report = library.import(ImportSource { paths: vec![path] }).wait();
    let image = report.items[0].outcome.image_id().unwrap();
    library
        .replace_source_tags(
            &FactSource::model("test"),
            image,
            &["blue_eyes", "aqua_eyes"].map(|name| SourceTag {
                tag: TagRef::External {
                    namespace: TagNamespace::General,
                    name: name.into(),
                },
                score: None,
            }),
        )
        .unwrap();

    let mut previous = None;
    assert!(poll(app, &mut previous));
    let (a, b) = state
        .session
        .with_catalog(|catalog| {
            let tags = catalog.inspect()?.tags;
            let id = |name| {
                tags.iter()
                    .find(|tag| tag.external.iter().any(|external| external.name == name))
                    .unwrap()
                    .id
                    .clone()
            };
            Ok((id("blue_eyes"), id("aqua_eyes")))
        })
        .unwrap();
    let wake = &state.workspace_wake;
    let mut seen = wake.snapshot();
    tauri::async_runtime::block_on(super::super::groups::create_shared_tag_group(
        app.clone(),
        "Eyes".into(),
        None,
    ))
    .unwrap();
    assert!(wake.wait_timeout(&mut seen, Duration::ZERO));
    assert!(poll(app, &mut previous));

    tauri::async_runtime::block_on(super::super::approx::edit_shared_approx(
        app.clone(),
        CatalogApproxEdit::Set {
            rules: vec![PersonalApprox {
                a,
                b,
                relation: ApproxRelation::Similar,
            }],
        },
        true,
    ))
    .unwrap();
    assert!(wake.wait_timeout(&mut seen, Duration::ZERO));
    assert!(poll(app, &mut previous));

    publish(app, AppNotice::TagGroupsChanged);
    publish(app, AppNotice::PersonalApproxChanged);
    assert!(wake.wait_timeout(&mut seen, Duration::ZERO));
    assert!(!poll(app, &mut previous));
    let revisions = lock(&app.state::<Revisions>().0).clone();
    assert_eq!(revisions.len(), 3);
    assert_ne!(revisions[0], revisions[1]);
    assert_ne!(revisions[1], revisions[2]);
}

#[test]
fn poll_backoff_ramps_to_cap_and_resets_on_change_or_wake() {
    let mut backoff = PollBackoff::new();
    assert_eq!(backoff.current(), Duration::from_millis(1500));

    backoff.on_unchanged();
    assert_eq!(backoff.current(), Duration::from_millis(3000));
    backoff.on_unchanged();
    assert_eq!(backoff.current(), Duration::from_millis(5000));
    backoff.on_unchanged();
    assert_eq!(backoff.current(), Duration::from_millis(10_000));
    backoff.on_unchanged();
    assert_eq!(backoff.current(), Duration::from_millis(10_000));

    backoff.on_change();
    assert_eq!(backoff.current(), Duration::from_millis(1500));

    backoff.on_unchanged();
    backoff.on_unchanged();
    assert_eq!(backoff.current(), Duration::from_millis(5000));
    backoff.reset();
    assert_eq!(backoff.current(), Duration::from_millis(1500));
}

#[test]
fn monitor_wake_unblocks_waiter_and_preserves_prior_signal() {
    let wake = Arc::new(MonitorWake::default());
    let mut seen = wake.snapshot();

    // 先唤醒后等待：序列号已前进，不应丢失信号，也不应阻塞等待超时。
    wake.wake();
    let started = Instant::now();
    assert!(wake.wait_timeout(&mut seen, Duration::from_secs(5)));
    assert!(started.elapsed() < Duration::from_secs(1));

    // 没有新唤醒时按超时返回 false。
    assert!(!wake.wait_timeout(&mut seen, Duration::from_millis(15)));

    // 等待期间另一线程唤醒，应立即解除阻塞。
    let notifier = wake.clone();
    let handle = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(20));
        notifier.wake();
    });
    let started = Instant::now();
    assert!(wake.wait_timeout(&mut seen, Duration::from_secs(5)));
    assert!(started.elapsed() < Duration::from_secs(1));
    handle.join().unwrap();
}

#[test]
fn inactive_window_skips_poll_and_resets_backoff_until_woken() {
    let wake = Arc::new(MonitorWake::default());
    let mut seen = wake.snapshot();
    let mut backoff = PollBackoff::new();
    backoff.on_unchanged();
    backoff.on_unchanged();
    assert_eq!(backoff.current(), Duration::from_millis(5000));

    let notifier = wake.clone();
    let handle = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(20));
        notifier.wake();
    });
    let mut polled = 0;
    let started = Instant::now();
    monitor_step(
        &wake,
        &mut seen,
        &mut backoff,
        false,
        Duration::from_secs(5),
        || {
            polled += 1;
            true
        },
    );
    assert_eq!(polled, 0);
    assert_eq!(backoff.current(), Duration::from_millis(1500));
    assert!(started.elapsed() < Duration::from_secs(1));
    handle.join().unwrap();

    // 窗口恢复活跃后立即执行一次状态核对；内部唤醒则直接结束本轮等待并复位退避。
    wake.wake();
    monitor_step(
        &wake,
        &mut seen,
        &mut backoff,
        true,
        Duration::from_secs(5),
        || {
            polled += 1;
            false
        },
    );
    assert_eq!(polled, 1);
    assert_eq!(backoff.current(), Duration::from_millis(1500));
}
