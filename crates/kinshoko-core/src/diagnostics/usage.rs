//! 使用日志：默认关闭，开启后把动作逐行（JSON Lines）追加到本机的日志目录，不上传。
//!
//! 每行只有时间（Unix 秒）、动作名与数量。[`UsageEvent`] 没有字符串字段，文件名、路径、
//! 标签文字与图片从类型上就写不进来。超过 [`ROLL_BYTES`] 时滚动到上一份，最多占两份的空间。

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

const CURRENT: &str = "usage.jsonl";
const PREVIOUS: &str = "usage.1.jsonl";
/// 当前文件超过这个大小就滚动。
const ROLL_BYTES: u64 = 1024 * 1024;

/// 记入使用日志的动作。只能带数量，不能带文字。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "event", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UsageEvent {
    AppStarted,
    MainWindowOpened,
    ImportStarted { images: u32 },
    SearchResolved { terms: u32 },
    CaptureStarted,
    PinnedClipboard,
    PinnedCapture,
    PinsHidden,
}

#[derive(Serialize)]
struct Line {
    at: u64,
    #[serde(flatten)]
    event: UsageEvent,
}

/// 本机的使用日志。可在多个线程里共用。
#[derive(Debug)]
pub struct UsageLog {
    dir: PathBuf,
    state: Mutex<State>,
}

#[derive(Debug)]
struct State {
    enabled: bool,
    file: Option<(File, u64)>,
}

impl UsageLog {
    /// `dir` 为日志目录；第一次记录时才创建。
    pub fn open(dir: &Path, enabled: bool) -> UsageLog {
        UsageLog {
            dir: dir.to_owned(),
            state: Mutex::new(State {
                enabled,
                file: None,
            }),
        }
    }

    pub fn set_enabled(&self, on: bool) {
        let mut state = self.lock();
        state.enabled = on;
        if !on {
            state.file = None;
        }
    }

    /// 记一条；关闭时什么也不做。写入失败只丢掉这一条，不影响调用方。
    pub fn record(&self, event: UsageEvent) {
        let mut state = self.lock();
        if !state.enabled {
            return;
        }
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let Ok(mut line) = serde_json::to_vec(&Line { at, event }) else {
            return;
        };
        line.push(b'\n');
        if let Err(e) = self.append(&mut state, &line) {
            state.file = None;
            eprintln!("写使用日志失败：{}", e.kind());
        }
    }

    fn append(&self, state: &mut State, line: &[u8]) -> io::Result<()> {
        if let Some((_, len)) = &state.file
            && *len + line.len() as u64 > ROLL_BYTES
        {
            state.file = None;
            fs::rename(self.dir.join(CURRENT), self.dir.join(PREVIOUS))?;
        }
        if state.file.is_none() {
            fs::create_dir_all(&self.dir)?;
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.dir.join(CURRENT))?;
            let len = file.metadata()?.len();
            state.file = Some((file, len));
        }
        let (file, len) = state.file.as_mut().expect("刚打开");
        file.write_all(line)?;
        *len += line.len() as u64;
        Ok(())
    }

    /// 把已记录的内容（旧的在前）写到 `to`。没有记录时写一个空文件。
    pub fn export(&self, to: &Path) -> io::Result<()> {
        let _state = self.lock();
        let mut out = Vec::new();
        for name in [PREVIOUS, CURRENT] {
            match fs::read(self.dir.join(name)) {
                Ok(bytes) => out.extend_from_slice(&bytes),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        fs::write(to, out)
    }

    /// 删掉已记录的全部内容。
    pub fn clear(&self) -> io::Result<()> {
        let mut state = self.lock();
        state.file = None;
        for name in [PREVIOUS, CURRENT] {
            match fs::remove_file(self.dir.join(name)) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}
