//! 桌面状态文件 `desk.json`（#590）：桌面上是哪个参考组、切换列表里有哪些参考组。
//! 不在切换列表里的参考组就是归档；参考组文件里不记这件事，现有参考组因此零迁移。

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
    /// 桌面上的参考组；是一张还没落盘的空桌时为 `None`。
    #[serde(default)]
    pub(super) on_desk: Option<String>,
    /// 切换列表，最近用过的在前；桌面上的参考组落了盘就在其中。
    #[serde(default)]
    pub(super) switch_list: Vec<String>,
}

impl DeskFile {
    pub(super) fn new(on_desk: Option<String>, switch_list: Vec<String>) -> DeskFile {
        DeskFile {
            format: FORMAT.to_owned(),
            format_version: FORMAT_VERSION,
            on_desk,
            switch_list,
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

/// 读 `desk.json`。读不懂（损坏、新版本写的）时按空桌、切换列表为空处理：参考组文件都还在，
/// 都落在归档里，不丢东西；也不再迁移一次，免得把旧钉图又变成一个参考组。
pub(super) fn load(path: &Path) -> io::Result<Loaded> {
    match fs::read(path) {
        Ok(bytes) => Ok(Loaded::Found(
            serde_json::from_slice::<DeskFile>(&bytes)
                .ok()
                .filter(|f| f.format == FORMAT && f.format_version <= FORMAT_VERSION)
                .unwrap_or_else(|| DeskFile::new(None, Vec::new())),
        )),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Loaded::Missing),
        Err(e) => Err(e),
    }
}

pub(super) fn save(path: &Path, file: &DeskFile) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(file).map_err(io::Error::other)?;
    write_atomically(path, &bytes)
}
