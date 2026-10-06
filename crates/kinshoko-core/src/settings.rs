//! 应用壳设置：本设备上与具体资料库无关的偏好（开机自启、全局快捷键）。
//!
//! 保存在应用配置目录的 `settings.json`。后续的设置（钉图、模型选择、诊断开关等）
//! 在 [`SettingsFile`] 上加带默认值的字段即可；不认识的字段原样保留，旧版本打开新版本
//! 写的文件不会丢掉它们。

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

const FILE_NAME: &str = "settings.json";
const BROKEN_FILE_NAME: &str = "settings.broken.json";
const FORMAT_VERSION: u32 = 1;

/// 可以绑定全局快捷键的动作。默认键沿用 Snipaste 的习惯。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ShortcutAction {
    /// 框选屏幕区域截图。
    Capture,
    /// 把剪贴板里的图片钉到桌面。
    PinClipboard,
    /// 把全部钉图收到屏幕边缘，再按一次回到原位。
    HideAllPins,
}

impl ShortcutAction {
    pub const ALL: [ShortcutAction; 3] = [
        ShortcutAction::Capture,
        ShortcutAction::PinClipboard,
        ShortcutAction::HideAllPins,
    ];

    /// 设置界面和提示里的动作名称。
    pub fn label(self) -> &'static str {
        match self {
            ShortcutAction::Capture => "截图",
            ShortcutAction::PinClipboard => "钉剪贴板",
            ShortcutAction::HideAllPins => "收起全部钉图",
        }
    }

    fn default_accelerator(self) -> &'static str {
        match self {
            ShortcutAction::Capture => "F1",
            ShortcutAction::PinClipboard => "F3",
            ShortcutAction::HideAllPins => "F4",
        }
    }
}

/// 磁盘上的格式。字段都有默认值，缺了就按新安装处理。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SettingsFile {
    version: u32,
    autostart: bool,
    /// 每个动作的快捷键；`None` 表示画师清除了绑定。没写到的动作用默认键。
    shortcuts: BTreeMap<ShortcutAction, Option<String>>,
    /// 新版本写入、本版本不认识的字段。
    #[serde(flatten)]
    unknown: serde_json::Map<String, serde_json::Value>,
}

impl Default for SettingsFile {
    fn default() -> Self {
        SettingsFile {
            version: FORMAT_VERSION,
            autostart: true,
            shortcuts: BTreeMap::new(),
            unknown: serde_json::Map::new(),
        }
    }
}

/// 本设备的应用壳设置。每次修改都立即写回磁盘。
#[derive(Debug)]
pub struct AppSettings {
    path: PathBuf,
    file: SettingsFile,
}

#[derive(Debug)]
pub enum SettingsError {
    Io(io::Error),
}

impl fmt::Display for SettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SettingsError::Io(e) => write!(f, "读写设置文件失败：{e}"),
        }
    }
}

impl std::error::Error for SettingsError {}

impl From<io::Error> for SettingsError {
    fn from(e: io::Error) -> Self {
        SettingsError::Io(e)
    }
}

impl AppSettings {
    /// 打开 `dir` 下的设置；目录或文件不存在时按新安装的默认值。
    pub fn open(dir: &Path) -> Result<Self, SettingsError> {
        let path = dir.join(FILE_NAME);
        let file = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(file) => file,
                Err(_) => {
                    // 读不懂的设置不能让常驻进程起不来：留一份原样副本备查，按默认值继续。
                    fs::write(dir.join(BROKEN_FILE_NAME), &bytes)?;
                    SettingsFile::default()
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => SettingsFile::default(),
            Err(e) => return Err(e.into()),
        };
        Ok(AppSettings { path, file })
    }

    pub fn autostart(&self) -> bool {
        self.file.autostart
    }

    pub fn set_autostart(&mut self, on: bool) -> Result<(), SettingsError> {
        self.update(|f| f.autostart = on)
    }

    /// 动作当前绑定的快捷键；`None` 表示未绑定。
    pub fn shortcut(&self, action: ShortcutAction) -> Option<&str> {
        match self.file.shortcuts.get(&action) {
            Some(bound) => bound.as_deref(),
            None => Some(action.default_accelerator()),
        }
    }

    /// 只由 [`crate::GlobalShortcuts`] 调用：设置里的键要和系统里注册的保持一致。
    pub(crate) fn set_shortcut(
        &mut self,
        action: ShortcutAction,
        accelerator: Option<&str>,
    ) -> Result<(), SettingsError> {
        self.update(|f| {
            f.shortcuts.insert(action, accelerator.map(str::to_owned));
        })
    }

    /// 改动先写入磁盘，成功后才生效；写入失败时内存里的设置保持原样。
    fn update(&mut self, change: impl FnOnce(&mut SettingsFile)) -> Result<(), SettingsError> {
        let mut next = self.file.clone();
        change(&mut next);
        next.version = FORMAT_VERSION;
        write_atomically(&self.path, &next)?;
        self.file = next;
        Ok(())
    }
}

/// 先写同目录的临时文件再改名，断电或崩溃时不会留下写了一半的设置。
fn write_atomically(path: &Path, file: &SettingsFile) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let bytes = serde_json::to_vec_pretty(file).map_err(io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}
