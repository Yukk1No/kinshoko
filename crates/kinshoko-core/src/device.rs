//! 应用壳：本设备登记的资料库，存放在应用数据目录的 `device.json`。
//!
//! 登记表只记录资料库在哪里，不保存任何整理结果，丢失后可以重新登记。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::library::LibraryInfo;

const FILE: &str = "device.json";
const FORMAT: &str = "kinshoko.device";
const FORMAT_VERSION: u32 = 1;

/// 登记在本设备上的一个资料库。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RegisteredLibrary {
    pub id: String,
    pub name: String,
    #[ts(type = "string")]
    pub root: PathBuf,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    format: String,
    format_version: u32,
    libraries: Vec<RegisteredLibrary>,
    last_opened: Option<String>,
}

/// 本设备的资料库登记表。
pub struct DeviceRegistry {
    path: PathBuf,
    state: State,
}

impl DeviceRegistry {
    /// 读取 `dir/device.json`；不存在时为空表。
    pub fn open(dir: &Path) -> std::io::Result<DeviceRegistry> {
        let path = dir.join(FILE);
        let state = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(std::io::Error::other)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => State {
                format: FORMAT.into(),
                format_version: FORMAT_VERSION,
                ..State::default()
            },
            Err(e) => return Err(e),
        };
        Ok(DeviceRegistry { path, state })
    }

    pub fn libraries(&self) -> &[RegisteredLibrary] {
        &self.state.libraries
    }

    /// 上次打开的资料库。
    pub fn last_opened(&self) -> Option<&RegisteredLibrary> {
        let id = self.state.last_opened.as_ref()?;
        self.state.libraries.iter().find(|l| &l.id == id)
    }

    /// 登记资料库并记为上次打开。同一资料库（按身份）只登记一次，位置与名称随之更新。
    pub fn register(&mut self, info: &LibraryInfo) -> std::io::Result<()> {
        let entry = RegisteredLibrary {
            id: info.id.clone(),
            name: info.name.clone(),
            root: info.root.clone(),
        };
        match self.state.libraries.iter_mut().find(|l| l.id == info.id) {
            Some(existing) => *existing = entry,
            None => self.state.libraries.push(entry),
        }
        self.state.last_opened = Some(info.id.clone());
        self.save()
    }

    /// 取消本设备的登记；资料库文件与整理结果仍保存在原位置。
    pub fn unregister(&mut self, id: &str) -> std::io::Result<()> {
        self.state.libraries.retain(|library| library.id != id);
        if self.state.last_opened.as_deref() == Some(id) {
            self.state.last_opened = None;
        }
        self.save()
    }

    fn save(&self) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&self.state).map_err(std::io::Error::other)?;
        {
            use std::io::Write;
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, &self.path)
    }
}
