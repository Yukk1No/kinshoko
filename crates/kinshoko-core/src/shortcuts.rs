//! 全局快捷键：按应用壳设置注册到系统，记录每个动作是否注册成功，更换时立即生效。
//!
//! 系统热键表是一个 port（[`HotkeyRegistrar`]）：生产中由 Tauri 的全局快捷键插件实现，
//! 测试中用内存假实现。这里只决定注册什么、失败了怎么办，不关心按键怎样到达。

use std::collections::BTreeMap;
use std::fmt;

use serde::Serialize;
use ts_rs::TS;

use crate::settings::{AppSettings, SettingsError, ShortcutAction};

/// 系统的全局热键表。
///
/// 实现者在 `register` 里把按键和 `action` 绑在一起，按下时直接派发该动作；
/// 按键回调不应再回头读取设置或加锁，以免在主线程上等待。
pub trait HotkeyRegistrar {
    /// 注册一个快捷键；失败时返回给画师看的原因，例如被别的程序占用。
    fn register(&mut self, action: ShortcutAction, accelerator: &str) -> Result<(), String>;
    fn unregister(&mut self, accelerator: &str);
}

/// 设置界面显示的一行：动作、绑定的键、以及没能注册的原因。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShortcutBinding {
    pub action: ShortcutAction,
    /// `None` 表示画师清除了这个动作的快捷键。
    pub accelerator: Option<String>,
    /// 有值时这个键当前没有生效（界面显示“未注册”）。
    pub problem: Option<String>,
}

/// 设置界面里应用壳一节的内容。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShellSettingsView {
    pub autostart: bool,
    pub shortcuts: Vec<ShortcutBinding>,
    /// 查找条件里标出相近标签的来源（内置／个人）。
    pub show_approx_source: bool,
}

impl<R: HotkeyRegistrar> GlobalShortcuts<R> {
    pub fn settings_view(&self, settings: &AppSettings) -> ShellSettingsView {
        ShellSettingsView {
            autostart: settings.autostart(),
            shortcuts: self.bindings(settings),
            show_approx_source: settings.show_approx_source(),
        }
    }
}

/// 更换快捷键失败的原因。`Display` 是给画师看的中文。
#[derive(Debug)]
pub enum ShortcutError {
    /// 写法不对，或单独一个字母、数字会妨碍打字。
    Invalid(&'static str),
    /// 这个键已经分给了另一个动作。
    UsedBy(ShortcutAction),
    /// 系统拒绝注册，通常是被别的程序占用。
    Unavailable(String),
    Settings(SettingsError),
}

impl fmt::Display for ShortcutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ShortcutError::Invalid(why) => f.write_str(why),
            ShortcutError::UsedBy(other) => {
                write!(f, "这个快捷键已用于“{}”", other.label())
            }
            ShortcutError::Unavailable(why) => write!(f, "无法使用这个快捷键：{why}"),
            ShortcutError::Settings(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for ShortcutError {}

/// 已注册到系统的全局快捷键。
pub struct GlobalShortcuts<R: HotkeyRegistrar> {
    registrar: R,
    /// 绑定了但没注册上的动作及原因。
    problems: BTreeMap<ShortcutAction, String>,
}

impl<R: HotkeyRegistrar> GlobalShortcuts<R> {
    /// 按设置注册全部快捷键。个别键注册失败不影响其他键，失败原因留给设置界面显示。
    pub fn start(mut registrar: R, settings: &AppSettings) -> Self {
        let mut problems = BTreeMap::new();
        for action in ShortcutAction::ALL {
            if let Some(accelerator) = settings.shortcut(action)
                && let Err(why) = registrar.register(action, accelerator)
            {
                problems.insert(action, why);
            }
        }
        GlobalShortcuts {
            registrar,
            problems,
        }
    }

    /// 把 `action` 换成新的快捷键（`None` 为清除），立即生效并写入设置。
    ///
    /// 新键注册不上时什么都不改，旧键继续生效。
    pub fn rebind(
        &mut self,
        settings: &mut AppSettings,
        action: ShortcutAction,
        accelerator: Option<&str>,
    ) -> Result<(), ShortcutError> {
        let accelerator = accelerator.map(normalize).transpose()?;
        let accelerator = accelerator.as_deref();
        if let Some(new) = accelerator
            && let Some(other) = ShortcutAction::ALL
                .into_iter()
                .find(|&other| other != action && settings.shortcut(other) == Some(new))
        {
            return Err(ShortcutError::UsedBy(other));
        }

        // 正在生效的旧键；没注册上的旧键不算。
        let live_old = settings
            .shortcut(action)
            .filter(|_| !self.problems.contains_key(&action))
            .map(str::to_owned);
        if live_old.is_some() && live_old.as_deref() == accelerator {
            return Ok(());
        }

        // 先放掉旧键再注册新键；新键注册不上或设置写不进去，就把旧键注册回去。
        let restore_old = |registrar: &mut R| {
            if let Some(old) = &live_old {
                let _ = registrar.register(action, old);
            }
        };
        if let Some(old) = &live_old {
            self.registrar.unregister(old);
        }
        if let Some(new) = accelerator
            && let Err(why) = self.registrar.register(action, new)
        {
            restore_old(&mut self.registrar);
            return Err(ShortcutError::Unavailable(why));
        }
        if let Err(e) = settings.set_shortcut(action, accelerator) {
            if let Some(new) = accelerator {
                self.registrar.unregister(new);
            }
            restore_old(&mut self.registrar);
            return Err(ShortcutError::Settings(e));
        }
        self.problems.remove(&action);
        Ok(())
    }

    pub fn bindings(&self, settings: &AppSettings) -> Vec<ShortcutBinding> {
        ShortcutAction::ALL
            .into_iter()
            .map(|action| ShortcutBinding {
                action,
                accelerator: settings.shortcut(action).map(str::to_owned),
                problem: self.problems.get(&action).cloned(),
            })
            .collect()
    }
}

/// 修饰键的统一写法，按保存时的先后顺序排列。
const MODIFIERS: [(&str, &[&str]); 4] = [
    (
        "Ctrl",
        &["ctrl", "control", "cmdorctrl", "commandorcontrol"],
    ),
    ("Alt", &["alt", "option"]),
    ("Shift", &["shift"]),
    ("Super", &["super", "win", "meta", "cmd", "command"]),
];

/// 单独按下会和打字冲突的主键（`KeyboardEvent.code` 的名称，小写）。
const TYPING_KEYS: [&str; 15] = [
    "space",
    "enter",
    "tab",
    "backspace",
    "backquote",
    "minus",
    "equal",
    "bracketleft",
    "bracketright",
    "backslash",
    "semicolon",
    "quote",
    "comma",
    "period",
    "slash",
];

/// 把设置界面传来的组合键整理成统一写法，例如 `shift + control+KeyQ` → `Ctrl+Shift+Q`。
///
/// 主键接受 `KeyboardEvent.code` 的名称，也接受单个字符。字母、数字和标点要配合
/// Ctrl、Alt 或 Win，否则画师在别的程序里打字时会被吞掉。
fn normalize(accelerator: &str) -> Result<String, ShortcutError> {
    let mut modifiers = [false; MODIFIERS.len()];
    let mut main_key: Option<String> = None;
    for part in accelerator.split('+').map(str::trim) {
        if part.is_empty() {
            continue;
        }
        let lower = part.to_ascii_lowercase();
        if let Some(i) = MODIFIERS
            .iter()
            .position(|(_, names)| names.contains(&lower.as_str()))
        {
            modifiers[i] = true;
        } else if main_key.is_some() {
            return Err(ShortcutError::Invalid("一个快捷键只能有一个主键"));
        } else {
            main_key = Some(canonical_key(part));
        }
    }
    let Some(main_key) = main_key else {
        return Err(ShortcutError::Invalid("快捷键需要一个主键，不能只有修饰键"));
    };

    let types_text = main_key.chars().count() == 1
        || TYPING_KEYS.contains(&main_key.to_ascii_lowercase().as_str());
    let (ctrl, alt, super_) = (modifiers[0], modifiers[1], modifiers[3]);
    if types_text && !(ctrl || alt || super_) {
        return Err(ShortcutError::Invalid(
            "字母、数字和符号键要配合 Ctrl、Alt 或 Win，否则会妨碍打字",
        ));
    }

    let mut parts: Vec<&str> = MODIFIERS
        .iter()
        .zip(modifiers)
        .filter(|(_, on)| *on)
        .map(|((name, _), _)| *name)
        .collect();
    parts.push(&main_key);
    Ok(parts.join("+"))
}

/// `KeyQ` → `Q`，`Digit2` → `2`，`f4` → `F4`，`space` → `Space`。
fn canonical_key(key: &str) -> String {
    let lower = key.to_ascii_lowercase();
    let strip = |prefix: &str| {
        lower
            .strip_prefix(prefix)
            .filter(|rest| rest.len() == 1)
            .map(str::to_ascii_uppercase)
    };
    if let Some(key) = strip("key").or_else(|| strip("digit")) {
        return key;
    }
    let mut chars = key.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}
