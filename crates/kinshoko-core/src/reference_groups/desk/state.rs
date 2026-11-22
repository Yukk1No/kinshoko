//! 桌面状态文件 `desk.json`（#590）：桌面上是哪个参考组、哪些参考组设为常用（有序）、
//! 各参考组最近用过的时间。参考组文件里不记这两件事，现有参考组因此零迁移，备份、参考组包照旧按文件工作。

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::super::captures::write_atomically;

pub(super) const DESK_FILE: &str = "desk.json";
const FORMAT: &str = "kinshoko.desk";
const FORMAT_VERSION: u32 = 1;

/// 磁盘上的桌面状态。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeskFile {
    format: String,
    format_version: u32,
    /// 桌面上的参考组；桌面空着时为 `None`。
    #[serde(default)]
    pub(super) on_desk: Option<String>,
    /// 设为常用的参考组，按画师设的先后。
    #[serde(default)]
    pub(super) favorites: Vec<String>,
    /// 各参考组最近用过（摆上桌面、离开桌面）的时间，毫秒。没有记录的按参考组的保存时间算。
    #[serde(default)]
    pub(super) used_at: BTreeMap<String, i64>,
}

impl DeskFile {
    pub(super) fn new(
        on_desk: Option<String>,
        favorites: Vec<String>,
        used_at: BTreeMap<String, i64>,
    ) -> DeskFile {
        DeskFile {
            format: FORMAT.to_owned(),
            format_version: FORMAT_VERSION,
            on_desk,
            favorites,
            used_at,
        }
    }
}

/// 读到的桌面状态。
pub(super) enum Loaded {
    /// 还没有桌面状态文件：第一次打开，要迁移。
    Missing,
    Found(DeskFile),
}

pub(super) fn path(dir: &Path) -> PathBuf {
    dir.join(DESK_FILE)
}

/// 读 `desk.json`。读不懂（损坏、新版本写的）时报错，文件原样留着：启动时不启动、说明原因
/// （Lou 2026-11-22，#632），免得把空桌写回去盖掉收藏与桌面上是哪组。
pub(super) fn load(path: &Path) -> io::Result<Loaded> {
    match fs::read(path) {
        Ok(bytes) => {
            let file = serde_json::from_slice::<DeskFile>(&bytes)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            if file.format != FORMAT || file.format_version > FORMAT_VERSION {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    // 与 serde 的解析错误一样只作原因写进说明，界面文字在 `ui_text::DeskUnreadable`。
                    format!(
                        "unsupported desk state {} version {}",
                        file.format, file.format_version
                    ),
                ));
            }
            Ok(Loaded::Found(file))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Loaded::Missing),
        Err(e) => Err(e),
    }
}

pub(super) fn save(path: &Path, file: &DeskFile) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(file).map_err(io::Error::other)?;
    write_atomically(path, &bytes)
}
