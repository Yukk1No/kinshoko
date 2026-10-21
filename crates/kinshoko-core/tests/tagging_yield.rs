//! 有全屏程序或演示模式时让出打标（#212）：判定只看系统报告的通知状态与前台窗口是不是 Kinshoko 自己的。

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::library::ImportSource;
use kinshoko_core::tagging::{
    Device, ForegroundCheck, InMemoryTagger, Tagging, TaggingConfig, TaggingStatus,
    UserNotificationState, yields_to_foreground,
};
use support::ModelServer;

#[test]
fn a_full_screen_game_presentation_or_busy_state_in_another_program_makes_tagging_yield() {
    for state in [
        UserNotificationState::RunningD3dFullScreen,
        UserNotificationState::Busy,
        UserNotificationState::PresentationMode,
    ] {
        assert!(yields_to_foreground(Some(state), false), "{state:?}");
    }
}

/// 截图框选窗口、钉图菜单窗口打开时系统也报 Busy（#230）：前台是 Kinshoko 自己的窗口时照常打标。
#[test]
fn kinshokos_own_foreground_window_never_makes_tagging_yield() {
    for state in [
        UserNotificationState::RunningD3dFullScreen,
        UserNotificationState::Busy,
        UserNotificationState::PresentationMode,
    ] {
        assert!(!yields_to_foreground(Some(state), true), "{state:?}");
    }
}

#[test]
fn ordinary_desktop_states_and_unknown_states_keep_tagging() {
    for state in [
        Some(UserNotificationState::AcceptsNotifications),
        Some(UserNotificationState::NotPresent),
        Some(UserNotificationState::QuietTime),
        Some(UserNotificationState::App),
        None,
    ] {
        assert!(!yields_to_foreground(state, false), "{state:?}");
    }
}

/// `SHQueryUserNotificationState` 返回的整数值（shellapi.h 的 QUERY_USER_NOTIFICATION_STATE）。
#[test]
fn the_raw_system_values_map_to_states() {
    assert_eq!(
        UserNotificationState::from_raw(2),
        Some(UserNotificationState::Busy)
    );
    assert_eq!(
        UserNotificationState::from_raw(3),
        Some(UserNotificationState::RunningD3dFullScreen)
    );
    assert_eq!(
        UserNotificationState::from_raw(4),
        Some(UserNotificationState::PresentationMode)
    );
    assert_eq!(
        UserNotificationState::from_raw(5),
        Some(UserNotificationState::AcceptsNotifications)
    );
    assert_eq!(UserNotificationState::from_raw(0), None);
    assert_eq!(UserNotificationState::from_raw(8), None);
}

fn wait_for(tagging: &Tagging, what: &str, f: impl Fn(&TaggingStatus) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !f(&tagging.status()) {
        assert!(
            Instant::now() < deadline,
            "等待{what}超时，当前状态 {:?}",
            tagging.status()
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// 全屏程序在前台时：结束会话归还显存，状态显示让出，不再打标；回到平常状态后自己继续打完。
#[test]
fn tagging_yields_while_a_full_screen_program_is_in_front_and_continues_afterwards() {
    let dir = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::create(&dir.path().join("lib"), "库").unwrap());
    let paths = (0..4u8)
        .map(|i| {
            let path = dir.path().join(format!("{i}.png"));
            RgbaImage::from_fn(4, 4, |x, y| image::Rgba([i, x as u8, y as u8, 255]))
                .save(&path)
                .unwrap();
            path
        })
        .collect();
    library.import(ImportSource { paths }).wait();
    let fake = InMemoryTagger::new();
    fake.set_gpu(Some(4_000_000_000));
    fake.set_delay(Duration::from_millis(100));
    let server = ModelServer::start();
    let spec = server.publish("gpu", Device::DirectMl, b"model");
    let full_screen = Arc::new(AtomicBool::new(false));
    let mut config = TaggingConfig::new(dir.path().join("models"), vec![spec]);
    config.base_url = server.base_url().to_owned();
    config.poll_interval = Duration::from_millis(20);
    let watched = full_screen.clone();
    config.foreground = Some(ForegroundCheck::new(move || watched.load(Ordering::SeqCst)));
    let tagging = Tagging::start(library, Arc::new(fake.clone()), config);
    tagging.download();
    wait_for(&tagging, "开始打标", |s| {
        matches!(s, TaggingStatus::Running { .. })
    });

    full_screen.store(true, Ordering::SeqCst);
    wait_for(&tagging, "让出", |s| {
        matches!(s, TaggingStatus::YieldedToFullScreen)
    });
    assert_eq!(fake.live_sessions(), 0, "让出时会话结束，显存归还");
    let done = fake.tagged().len();
    assert!(done < 4);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(fake.tagged().len(), done, "让出期间不打标");

    full_screen.store(false, Ordering::SeqCst);
    wait_for(&tagging, "打完", |s| {
        matches!(s, TaggingStatus::Idle { .. })
    });
    assert_eq!(fake.tagged().len(), 4);
}
