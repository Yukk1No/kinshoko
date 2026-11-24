//! 来源名称（#217，ADR-0012）。
//!
//! - 导入来源为本库标签带来的叫法，例如 Eagle 原有标签“蓝眼睛”。属于本库的来源层：重新迁入时
//!   跟随来源，从不回写来源；单库内优先于默认名称显示，名称偏好又优先于它。
//! - 来源本身不注明语言，按文字判断（[`detect_lang`]）；判断不了的为未注明语言（[`UND`]），
//!   显示时排在其他语言之后。画师可以改某个来源名称的语言。
//! - 原文与外部名称写法相同时（如 `blue eyes` 对 `blue_eyes`）它只是不分语言的标签别名，
//!   不作为来源名称保存。

use rusqlite::{Connection, Transaction, params};

use super::Error;
use super::tags::LocalizedName;

/// 未注明语言（BCP 47 的 `und`）。
pub const UND: &str = "und";

/// Eagle 迁入带来的来源名称。
pub(super) const EAGLE: &str = "eagle";

fn is_kana(c: char) -> bool {
    // 片假名中点“・”也出现在中文人名里，不当作假名。
    matches!(c, '\u{3040}'..='\u{309F}' | '\u{30A0}'..='\u{30FF}' | '\u{31F0}'..='\u{31FF}' | '\u{FF66}'..='\u{FF9F}')
        && c != '\u{30FB}'
}

fn is_hangul(c: char) -> bool {
    matches!(c, '\u{AC00}'..='\u{D7AF}' | '\u{1100}'..='\u{11FF}' | '\u{3130}'..='\u{318F}' | '\u{A960}'..='\u{A97F}' | '\u{D7B0}'..='\u{D7FF}')
}

fn is_han(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}' | '\u{F900}'..='\u{FAFF}' | '\u{20000}'..='\u{3134F}' | '\u{3005}' | '\u{3007}')
}

fn is_latin(c: char) -> bool {
    c.is_ascii_alphabetic()
        || matches!(c, '\u{00C0}'..='\u{024F}' | '\u{1E00}'..='\u{1EFF}' | '\u{FF21}'..='\u{FF3A}' | '\u{FF41}'..='\u{FF5A}')
}

/// 按文字判断来源名称的语言：含假名为 `ja`；含谚文为 `ko`；只有汉字时，界面语言是中文或日文
/// 就取界面语言，否则为 `zh-CN`；只有拉丁字母、数字与符号为 `en`；混排或其他为 [`UND`]。
/// 数字、空白与标点不影响判断。
pub fn detect_lang(text: &str, ui_lang: &str) -> String {
    if text.chars().any(is_kana) {
        return "ja".into();
    }
    if text.chars().any(is_hangul) {
        return "ko".into();
    }
    let letters: Vec<char> = text.chars().filter(|c| c.is_alphabetic()).collect();
    if !letters.is_empty() && letters.iter().all(|&c| is_han(c)) {
        let primary = ui_lang.split(['-', '_']).next().unwrap_or(ui_lang);
        return if primary.eq_ignore_ascii_case("zh") || primary.eq_ignore_ascii_case("ja") {
            ui_lang.to_owned()
        } else {
            "zh-CN".into()
        };
    }
    if letters.iter().all(|&c| is_latin(c)) && !text.trim().is_empty() {
        return "en".into();
    }
    UND.into()
}

/// 记下一个来源名称；已有同一叫法时不动（保留画师改过的语言）。
pub(super) fn insert(
    tx: &Transaction,
    tag_id: &str,
    name: &str,
    lang: &str,
    source: &str,
) -> Result<(), Error> {
    tx.execute(
        "INSERT OR IGNORE INTO tag_source_name (tag_id, name, lang, source) VALUES (?1, ?2, ?3, ?4)",
        params![tag_id, name, lang, source],
    )?;
    Ok(())
}

/// 一个标签的来源名称，按记下的先后。
pub(super) fn load(conn: &Connection, tag_id: &str) -> Result<Vec<LocalizedName>, Error> {
    let mut stmt = conn.prepare_cached(
        "SELECT lang, name FROM tag_source_name WHERE tag_id = ?1 ORDER BY rowid",
    )?;
    let rows = stmt.query_map([tag_id], |r| {
        Ok(LocalizedName {
            lang: r.get(0)?,
            name: r.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// 单库内显示用的各语言名称：名称偏好 > 来源名称 > 默认名称。每种语言只留一个，
/// 同一语言有多个来源名称时取先记下的；未注明语言的来源名称排在最后。
pub fn compose(
    defaults: &[LocalizedName],
    sources: &[LocalizedName],
    preferences: &[LocalizedName],
) -> Vec<LocalizedName> {
    let mut names: Vec<LocalizedName> = defaults.to_vec();
    let mut overlaid = std::collections::HashSet::new();
    for source in sources.iter().filter(|s| s.lang != UND) {
        if overlaid.insert(source.lang.clone()) {
            names.retain(|n| n.lang != source.lang);
            names.push(source.clone());
        }
    }
    for preference in preferences {
        names.retain(|n| n.lang != preference.lang);
        names.push(preference.clone());
    }
    names.sort_by(|a, b| a.lang.cmp(&b.lang));
    names.retain(|n| n.lang != UND);
    names.extend(sources.iter().filter(|s| s.lang == UND).take(1).cloned());
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_are_judged_by_script() {
        assert_eq!(detect_lang("初音ミク", "zh-CN"), "ja");
        assert_eq!(detect_lang("파란 눈", "zh-CN"), "ko");
        assert_eq!(detect_lang("蓝眼睛", "zh-CN"), "zh-CN");
        assert_eq!(detect_lang("制服", "ja"), "ja");
        assert_eq!(detect_lang("制服", "zh-TW"), "zh-TW");
        assert_eq!(detect_lang("制服", "en"), "zh-CN");
        assert_eq!(detect_lang("cyberpunk", "zh-CN"), "en");
        assert_eq!(detect_lang("Pokémon 2", "zh-CN"), "en");
        assert_eq!(detect_lang("1girl", "zh-CN"), "en");
        assert_eq!(detect_lang("初音・未来", "zh-CN"), "zh-CN");
        assert_eq!(detect_lang("蓝发 girl", "zh-CN"), UND);
        assert_eq!(detect_lang("кошка", "zh-CN"), UND);
    }

    fn n(lang: &str, name: &str) -> LocalizedName {
        LocalizedName {
            lang: lang.into(),
            name: name.into(),
        }
    }

    #[test]
    fn preference_beats_source_name_which_beats_default() {
        let names = compose(
            &[n("zh-CN", "蓝瞳"), n("en", "Blue eyes")],
            &[n("zh-CN", "蓝眼睛"), n("zh-CN", "蓝色眼睛"), n(UND, "x")],
            &[n("en", "Blue")],
        );
        assert_eq!(names, [n("en", "Blue"), n("zh-CN", "蓝眼睛"), n(UND, "x")]);
    }
}
