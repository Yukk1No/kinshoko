//! 截图历史：最近的截图。
//!
//! 保存在应用数据目录的 `captures/`：每张截图一个 PNG（`<id>.png`，无损、内嵌截取时的
//! 显示器配置文件），加一份索引 `history.json`。

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{PinContent, SavedPin, Screenshot};
use crate::Library;
use crate::library::{ImportOutcome, ImportSource};

const INDEX_FILE: &str = "history.json";
const FORMAT_VERSION: u32 = 1;

/// `history.json` 的内容。
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Index {
    format_version: u32,
    entries: Vec<Stored>,
}

/// 索引里的一条记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    id: String,
    width: u32,
    height: u32,
    created_at: i64,
    /// 画师删除了它，但还有钉图在显示：不再列出，钉图关闭后删除文件。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    deleted: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    collected: Vec<CollectedCapture>,
}

/// 截图收藏进资料库后成为的参考图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CollectedCapture {
    pub library_id: String,
    pub image_id: String,
}

/// 保存参考组时对一张截图的决定。空资料库表示明确不把它加入参考组。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CaptureChoice {
    pub capture_id: String,
    pub library_id: Option<String>,
    #[serde(default)]
    pub folder_id: Option<String>,
}

/// 截图历史保留的张数（#7：5～10 张）。超出的旧截图在没被钉住时丢弃。
pub const HISTORY_LIMIT: usize = 10;

/// 截图历史中的一张截图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CaptureEntry {
    pub id: String,
    pub width: u32,
    pub height: u32,
    /// 截取时间，Unix 毫秒。
    #[ts(type = "number")]
    pub created_at: i64,
    /// 还有钉图在显示它。钉住的截图不会因为太旧被丢弃。
    pub pinned: bool,
    /// 已收藏进哪些资料库。
    pub collected: Vec<CollectedCapture>,
}

/// 截图历史的错误。`Display` 是给画师看的中文说明。
#[derive(Debug)]
pub enum HistoryError {
    /// 截图已不在历史中。
    Unknown,
    /// 资料库没能收下这张截图，附导入给出的原因。
    Collect(String),
    Io(io::Error),
    Image(image::ImageError),
}

impl fmt::Display for HistoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HistoryError::Unknown => write!(f, "截图已不在截图历史中"),
            HistoryError::Collect(why) => write!(f, "收藏失败：{why}"),
            HistoryError::Io(e) => write!(f, "读写截图失败：{e}"),
            HistoryError::Image(e) => write!(f, "保存截图失败：{e}"),
        }
    }
}

impl std::error::Error for HistoryError {}

impl From<io::Error> for HistoryError {
    fn from(e: io::Error) -> Self {
        HistoryError::Io(e)
    }
}

impl From<image::ImageError> for HistoryError {
    fn from(e: image::ImageError) -> Self {
        HistoryError::Image(e)
    }
}

/// Encoded screenshot data with no persistent side effects yet.
#[derive(Debug)]
pub(crate) struct PreparedCapture {
    png: Vec<u8>,
    width: u32,
    height: u32,
}

/// 截图历史。不是线程安全的；应用壳把它放在锁里。
pub struct CaptureHistory {
    dir: PathBuf,
    /// 从新到旧。
    entries: Vec<Stored>,
    /// 每张截图正被几个钉图显示。只在本次运行中有效，不写入索引。
    pins: HashMap<String, usize>,
}

impl CaptureHistory {
    /// 打开 `dir` 下的截图历史；没有时新建。
    pub fn open(dir: &Path) -> Result<CaptureHistory, HistoryError> {
        fs::create_dir_all(dir)?;
        // 索引读不懂时从空历史开始，但不清理文件：它们可能还是好的截图。
        let (index, trusted) = match fs::read(dir.join(INDEX_FILE)) {
            Ok(bytes) => match serde_json::from_slice::<Index>(&bytes) {
                Ok(index) => (index, true),
                Err(_) => (Index::default(), false),
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => (Index::default(), true),
            Err(e) => return Err(e.into()),
        };
        let history = CaptureHistory {
            dir: dir.to_path_buf(),
            entries: index.entries,
            pins: HashMap::new(),
        };
        if trusted {
            history.remove_strays();
        }
        Ok(history)
    }

    /// 删除索引里没有的截图文件和写到一半的临时文件（上次运行中断留下的）。
    fn remove_strays(&self) {
        let Ok(dir) = fs::read_dir(&self.dir) else {
            return;
        };
        for file in dir.flatten() {
            let name = file.file_name();
            let name = name.to_string_lossy();
            let stray = if let Some(id) = name.strip_suffix(".png") {
                !self.entries.iter().any(|s| s.id == id)
            } else {
                name.ends_with(".png.tmp") || name.ends_with(".json.tmp")
            };
            if stray {
                let _ = fs::remove_file(file.path());
            }
        }
    }

    /// 存下一张新截图，放在历史最前面。
    pub fn add(&mut self, shot: &Screenshot) -> Result<CaptureEntry, HistoryError> {
        self.add_prepared(Self::prepare(shot)?)
    }

    pub(crate) fn prepare(shot: &Screenshot) -> Result<PreparedCapture, HistoryError> {
        let mut png = Vec::new();
        shot.write_png(&mut png, false)?;
        Ok(PreparedCapture {
            png,
            width: shot.image.width(),
            height: shot.image.height(),
        })
    }

    pub(crate) fn add_prepared(
        &mut self,
        shot: PreparedCapture,
    ) -> Result<CaptureEntry, HistoryError> {
        let stored = Stored {
            id: uuid::Uuid::now_v7().simple().to_string(),
            width: shot.width,
            height: shot.height,
            created_at: crate::library::now_ms(),
            deleted: false,
            collected: Vec::new(),
        };
        let path = self.path_of(&stored.id);
        let tmp = path.with_extension("png.tmp");
        fs::write(&tmp, shot.png)?;
        fs::rename(&tmp, &path)?;
        let entry = self.view(&stored);
        self.entries.insert(0, stored);
        self.discard_old();
        self.save()?;
        Ok(entry)
    }

    /// 历史中的截图，从新到旧。
    pub fn entries(&self) -> Vec<CaptureEntry> {
        self.entries
            .iter()
            .filter(|s| !s.deleted)
            .map(|s| self.view(s))
            .collect()
    }

    /// 已删除但仍被钉住的截图也可用，保存参考组时不能无声漏掉。
    pub fn entry(&self, id: &str) -> Option<CaptureEntry> {
        self.entries
            .iter()
            .find(|e| e.id == id)
            .map(|e| self.view(e))
    }

    /// 从历史中删除一张截图。还有钉图在显示它时，文件留到钉图关闭。
    pub fn delete(&mut self, id: &str) -> Result<(), HistoryError> {
        let stored = self
            .entries
            .iter_mut()
            .find(|s| s.id == id && !s.deleted)
            .ok_or(HistoryError::Unknown)?;
        stored.deleted = true;
        self.discard_old();
        self.save()?;
        Ok(())
    }

    /// 收藏：把截图经资料库的普通导入入口存为参考图（技术路线：剪贴板与收藏截图都是
    /// 普通文件来源），等导入完成后记下成为了哪张参考图。导入事件照常推送给界面。
    ///
    /// 原文件按字节收进资料库、从不重编码，截取时的显示器配置文件随文件保留。
    /// 同一截图再次收藏时，资料库按内容去重，得到同一张参考图。
    pub fn collect(
        &mut self,
        id: &str,
        library: &Library,
    ) -> Result<CollectedCapture, HistoryError> {
        let path = self.file(id).ok_or(HistoryError::Unknown)?;
        let report = library.import(ImportSource { paths: vec![path] }).wait();
        let image_id = match report.items.into_iter().next().map(|item| item.outcome) {
            Some(ImportOutcome::ReadFailed { reason }) => {
                return Err(HistoryError::Collect(reason));
            }
            Some(outcome) if outcome.image_id().is_some() => {
                outcome.image_id().unwrap_or_default().to_owned()
            }
            _ => {
                return Err(HistoryError::Collect("资料库没有收下这张截图".to_owned()));
            }
        };
        let collected = CollectedCapture {
            library_id: library.info().id.clone(),
            image_id,
        };
        if let Some(stored) = self.entries.iter_mut().find(|s| s.id == id)
            && !stored.collected.contains(&collected)
        {
            stored.collected.push(collected.clone());
            self.save()?;
        }
        Ok(collected)
    }

    /// 收藏截图钉图并连接成为的参考图。裁切、摆放、透明度与锁定保持原样。
    /// 返回值可直接交给 ReferenceGroups；普通参考图钉图原样返回。
    pub fn collect_pin(
        &mut self,
        pin: &SavedPin,
        library: &Library,
    ) -> Result<SavedPin, HistoryError> {
        let PinContent::Capture { capture_id } = &pin.content else {
            return Ok(pin.clone());
        };
        let entry = self.entry(capture_id).ok_or(HistoryError::Unknown)?;
        let collected = self.collect(capture_id, library)?;
        let mut reference = pin.clone();
        reference.content = PinContent::Reference {
            library_id: collected.library_id,
            image_id: collected.image_id,
            source_width: entry.width,
            source_height: entry.height,
        };
        Ok(reference)
    }

    /// 一个钉图开始显示这张截图。
    pub fn pin(&mut self, id: &str) {
        *self.pins.entry(id.to_owned()).or_default() += 1;
    }

    /// 显示这张截图的一个钉图关闭了；没有钉图再显示它时，按规则丢弃。
    pub fn unpin(&mut self, id: &str) {
        if let Some(count) = self.pins.get_mut(id) {
            *count -= 1;
            if *count == 0 {
                self.pins.remove(id);
            }
        }
        if self.discard_old() {
            let _ = self.save();
        }
    }

    fn is_pinned(&self, id: &str) -> bool {
        self.pins.contains_key(id)
    }

    /// 丢弃已删除的截图和超出 [`HISTORY_LIMIT`] 的旧截图，还被钉住的除外。
    /// 返回是否丢弃了截图。
    fn discard_old(&mut self) -> bool {
        let mut discarded = Vec::new();
        let mut listed = 0;
        let entries = std::mem::take(&mut self.entries);
        for stored in entries {
            let keep = if stored.deleted {
                self.is_pinned(&stored.id)
            } else {
                listed += 1;
                listed <= HISTORY_LIMIT || self.is_pinned(&stored.id)
            };
            if keep {
                self.entries.push(stored);
            } else {
                discarded.push(stored.id);
            }
        }
        for id in &discarded {
            // 删不掉（例如被别的程序占用）只是留下一个孤立文件，下次打开时清理。
            let _ = fs::remove_file(self.path_of(id));
        }
        !discarded.is_empty()
    }

    fn view(&self, stored: &Stored) -> CaptureEntry {
        CaptureEntry {
            id: stored.id.clone(),
            width: stored.width,
            height: stored.height,
            created_at: stored.created_at,
            pinned: self.is_pinned(&stored.id),
            collected: stored.collected.clone(),
        }
    }

    /// 截图文件的位置；不在历史中时为 `None`。
    pub fn file(&self, id: &str) -> Option<PathBuf> {
        self.entries
            .iter()
            .any(|e| e.id == id)
            .then(|| self.path_of(id))
    }

    /// 先写临时文件再改名，写到一半断电也不会留下半份索引。
    fn save(&self) -> io::Result<()> {
        let index = Index {
            format_version: FORMAT_VERSION,
            entries: self.entries.clone(),
        };
        let path = self.dir.join(INDEX_FILE);
        let tmp = path.with_extension("json.tmp");
        fs::write(
            &tmp,
            serde_json::to_vec_pretty(&index).map_err(io::Error::other)?,
        )?;
        fs::rename(&tmp, &path)
    }

    fn path_of(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.png"))
    }
}
