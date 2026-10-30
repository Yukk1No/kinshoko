//! 打标的状态变化记进运行日志（#219）：开始、结束（打了几张、用了多久）、出错与不可用；
//! 张数增加、下载进度这类变化不记。

use std::time::{Duration, Instant};

use kinshoko_core::diagnostics::{LibraryNo, LogEvent};
use kinshoko_core::tagging::{Device, TaggingLog, TaggingStatus};

fn running(tagged: u32) -> TaggingStatus {
    TaggingStatus::Running {
        model: "PixAI".into(),
        device: Device::DirectMl,
        gpu: Some("显卡".into()),
        tagged,
    }
}

fn idle(tagged: u32) -> TaggingStatus {
    TaggingStatus::Idle {
        model: "PixAI".into(),
        device: Device::DirectMl,
        gpu: Some("显卡".into()),
        tagged,
    }
}

#[test]
fn a_run_is_logged_when_it_starts_and_when_it_runs_out_of_images() {
    let t0 = Instant::now();
    let mut log = TaggingLog::new(Some(LibraryNo::from_index(0)));

    assert_eq!(log.observe(&TaggingStatus::Starting, t0), None);
    assert_eq!(
        log.observe(&running(0), t0),
        Some(LogEvent::TaggingStarted {
            library: Some(LibraryNo::from_index(0)),
            device: Device::DirectMl,
        })
    );
    assert_eq!(log.observe(&running(1), t0 + Duration::from_secs(1)), None);
    assert_eq!(log.observe(&running(2), t0 + Duration::from_secs(2)), None);
    assert_eq!(
        log.observe(&idle(3), t0 + Duration::from_millis(3_500)),
        Some(LogEvent::TaggingFinished {
            tagged: 3,
            ms: 3_500
        })
    );
    assert_eq!(log.observe(&idle(3), t0 + Duration::from_secs(9)), None);
}

#[test]
fn failures_and_missing_hardware_are_logged_once_without_paths() {
    let t0 = Instant::now();
    let mut log = TaggingLog::new(None);
    let failed = TaggingStatus::Failed {
        reason: kinshoko_core::tagging::reported(r"读取 C:\Users\画师\模型\model.onnx 失败"),
    };

    let Some(LogEvent::TaggingFailed { detail }) = log.observe(&failed, t0) else {
        panic!("出错要记下");
    };
    let text = serde_json::to_string(&detail).unwrap();
    assert!(!text.contains("画师"), "{text}");
    assert_eq!(log.observe(&failed, t0), None, "同一个错误不重复记");

    assert!(matches!(
        log.observe(
            &TaggingStatus::NoDevice {
                reason: kinshoko_core::tagging::reported("没有独立显卡")
            },
            t0
        ),
        Some(LogEvent::TaggingUnavailable { .. })
    ));
}

#[test]
fn pausing_in_the_middle_of_a_run_ends_it_without_a_finish() {
    let t0 = Instant::now();
    let mut log = TaggingLog::new(None);
    log.observe(&running(0), t0);

    assert_eq!(log.observe(&TaggingStatus::Paused, t0), None);
    assert!(matches!(
        log.observe(&running(5), t0),
        Some(LogEvent::TaggingStarted { .. })
    ));
}

#[test]
fn yielding_to_a_full_screen_program_is_logged_once_as_a_pause_with_its_reason() {
    use kinshoko_core::diagnostics::PauseReason;
    let t0 = Instant::now();
    let mut log = TaggingLog::new(None);
    log.observe(&running(0), t0);

    assert_eq!(
        log.observe(&TaggingStatus::YieldedToFullScreen, t0),
        Some(LogEvent::TaggingPaused {
            reason: PauseReason::FullScreen
        })
    );
    assert_eq!(log.observe(&TaggingStatus::YieldedToFullScreen, t0), None);
    assert!(matches!(
        log.observe(&running(1), t0),
        Some(LogEvent::TaggingStarted { .. })
    ));
}
