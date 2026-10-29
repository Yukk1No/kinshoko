//! 界面缩放（#173）：主窗口的 WebView 按固定档位整体放大或缩小，叠加在系统 DPI 缩放之上。
//!
//! 只属于这台电脑的这块屏幕，所以单独存成数据根目录（`data_dirs`）里的 `ui-scale.json`，
//! 不在 [`crate::SettingsSnapshot`] 里：程序设置备份不带它，从备份恢复也不覆盖它。

use std::fmt;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "ui-scale.json";

/// 可选的档位（百分比），从小到大。100 为跟随系统。
pub const UI_SCALE_LEVELS: [u16; 8] = [80, 90, 100, 110, 125, 150, 175, 200];
const DEFAULT_PERCENT: u16 = 100;

#[derive(Serialize, Deserialize)]
struct File {
    percent: u16,
}

/// 本机的界面缩放档位。每次修改都立即写回磁盘。
#[derive(Debug, Clone)]
pub struct UiScale {
    path: PathBuf,
    percent: u16,
}

#[derive(Debug)]
pub enum UiScaleError {
    /// 不是 [`UI_SCALE_LEVELS`] 里的档位。
    Unsupported(u16),
    Io(io::Error),
}

impl fmt::Display for UiScaleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UiScaleError::Unsupported(percent) => write!(f, "没有 {percent}% 这一档界面缩放"),
            UiScaleError::Io(e) => write!(f, "保存界面缩放失败：{e}"),
        }
    }
}

impl std::error::Error for UiScaleError {}

impl UiScale {
    /// 打开 `dir` 下的界面缩放；没有文件、读不懂或不是现有档位时按 100%。
    pub fn open(dir: &Path) -> io::Result<Self> {
        let path = dir.join(FILE_NAME);
        let percent = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<File>(&bytes)
                .ok()
                .map(|file| file.percent)
                .filter(|percent| UI_SCALE_LEVELS.contains(percent))
                .unwrap_or(DEFAULT_PERCENT),
            Err(e) if e.kind() == io::ErrorKind::NotFound => DEFAULT_PERCENT,
            Err(e) => return Err(e),
        };
        Ok(UiScale { path, percent })
    }

    /// 当前档位（百分比）。
    pub fn percent(&self) -> u16 {
        self.percent
    }

    /// 交给 WebView 的缩放倍数，100% 为 1.0。
    pub fn factor(&self) -> f64 {
        f64::from(self.percent) / 100.0
    }

    /// 换到另一个档位。先写入磁盘，成功后才生效。
    pub fn set(&mut self, percent: u16) -> Result<(), UiScaleError> {
        if !UI_SCALE_LEVELS.contains(&percent) {
            return Err(UiScaleError::Unsupported(percent));
        }
        write_atomically(&self.path, &File { percent }).map_err(UiScaleError::Io)?;
        self.percent = percent;
        Ok(())
    }
}

/// 先写同目录的临时文件再改名，不会留下写了一半的文件。
fn write_atomically(path: &Path, file: &File) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let bytes = serde_json::to_vec_pretty(file).map_err(io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    let mut out = fs::File::create(&tmp)?;
    out.write_all(&bytes)?;
    out.sync_all()?;
    drop(out);
    fs::rename(&tmp, path)
}
