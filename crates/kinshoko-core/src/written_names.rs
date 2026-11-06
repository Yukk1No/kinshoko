//! 写进画师数据的默认名（#359）：恢复出的资料库、剪贴板图片的文件名、另存的参考组名、迁移后留下的说明。
//! 调用方传写入时的界面语言（[`interface_lang::current`]）；写进去以后不随界面语言再变。

use std::path::Path;

use crate::interface_lang;

fn english(lang: &str) -> bool {
    lang == interface_lang::EN
}

/// 从备份恢复出的资料库的文件夹名；`n` 是同名时附加的序号。
pub(crate) fn restored_library_dir(lang: &str, name: &str, date: &str, n: Option<usize>) -> String {
    let base = if english(lang) {
        format!("{name} (restored {date})")
    } else {
        format!("{name}（恢复 {date}）")
    };
    match n {
        Some(n) => format!("{base} {n}"),
        None => base,
    }
}

/// 从备份恢复出的资料库的名称。
pub(crate) fn restored_library_name(lang: &str, name: &str) -> String {
    if english(lang) {
        format!("{name} (restored)")
    } else {
        format!("{name}（恢复）")
    }
}

/// 暂存的剪贴板图片的文件名；`attempt` 是同一时刻重名时附加的序号。
pub(crate) fn clipboard_image(lang: &str, stamp: u128, attempt: u32) -> String {
    let base = if english(lang) {
        format!("clipboard-image-{stamp}")
    } else {
        format!("剪贴板图片-{stamp}")
    };
    if attempt == 0 {
        format!("{base}.png")
    } else {
        format!("{base}-{attempt}.png")
    }
}

/// 数据迁到新位置后，旧文件夹里留下的说明；`left` 是没有迁移的条目。
pub(crate) fn migration_note(lang: &str, target: &Path, left: &[&str]) -> String {
    let en = english(lang);
    let mut note = if en {
        format!(
            "Kinshoko's settings, tagging models and other data have moved to:\r\n{}\r\n",
            target.display()
        )
    } else {
        format!(
            "Kinshoko 的设置、打标模型等数据已移到：\r\n{}\r\n",
            target.display()
        )
    };
    if left.is_empty() {
        note.push_str(if en {
            "This folder can be deleted.\r\n"
        } else {
            "这个文件夹可以删除。\r\n"
        });
    } else {
        note.push_str(if en {
            "These items weren't moved (another item has the same name, or the name couldn't be recorded). Check them before deleting:\r\n"
        } else {
            "下面这些没有迁移（与别处同名或名字无法记录），请先确认再删除：\r\n"
        });
        for name in left {
            note.push_str(&format!("  {name}\r\n"));
        }
    }
    note
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interface_lang::{EN, ZH_CN};

    #[test]
    fn names_follow_the_interface_language_at_write_time() {
        assert_eq!(
            restored_library_dir(ZH_CN, "主库", "2026-11-01", None),
            "主库（恢复 2026-11-01）"
        );
        assert_eq!(
            restored_library_dir(EN, "Main", "2026-11-01", Some(2)),
            "Main (restored 2026-11-01) 2"
        );
        assert_eq!(restored_library_name(EN, "Main"), "Main (restored)");
        assert_eq!(clipboard_image(ZH_CN, 7, 0), "剪贴板图片-7.png");
        assert_eq!(clipboard_image(EN, 7, 1), "clipboard-image-7-1.png");
        let note = migration_note(EN, Path::new("D:/data"), &["x"]);
        assert!(note.starts_with("Kinshoko's settings"));
        assert!(note.ends_with("  x\r\n"));
        assert!(
            migration_note(ZH_CN, Path::new("D:/data"), &[]).ends_with("这个文件夹可以删除。\r\n")
        );
    }
}
