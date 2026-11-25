//! 界面语言（#353、#354）。
//!
//! 界面语言同时决定标签显示语言与 Eagle 迁入时只有汉字的名称的语言判断（ADR-0003、ADR-0012）。
//! 进程里只有一个当前值：应用壳启动时定下，切换时改写并通知各窗口；领域代码按 [`current`] 读取。
//!
//! 跟随系统时 `zh-*`（含繁体）用简体中文，其他用英文。画师在 设置 › 通用 的「界面语言」里选
//! 跟随系统（默认）、简体中文或 English（#358），选择存在 [`InterfaceLanguageSetting`]。

use std::fmt;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

/// 简体中文，源语言。
pub const ZH_CN: &str = "zh-CN";
/// 英文。
pub const EN: &str = "en";
/// 有翻译的界面语言。
pub const SUPPORTED: [&str; 2] = [ZH_CN, EN];
/// 指定为跟随系统。
pub const SYSTEM: &str = "system";

static CURRENT: RwLock<&str> = RwLock::new(ZH_CN);

/// 系统显示语言（BCP 47，如 `zh-TW`、`ja-JP`）对应的界面语言：`zh-*` 为简体中文，其他为英文。
pub fn resolve(system: &str) -> &'static str {
    let primary = system.split(['-', '_']).next().unwrap_or_default();
    if primary.eq_ignore_ascii_case("zh") {
        ZH_CN
    } else {
        EN
    }
}

/// 按指定与系统语言定下界面语言。指定某种界面语言时用它；指定 `system`、没有指定
/// 或指定的不认识时跟随系统（#358 的默认）。
pub fn choose(specified: Option<&str>, system: Option<&str>) -> &'static str {
    specified
        .and_then(supported)
        .unwrap_or_else(|| resolve(system.unwrap_or_default()))
}

/// 设置里可选的值：跟随系统或某种界面语言（不分大小写）；其他为 `None`。
pub fn choice(value: &str) -> Option<&'static str> {
    if value.trim().eq_ignore_ascii_case(SYSTEM) {
        Some(SYSTEM)
    } else {
        supported(value)
    }
}

/// 有翻译的界面语言（不分大小写）；其他为 `None`。
pub fn supported(lang: &str) -> Option<&'static str> {
    SUPPORTED
        .into_iter()
        .find(|l| l.eq_ignore_ascii_case(lang.trim()))
}

/// 当前界面语言。
pub fn current() -> &'static str {
    *CURRENT.read().unwrap_or_else(|e| e.into_inner())
}

/// 改为 `lang`；不是有翻译的界面语言时不变，返回 `None`。
pub fn set(lang: &str) -> Option<&'static str> {
    let lang = supported(lang)?;
    *CURRENT.write().unwrap_or_else(|e| e.into_inner()) = lang;
    Some(lang)
}

const FILE_NAME: &str = "interface-language.json";

#[derive(Serialize, Deserialize)]
struct File {
    language: String,
}

/// 设置里选的界面语言（#358）。只属于这台电脑，像界面缩放一样单独存成数据根目录里的
/// `interface-language.json`，不进程序设置备份：换电脑恢复设置时语言仍跟随那台电脑。
/// 每次修改都立即写回磁盘。
#[derive(Debug, Clone)]
pub struct InterfaceLanguageSetting {
    path: PathBuf,
    choice: &'static str,
}

#[derive(Debug)]
pub enum InterfaceLanguageError {
    /// 不是 [`choice`] 认识的值。
    Unsupported(String),
    Io(io::Error),
}

// 不上界面：领域错误交给界面时转成错误代码（command_error），Display 只进日志
impl fmt::Display for InterfaceLanguageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InterfaceLanguageError::Unsupported(lang) => write!(f, "没有这种界面语言：{lang}"),
            InterfaceLanguageError::Io(e) => write!(f, "保存界面语言失败：{e}"),
        }
    }
}

impl std::error::Error for InterfaceLanguageError {}

impl InterfaceLanguageSetting {
    /// 打开 `dir` 下的选择；没有文件、读不懂或不认识时为跟随系统。
    pub fn open(dir: &Path) -> io::Result<Self> {
        let path = dir.join(FILE_NAME);
        let choice = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<File>(&bytes)
                .ok()
                .and_then(|file| choice(&file.language))
                .unwrap_or(SYSTEM),
            Err(e) if e.kind() == io::ErrorKind::NotFound => SYSTEM,
            Err(e) => return Err(e),
        };
        Ok(InterfaceLanguageSetting { path, choice })
    }

    /// 画师选的值：[`SYSTEM`] 或某种界面语言。
    pub fn choice(&self) -> &'static str {
        self.choice
    }

    /// 改选另一个值。先写入磁盘，成功后才生效。
    pub fn set(&mut self, value: &str) -> Result<&'static str, InterfaceLanguageError> {
        let next =
            choice(value).ok_or_else(|| InterfaceLanguageError::Unsupported(value.to_owned()))?;
        write_atomically(
            &self.path,
            &File {
                language: next.to_owned(),
            },
        )
        .map_err(InterfaceLanguageError::Io)?;
        self.choice = next;
        Ok(next)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_systems_get_simplified_chinese_and_others_english() {
        for system in [
            "zh-CN",
            "zh-TW",
            "zh-HK",
            "zh-Hant-TW",
            "zh_SG",
            "zh",
            "ZH-cn",
        ] {
            assert_eq!(resolve(system), ZH_CN, "{system}");
        }
        for system in ["en-US", "ja-JP", "ko-KR", "fr", "", "zhx"] {
            assert_eq!(resolve(system), EN, "{system}");
        }
    }

    #[test]
    fn unspecified_follows_the_system() {
        assert_eq!(choose(None, Some("en-US")), EN);
        assert_eq!(choose(None, Some("zh-CN")), ZH_CN);
        assert_eq!(choose(Some("system"), Some("en-US")), EN);
        assert_eq!(choose(Some("system"), Some("zh-TW")), ZH_CN);
        assert_eq!(choose(Some("system"), None), EN);
        assert_eq!(choose(Some("en"), Some("zh-CN")), EN);
        assert_eq!(choose(Some("zh-CN"), Some("en-US")), ZH_CN);
        assert_eq!(choose(Some("fr"), Some("fr-FR")), EN);
    }

    #[test]
    fn setting_defaults_to_system_and_survives_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let mut setting = InterfaceLanguageSetting::open(dir.path()).unwrap();
        assert_eq!(setting.choice(), SYSTEM);
        assert_eq!(setting.set("EN").unwrap(), EN);
        assert_eq!(
            InterfaceLanguageSetting::open(dir.path()).unwrap().choice(),
            EN
        );
        assert_eq!(setting.set("System").unwrap(), SYSTEM);
        assert_eq!(
            InterfaceLanguageSetting::open(dir.path()).unwrap().choice(),
            SYSTEM
        );
    }

    #[test]
    fn unknown_or_damaged_setting_reads_as_system_and_is_not_saved() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE_NAME), r#"{"language":"ja"}"#).unwrap();
        assert_eq!(
            InterfaceLanguageSetting::open(dir.path()).unwrap().choice(),
            SYSTEM
        );
        fs::write(dir.path().join(FILE_NAME), "not json").unwrap();
        let mut setting = InterfaceLanguageSetting::open(dir.path()).unwrap();
        assert_eq!(setting.choice(), SYSTEM);
        assert!(matches!(
            setting.set("ja"),
            Err(InterfaceLanguageError::Unsupported(_))
        ));
        assert_eq!(setting.choice(), SYSTEM);
    }

    #[test]
    fn only_translated_languages_can_be_set() {
        assert_eq!(supported("EN"), Some(EN));
        assert_eq!(supported("ja"), None);
        assert_eq!(set("ja"), None);
        assert_eq!(current(), ZH_CN);
    }
}
