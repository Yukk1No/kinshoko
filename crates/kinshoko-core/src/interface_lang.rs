//! 界面语言（#353、#354）。
//!
//! 界面语言同时决定标签显示语言与 Eagle 迁入时只有汉字的名称的语言判断（ADR-0003、ADR-0012）。
//! 进程里只有一个当前值：应用壳启动时定下，切换时改写并通知各窗口；领域代码按 [`current`] 读取。
//!
//! 跟随系统时 `zh-*`（含繁体）用简体中文，其他用英文。设置里的「界面语言」随 #358 在 v1.2 上线，
//! 在那之前不指定时界面始终是简体中文。

use std::sync::RwLock;

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

/// 按指定与系统语言定下界面语言。指定 `system` 时跟随系统，指定某种界面语言时用它；
/// 没有指定（或指定的不认识）时为简体中文，与 1.0 一致。
pub fn choose(specified: Option<&str>, system: Option<&str>) -> &'static str {
    match specified.map(str::trim) {
        Some(s) if s.eq_ignore_ascii_case(SYSTEM) => resolve(system.unwrap_or_default()),
        Some(s) => supported(s).unwrap_or(ZH_CN),
        None => ZH_CN,
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
    fn unspecified_stays_simplified_chinese_until_the_setting_ships() {
        assert_eq!(choose(None, Some("en-US")), ZH_CN);
        assert_eq!(choose(Some("system"), Some("en-US")), EN);
        assert_eq!(choose(Some("system"), Some("zh-TW")), ZH_CN);
        assert_eq!(choose(Some("system"), None), EN);
        assert_eq!(choose(Some("en"), Some("zh-CN")), EN);
        assert_eq!(choose(Some("fr"), Some("fr-FR")), ZH_CN);
    }

    #[test]
    fn only_translated_languages_can_be_set() {
        assert_eq!(supported("EN"), Some(EN));
        assert_eq!(supported("ja"), None);
        assert_eq!(set("ja"), None);
        assert_eq!(current(), ZH_CN);
    }
}
