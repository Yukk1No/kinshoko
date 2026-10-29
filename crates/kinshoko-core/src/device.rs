//! 应用壳：本设备登记的资料库，存放在应用数据目录的 `device.json`。
//!
//! 登记表只记录资料库在哪里，不保存任何整理结果，丢失后可以重新登记。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// 改过几次（#313）：缩略图请求不拿登记表的锁，按它判断发布出去的工作区快照是否还对应
    /// 当前的登记。
    generation: Arc<AtomicU64>,
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
        Ok(DeviceRegistry {
            path,
            state,
            generation: Arc::default(),
        })
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
        let mut next = self.state.clone();
        let entry = RegisteredLibrary {
            id: info.id.clone(),
            name: info.name.clone(),
            root: info.root.clone(),
        };
        match next.libraries.iter_mut().find(|l| l.id == info.id) {
            Some(existing) => *existing = entry,
            None => next.libraries.push(entry),
        }
        next.last_opened = Some(info.id.clone());
        self.save(&next)?;
        self.state = next;
        Ok(())
    }

    /// 只登记，不记为上次打开（恢复出的资料库）。同一身份已登记时更新位置与名称。
    pub fn add(&mut self, info: &LibraryInfo) -> std::io::Result<()> {
        let mut next = self.state.clone();
        let entry = RegisteredLibrary {
            id: info.id.clone(),
            name: info.name.clone(),
            root: info.root.clone(),
        };
        match next.libraries.iter_mut().find(|l| l.id == info.id) {
            Some(existing) => *existing = entry,
            None => next.libraries.push(entry),
        }
        self.save(&next)?;
        self.state = next;
        Ok(())
    }

    /// 取消本设备的登记；资料库文件与整理结果仍保存在原位置。
    pub fn unregister(&mut self, id: &str) -> std::io::Result<()> {
        let mut next = self.state.clone();
        next.libraries.retain(|library| library.id != id);
        if next.last_opened.as_deref() == Some(id) {
            next.last_opened = None;
        }
        self.save(&next)?;
        self.state = next;
        Ok(())
    }

    /// 登记表的改动计数与它现在的值，见 [`DeviceRegistry::generation`] 字段。
    pub(crate) fn generation(&self) -> (Arc<AtomicU64>, u64) {
        (
            self.generation.clone(),
            self.generation.load(Ordering::SeqCst),
        )
    }

    fn save(&self, state: &State) -> std::io::Result<()> {
        // 先于写文件前进：写到一半失败也只是多走一次慢路。
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(state).map_err(std::io::Error::other)?;
        {
            use std::io::Write;
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, &self.path)
    }
}
