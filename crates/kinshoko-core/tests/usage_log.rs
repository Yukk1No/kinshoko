//! 使用日志（#70）：默认关闭，只写本机；画师决定是否导出。记录的只有动作与数量，
//! 没有文件名、路径、标签文字或图片。

use kinshoko_core::diagnostics::{UsageEvent, UsageLog};

fn exported(log: &UsageLog) -> String {
    let dir = tempfile::tempdir().unwrap();
    let to = dir.path().join("usage.jsonl");
    log.export(&to).unwrap();
    std::fs::read_to_string(to).unwrap()
}

#[test]
fn a_disabled_usage_log_writes_nothing_to_disk() {
    let dir = tempfile::tempdir().unwrap();
    let log = UsageLog::open(dir.path(), false);

    log.record(UsageEvent::AppStarted);
    log.record(UsageEvent::ImportStarted { paths: 3 });

    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    assert_eq!(exported(&log), "");
}

#[test]
fn an_enabled_usage_log_keeps_one_line_per_action_with_counts_only() {
    let dir = tempfile::tempdir().unwrap();
    let log = UsageLog::open(dir.path(), true);

    log.record(UsageEvent::AppStarted);
    log.record(UsageEvent::ImportStarted { paths: 3 });
    log.record(UsageEvent::SearchResolved { terms: 2 });

    let text = exported(&log);
    let lines: Vec<serde_json::Value> = text
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0]["event"], "appStarted");
    assert_eq!(lines[1]["event"], "importStarted");
    assert_eq!(lines[1]["paths"], 3);
    assert_eq!(lines[2]["terms"], 2);
    assert!(
        lines
            .iter()
            .all(|l| l["at"].as_u64().unwrap() > 1_700_000_000)
    );
}

#[test]
fn the_log_survives_a_restart_and_turning_it_off_stops_recording_but_keeps_what_was_written() {
    let dir = tempfile::tempdir().unwrap();
    UsageLog::open(dir.path(), true).record(UsageEvent::CaptureStarted);

    let log = UsageLog::open(dir.path(), true);
    log.record(UsageEvent::PinnedCapture);
    log.set_enabled(false);
    log.record(UsageEvent::PinsHidden);

    let text = exported(&log);
    assert_eq!(text.lines().count(), 2, "{text}");
    assert!(!text.contains("pinsHidden"));
}

#[test]
fn clearing_the_log_removes_everything_recorded() {
    let dir = tempfile::tempdir().unwrap();
    let log = UsageLog::open(dir.path(), true);
    log.record(UsageEvent::AppStarted);

    log.clear().unwrap();
    log.record(UsageEvent::MainWindowOpened);

    let text = exported(&log);
    assert_eq!(text.lines().count(), 1);
    assert!(text.contains("mainWindowOpened"));
}

#[test]
fn a_long_running_log_stays_bounded_and_keeps_the_newest_actions() {
    let dir = tempfile::tempdir().unwrap();
    let log = UsageLog::open(dir.path(), true);
    for paths in 0..40_000 {
        log.record(UsageEvent::ImportStarted { paths });
    }

    let size: u64 = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().metadata().unwrap().len())
        .sum();
    assert!(size <= 2 * 1024 * 1024 + 4096, "日志占用 {size} 字节");
    let text = exported(&log);
    assert!(text.ends_with("\"paths\":39999}\n"), "最新的一条在最后");
    assert!(!text.contains("\"paths\":0}"), "最早的已滚动掉");
}
