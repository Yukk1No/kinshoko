//! 运行日志（#219）：错误、警告与关键事件的时间点和耗时，逐行（JSON Lines）写到本机的日志目录，
//! 不上传。能写什么见 [`LogEvent`]。
//!
//! 按画师所在时区的日期切分成 `run-YYYY-MM-DD.jsonl`；一天写满 [`ROLL_BYTES`] 时把这一份改名为
//! `run-YYYY-MM-DD-NNNN.jsonl` 另起一份。只留最近 [`KEEP_DAYS`] 天，全部加起来不超过 [`CAP_BYTES`]：
//! 换日和换份时删掉最旧的，让其余各份不超过 `CAP_BYTES - ROLL_BYTES`，正在写的那份再写满也不超。
//! 取代了旧的“使用日志”（#70），打开时删掉它留下的文件。

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;

use super::log_event::{Level, LogEvent};

const KEEP_DAYS: i64 = 7;
const CAP_BYTES: u64 = 20 * 1024 * 1024;
const ROLL_BYTES: u64 = 4 * 1024 * 1024;
const PREFIX: &str = "run-";
const SUFFIX: &str = ".jsonl";
/// 旧版“使用日志”的文件。
const LEGACY: [&str; 2] = ["usage.jsonl", "usage.1.jsonl"];
/// 导出包里诊断信息的文件名。
const REPORT_NAME: &str = "诊断信息.txt";

/// 画师没选过时运行日志开不开。测试版、候选版构建（版本号带“-”）开启，好让反馈附上日志；
/// 正式版的默认值还没定（#219），暂时关闭。
pub fn run_log_default_for_version(version: &str) -> bool {
    let test_build = version.contains('-');
    if test_build {
        return true;
    }
    false
}

/// 某一时刻与当时所在时区。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Moment {
    pub unix_ms: i64,
    /// 当时本地时间比 UTC 快多少秒。
    pub utc_offset_secs: i32,
}

/// 本地时钟。应用壳按系统时区实现，测试用固定时刻。
pub trait Clock: Send + Sync {
    fn now(&self) -> Moment;
}

/// 本机的运行日志。复制出来的句柄写同一份日志，可在多个线程里共用。
#[derive(Clone)]
pub struct RunLog {
    inner: Arc<Inner>,
}

struct Inner {
    dir: PathBuf,
    clock: Arc<dyn Clock>,
    state: Mutex<State>,
}

struct State {
    enabled: bool,
    current: Option<Current>,
}

/// 正在写的那份。
struct Current {
    day: String,
    file: File,
    len: u64,
}

#[derive(Serialize)]
struct Line<'a> {
    at: String,
    level: Level,
    #[serde(flatten)]
    event: &'a LogEvent,
}

impl std::fmt::Debug for RunLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunLog")
            .field("dir", &self.inner.dir)
            .finish_non_exhaustive()
    }
}

impl RunLog {
    /// `dir` 为日志目录，第一次记录时才创建。打开时删掉过期的日志与旧版使用日志。
    pub fn open(dir: &Path, enabled: bool, clock: Arc<dyn Clock>) -> RunLog {
        for name in LEGACY {
            let _ = fs::remove_file(dir.join(name));
        }
        let today = date(clock.now());
        let _ = prune(dir, &today);
        RunLog {
            inner: Arc::new(Inner {
                dir: dir.to_owned(),
                clock,
                state: Mutex::new(State {
                    enabled,
                    current: None,
                }),
            }),
        }
    }

    pub fn set_enabled(&self, on: bool) {
        let mut state = self.lock();
        state.enabled = on;
        if !on {
            state.current = None;
        }
    }

    /// 记一条；关闭时什么也不做。写入失败只丢掉这一条，不影响调用方。
    pub fn record(&self, event: LogEvent) {
        let mut state = self.lock();
        if !state.enabled {
            return;
        }
        let now = self.inner.clock.now();
        let line = Line {
            at: timestamp(now),
            level: event.level(),
            event: &event,
        };
        let Ok(mut bytes) = serde_json::to_vec(&line) else {
            return;
        };
        bytes.push(b'\n');
        if let Err(e) = self.append(&mut state, &date(now), &bytes) {
            state.current = None;
            eprintln!("写运行日志失败：{}", e.kind());
        }
    }

    fn append(&self, state: &mut State, day: &str, line: &[u8]) -> io::Result<()> {
        let dir = &self.inner.dir;
        if state.current.as_ref().is_some_and(|c| c.day != day) {
            state.current = None;
            prune(dir, day)?;
        }
        if let Some(c) = &state.current
            && c.len + line.len() as u64 > ROLL_BYTES
        {
            state.current = None;
            let piece = next_piece(dir, day)?;
            fs::rename(dir.join(file_name(day)), dir.join(piece))?;
            prune(dir, day)?;
        }
        if state.current.is_none() {
            fs::create_dir_all(dir)?;
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join(file_name(day)))?;
            let len = file.metadata()?.len();
            state.current = Some(Current {
                day: day.to_owned(),
                file,
                len,
            });
        }
        let c = state.current.as_mut().expect("刚打开");
        c.file.write_all(line)?;
        c.len += line.len() as u64;
        Ok(())
    }

    /// 导出成 zip：`诊断信息.txt`（换行改成 Windows 的）与 `logs/` 下留着的全部日志。
    pub fn export(&self, to: &Path, report: &str) -> io::Result<()> {
        use zip::write::SimpleFileOptions;
        let _state = self.lock();
        let mut zip = zip::ZipWriter::new(File::create(to)?);
        let options = SimpleFileOptions::default();
        zip.start_file(REPORT_NAME, options)?;
        zip.write_all(report.replace('\n', "\r\n").as_bytes())?;
        for name in run_files(&self.inner.dir)? {
            zip.start_file(format!("logs/{name}"), options)?;
            zip.write_all(&fs::read(self.inner.dir.join(&name))?)?;
        }
        zip.finish()?;
        Ok(())
    }

    /// 删掉已记录的全部日志。
    pub fn clear(&self) -> io::Result<()> {
        let mut state = self.lock();
        state.current = None;
        for name in run_files(&self.inner.dir)? {
            fs::remove_file(self.inner.dir.join(name))?;
        }
        Ok(())
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn file_name(day: &str) -> String {
    format!("{PREFIX}{day}{SUFFIX}")
}

/// 目录里的运行日志，旧的在前（同一天里换出去的各份排在正在写的那份前面）。
fn run_files(dir: &Path) -> io::Result<Vec<String>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut names = Vec::new();
    for entry in entries {
        if let Ok(name) = entry?.file_name().into_string()
            && day_of(&name).is_some()
        {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

/// `run-YYYY-MM-DD[-NNNN].jsonl` 的日期。
fn day_of(name: &str) -> Option<&str> {
    let rest = name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
    let day = rest.get(..10)?;
    let well_formed = day.bytes().enumerate().all(|(i, b)| match i {
        4 | 7 => b == b'-',
        _ => b.is_ascii_digit(),
    });
    let piece = &rest[10..];
    let piece_ok = piece.is_empty()
        || piece
            .strip_prefix('-')
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    (well_formed && piece_ok).then_some(day)
}

fn next_piece(dir: &Path, day: &str) -> io::Result<String> {
    let last = run_files(dir)?
        .iter()
        .filter_map(|name| {
            let rest = name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
            rest.strip_prefix(day)?
                .strip_prefix('-')?
                .parse::<u32>()
                .ok()
        })
        .max()
        .unwrap_or(0);
    Ok(format!("{PREFIX}{day}-{:04}{SUFFIX}", last + 1))
}

/// 删掉 [`KEEP_DAYS`] 天以前的，再从最旧的删起，直到除 `today` 正在写的那份以外的不超过
/// `CAP_BYTES - ROLL_BYTES`。
fn prune(dir: &Path, today: &str) -> io::Result<()> {
    let oldest_kept = shift_day(today, -(KEEP_DAYS - 1));
    let current = file_name(today);
    let mut others = Vec::new();
    for name in run_files(dir)? {
        if day_of(&name).is_some_and(|day| day < oldest_kept.as_str()) {
            fs::remove_file(dir.join(&name))?;
        } else if name != current {
            let len = fs::metadata(dir.join(&name))?.len();
            others.push((name, len));
        }
    }
    let mut total: u64 = others.iter().map(|(_, len)| len).sum();
    for (name, len) in others {
        if total <= CAP_BYTES - ROLL_BYTES {
            break;
        }
        fs::remove_file(dir.join(name))?;
        total -= len;
    }
    Ok(())
}

fn local_secs(m: Moment) -> i64 {
    m.unix_ms.div_euclid(1000) + i64::from(m.utc_offset_secs)
}

/// 本地日期 `YYYY-MM-DD`。
fn date(m: Moment) -> String {
    day_string(local_secs(m).div_euclid(86_400))
}

fn day_string(days: i64) -> String {
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}")
}

fn shift_day(day: &str, by: i64) -> String {
    let parse = |r: std::ops::Range<usize>| day[r].parse::<i64>().unwrap_or(0);
    day_string(days_from_civil(parse(0..4), parse(5..7), parse(8..10)) + by)
}

/// 本地时间，例如 `2026-10-21T14:03:05.123+08:00`。
fn timestamp(m: Moment) -> String {
    let secs = local_secs(m);
    let in_day = secs.rem_euclid(86_400);
    let offset = m.utc_offset_secs;
    let sign = if offset < 0 { '-' } else { '+' };
    let offset = offset.unsigned_abs();
    format!(
        "{}T{:02}:{:02}:{:02}.{:03}{sign}{:02}:{:02}",
        day_string(secs.div_euclid(86_400)),
        in_day / 3600,
        in_day / 60 % 60,
        in_day % 60,
        m.unix_ms.rem_euclid(1000),
        offset / 3600,
        offset / 60 % 60,
    )
}

/// 1970-01-01 起的天数 → 公历年月日（Howard Hinnant 的算法）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
