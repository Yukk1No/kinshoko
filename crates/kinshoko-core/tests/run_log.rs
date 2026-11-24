//! 运行日志（#219）：错误、警告与关键事件的时间点和耗时，只写本机，按天切分，
//! 最多保留 7 天或 20 MB；画师决定是否连同诊断信息导出。日志里没有文件名、路径、
//! 标签文字或图片。

use std::sync::{Arc, Mutex};

use kinshoko_core::diagnostics::{Clock, Detail, LogEvent, Moment, RunLog};

/// 东八区 2026-10-21 14:03:05.123。
const OCT_21_AFTERNOON: i64 = 1_792_562_585_123;
const DAY_MS: i64 = 86_400_000;
const CHINA: i32 = 8 * 3600;

#[derive(Clone)]
struct TestClock(Arc<Mutex<Moment>>);

impl TestClock {
    fn at(unix_ms: i64) -> TestClock {
        TestClock(Arc::new(Mutex::new(Moment {
            unix_ms,
            utc_offset_secs: CHINA,
        })))
    }

    fn advance(&self, ms: i64) {
        self.0.lock().unwrap().unix_ms += ms;
    }
}

impl Clock for TestClock {
    fn now(&self) -> Moment {
        *self.0.lock().unwrap()
    }
}

fn open(dir: &std::path::Path, clock: &TestClock) -> RunLog {
    RunLog::open(dir, true, Arc::new(clock.clone()))
}

fn files(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

fn lines(path: &std::path::Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn each_event_is_one_line_in_the_file_for_the_local_day_with_local_time_and_level() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(OCT_21_AFTERNOON);
    let log = open(dir.path(), &clock);

    log.record(LogEvent::CaptureStarted);
    log.record(LogEvent::ImportStarted {
        library: None,
        paths: 3,
    });

    assert_eq!(files(dir.path()), ["run-2026-10-21.jsonl"]);
    let lines = lines(&dir.path().join("run-2026-10-21.jsonl"));
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["at"], "2026-10-21T14:03:05.123+08:00");
    assert_eq!(lines[0]["level"], "info");
    assert_eq!(lines[0]["event"], "captureStarted");
    assert_eq!(lines[1]["paths"], 3);
}

/// 首屏各步的耗时（#313）：步骤名、毫秒数，有数量时带上数量。
#[test]
fn a_timing_is_one_line_with_its_step_and_milliseconds() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(OCT_21_AFTERNOON);
    let log = open(dir.path(), &clock);

    log.record(LogEvent::Took {
        step: "浏览：一页",
        ms: 42,
        count: Some(120),
    });
    log.record(LogEvent::Took {
        step: "打开资料库：合计",
        ms: 6500,
        count: None,
    });

    let lines = lines(&dir.path().join("run-2026-10-21.jsonl"));
    assert_eq!(lines[0]["event"], "took");
    assert_eq!(lines[0]["step"], "浏览：一页");
    assert_eq!(lines[0]["ms"], 42);
    assert_eq!(lines[0]["count"], 120);
    assert_eq!(lines[1]["ms"], 6500);
    assert!(lines[1].get("count").is_none());
}

#[test]
fn a_disabled_log_writes_nothing_and_turning_it_off_keeps_what_was_written() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(OCT_21_AFTERNOON);
    let log = RunLog::open(dir.path(), false, Arc::new(clock.clone()));
    log.record(LogEvent::CaptureStarted);
    assert!(files(dir.path()).is_empty());

    log.set_enabled(true);
    log.record(LogEvent::CaptureStarted);
    log.set_enabled(false);
    log.record(LogEvent::PinsHidden);

    let lines = lines(&dir.path().join("run-2026-10-21.jsonl"));
    assert_eq!(lines.len(), 1);
}

#[test]
fn local_midnight_starts_a_new_file() {
    let dir = tempfile::tempdir().unwrap();
    // 东八区 23:59:59。
    let clock = TestClock::at(1_792_598_399_000);
    let log = open(dir.path(), &clock);
    log.record(LogEvent::CaptureStarted);
    clock.advance(2_000);
    log.record(LogEvent::CaptureStarted);

    assert_eq!(
        files(dir.path()),
        ["run-2026-10-21.jsonl", "run-2026-10-22.jsonl"]
    );
}

#[test]
fn days_older_than_a_week_are_removed() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(OCT_21_AFTERNOON);
    let log = open(dir.path(), &clock);
    for _ in 0..10 {
        log.record(LogEvent::CaptureStarted);
        clock.advance(DAY_MS);
    }
    log.record(LogEvent::CaptureStarted);

    assert_eq!(
        files(dir.path()),
        [
            "run-2026-10-25.jsonl",
            "run-2026-10-26.jsonl",
            "run-2026-10-27.jsonl",
            "run-2026-10-28.jsonl",
            "run-2026-10-29.jsonl",
            "run-2026-10-30.jsonl",
            "run-2026-10-31.jsonl",
        ]
    );
}

#[test]
fn a_restart_prunes_old_days_and_keeps_appending_today() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(OCT_21_AFTERNOON);
    open(dir.path(), &clock).record(LogEvent::CaptureStarted);
    clock.advance(8 * DAY_MS);
    open(dir.path(), &clock).record(LogEvent::CaptureStarted);
    open(dir.path(), &clock).record(LogEvent::PinsHidden);

    assert_eq!(files(dir.path()), ["run-2026-10-29.jsonl"]);
    assert_eq!(lines(&dir.path().join("run-2026-10-29.jsonl")).len(), 2);
}

#[test]
fn the_log_never_takes_more_than_twenty_megabytes_and_keeps_the_newest_events() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(OCT_21_AFTERNOON);
    let log = open(dir.path(), &clock);
    let detail = Detail::new("x".repeat(900));
    for day in 0..3 {
        for n in 0..12_000u32 {
            log.record(LogEvent::Problem {
                level: kinshoko_core::diagnostics::Level::Warn,
                site: "测试",
                detail: detail.clone(),
            });
            if n == 0 && day == 2 {
                log.record(LogEvent::ImportStarted {
                    library: None,
                    paths: 424_242,
                });
            }
        }
        clock.advance(DAY_MS);
    }

    let size: u64 = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().metadata().unwrap().len())
        .sum();
    assert!(size <= 20 * 1024 * 1024, "日志占用 {size} 字节");
    let bundle = dir.path().join("..").join("bundle-size.zip");
    log.export(&bundle, "诊断").unwrap();
    let text = unzip_logs(&bundle);
    assert!(text.contains("424242"), "最新一天的事件还在");
    std::fs::remove_file(bundle).unwrap();
}

/// 导出包里的全部日志文字，按文件名顺序拼起来。
fn unzip_logs(path: &std::path::Path) -> String {
    use std::io::Read as _;
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut names: Vec<String> = zip.file_names().map(str::to_owned).collect();
    names.sort();
    let mut text = String::new();
    for name in names.iter().filter(|n| n.starts_with("logs/")) {
        zip.by_name(name)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
    }
    text
}

#[test]
fn the_export_holds_the_diagnostics_report_and_the_recent_days_of_logs() {
    let dir = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let clock = TestClock::at(OCT_21_AFTERNOON);
    let log = open(dir.path(), &clock);
    log.record(LogEvent::CaptureStarted);
    clock.advance(DAY_MS);
    log.record(LogEvent::PinsHidden);

    let bundle = out.path().join("kinshoko.zip");
    log.export(&bundle, "Kinshoko 诊断信息\n版本 1.0.0-beta.2\n")
        .unwrap();

    let mut zip = zip::ZipArchive::new(std::fs::File::open(&bundle).unwrap()).unwrap();
    let mut names: Vec<String> = zip.file_names().map(str::to_owned).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "logs/run-2026-10-21.jsonl",
            "logs/run-2026-10-22.jsonl",
            "诊断信息.txt"
        ]
    );
    let mut report = String::new();
    std::io::Read::read_to_string(&mut zip.by_name("诊断信息.txt").unwrap(), &mut report).unwrap();
    assert_eq!(report, "Kinshoko 诊断信息\r\n版本 1.0.0-beta.2\r\n");
    let text = unzip_logs(&bundle);
    assert!(text.contains("captureStarted") && text.contains("pinsHidden"));
}

#[test]
fn error_details_lose_paths_and_file_names_before_they_reach_the_disk() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(OCT_21_AFTERNOON);
    let log = open(dir.path(), &clock);
    let error = std::io::Error::other(r"无法打开 C:\Users\画师\参考\秘密角色.png：拒绝访问");

    log.record(LogEvent::Problem {
        level: kinshoko_core::diagnostics::Level::Error,
        site: "钉剪贴板",
        detail: Detail::new(&error),
    });
    log.record(LogEvent::Frontend {
        level: kinshoko_core::diagnostics::Level::Error,
        detail: Detail::new("TypeError at http://tauri.localhost/assets/index.js:12 秘密角色.png"),
    });

    let text = std::fs::read_to_string(dir.path().join("run-2026-10-21.jsonl")).unwrap();
    assert!(!text.contains("画师"), "{text}");
    assert!(!text.contains("秘密角色"), "{text}");
    assert!(!text.contains("tauri.localhost"), "{text}");
    let lines = lines(&dir.path().join("run-2026-10-21.jsonl"));
    assert_eq!(lines[0]["level"], "error");
    assert_eq!(lines[0]["site"], "钉剪贴板");
    assert_eq!(lines[0]["detail"], "无法打开 <路径>");
}

#[test]
fn a_library_appears_only_by_its_number() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(OCT_21_AFTERNOON);
    let log = open(dir.path(), &clock);

    log.record(LogEvent::ImportStarted {
        library: Some(kinshoko_core::diagnostics::LibraryNo::from_index(1)),
        paths: 2,
    });

    let lines = lines(&dir.path().join("run-2026-10-21.jsonl"));
    assert_eq!(lines[0]["library"], "资料库 #2");
}

#[test]
fn clearing_removes_every_day() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(OCT_21_AFTERNOON);
    let log = open(dir.path(), &clock);
    log.record(LogEvent::CaptureStarted);
    clock.advance(DAY_MS);
    log.record(LogEvent::CaptureStarted);

    log.clear().unwrap();
    log.record(LogEvent::PinsHidden);

    assert_eq!(files(dir.path()), ["run-2026-10-22.jsonl"]);
    assert_eq!(lines(&dir.path().join("run-2026-10-22.jsonl")).len(), 1);
}

#[test]
fn the_old_usage_log_is_merged_away_and_other_files_are_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["usage.jsonl", "usage.1.jsonl", "notes.txt"] {
        std::fs::write(dir.path().join(name), "{}\n").unwrap();
    }
    let clock = TestClock::at(OCT_21_AFTERNOON);
    let log = open(dir.path(), &clock);
    log.record(LogEvent::CaptureStarted);
    log.clear().unwrap();

    assert_eq!(files(dir.path()), ["notes.txt"]);
}

static CAPTURED: std::sync::Mutex<Vec<LogEvent>> = std::sync::Mutex::new(Vec::new());

fn capture(event: LogEvent) {
    CAPTURED.lock().unwrap().push(event);
}

/// 等锁、持锁 100 毫秒以上各记一条，带取锁处的源文件名（不含目录）与行号；短的不记（#337）。
#[test]
fn long_lock_waits_and_holds_are_recorded_with_where_the_lock_was_taken() {
    use kinshoko_core::diagnostics::{HeldLock, set_timing_sink};
    use std::time::{Duration, Instant};
    set_timing_sink(capture);
    let site = std::panic::Location::caller();

    drop(HeldLock::acquired("测试锁：短", site, Instant::now()));
    {
        let _held = HeldLock::acquired(
            "测试锁：长",
            site,
            Instant::now() - Duration::from_millis(150),
        );
        std::thread::sleep(Duration::from_millis(120));
    }

    let events: Vec<serde_json::Value> = CAPTURED
        .lock()
        .unwrap()
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .filter(|e| {
            e["lock"]
                .as_str()
                .is_some_and(|lock| lock.starts_with("测试锁"))
        })
        .collect();
    assert_eq!(events.len(), 2, "{events:?}");
    assert_eq!(events[0]["event"], "lockWaited");
    assert_eq!(events[1]["event"], "lockHeld");
    for event in &events {
        assert_eq!(event["lock"], "测试锁：长");
        assert_eq!(event["source"], "run_log");
        assert_eq!(event["line"], site.line());
        assert!(event["ms"].as_u64().unwrap() >= 100, "{event}");
    }
}

/// 写进日志文件的锁事件仍带着这一行的时间（`at`），取锁处另起一个字段（#337）。
#[test]
fn a_lock_event_in_the_file_keeps_its_timestamp() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(OCT_21_AFTERNOON);
    let log = open(dir.path(), &clock);

    log.record(LogEvent::LockHeld {
        lock: "统一标签目录",
        source: "workspace",
        line: 212,
        ms: 1380,
    });

    let text = std::fs::read_to_string(dir.path().join("run-2026-10-21.jsonl")).unwrap();
    assert_eq!(text.matches("\"at\"").count(), 1, "{text}");
    let lines = lines(&dir.path().join("run-2026-10-21.jsonl"));
    assert_eq!(lines[0]["at"], "2026-10-21T14:03:05.123+08:00");
    assert_eq!(lines[0]["source"], "workspace");
    assert_eq!(lines[0]["line"], 212);
}
