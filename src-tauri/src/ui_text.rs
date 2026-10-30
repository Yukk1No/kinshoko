//! Rust 侧直接给画师看的文字（#355）：托盘菜单与提示、系统对话框（含启动失败的说明）。按当前界面语言取，
//! 界面里的文字在前端的 i18n 资源里。

use kinshoko_core::interface_lang;

/// 一段界面文字。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Text {
    TrayOpen,
    TrayCapture,
    TrayPinClipboard,
    TrayEdgeHide,
    TrayQuit,
    /// 托盘提示：正在备份。
    TrayBackingUp,
    /// 托盘提示：备份没有完成，后面接原因。
    TrayBackupFailed,
    /// 启动失败时系统对话框的标题。
    StartupFailed,
    FilterReferencePackage,
    FilterModelPackage,
    FilterImages,
    FilterSettingsBackup,
    FilterZip,
    /// 诊断信息文件名的前缀。
    DiagnosticsFileName,
}

/// 当前界面语言下的文字。
pub fn text(key: Text) -> &'static str {
    in_lang(interface_lang::current(), key)
}

fn in_lang(lang: &str, key: Text) -> &'static str {
    let en = lang == interface_lang::EN;
    match key {
        Text::TrayOpen => pick(en, "打开 Kinshoko", "Open Kinshoko"),
        Text::TrayCapture => pick(en, "截图", "Capture"),
        Text::TrayPinClipboard => pick(en, "钉剪贴板", "Pin clipboard"),
        Text::TrayEdgeHide => pick(en, "贴边隐藏／显示钉图", "Hide or show pins at the edge"),
        Text::TrayQuit => pick(en, "退出", "Quit"),
        Text::TrayBackingUp => pick(en, "Kinshoko：正在备份…", "Kinshoko: backing up…"),
        Text::TrayBackupFailed => pick(
            en,
            "Kinshoko：备份没有完成，下次再试。",
            "Kinshoko: the backup didn't finish. It will try again next time. ",
        ),
        Text::StartupFailed => pick(en, "Kinshoko 无法启动", "Kinshoko couldn't start"),
        Text::FilterReferencePackage => pick(en, "参考组包", "Reference group package"),
        Text::FilterModelPackage => pick(en, "模型包", "Model package"),
        Text::FilterImages => pick(en, "图片", "Images"),
        Text::FilterSettingsBackup => pick(en, "程序设置备份", "Settings backup"),
        Text::FilterZip => pick(en, "zip 压缩包", "ZIP archive"),
        Text::DiagnosticsFileName => pick(en, "kinshoko-诊断信息", "kinshoko-diagnostics"),
    }
}

fn english() -> bool {
    interface_lang::current() == interface_lang::EN
}

/// 启动失败：找不到程序所在的位置。
pub fn exe_not_found(error: &dyn std::fmt::Display) -> String {
    if english() {
        format!("Couldn't find where Kinshoko is installed: {error}")
    } else {
        format!("找不到 Kinshoko 程序所在的位置：{error}")
    }
}

/// 启动失败：迁移旧数据没能完成。
pub fn migration_failed(error: &dyn std::fmt::Display) -> String {
    if english() {
        format!(
            "Kinshoko couldn't finish moving its data:\n{error}\n\nRestart Kinshoko and try again."
        )
    } else {
        format!("Kinshoko 迁移数据时出错，没能完成：\n{error}\n\n请重新启动 Kinshoko 再试。")
    }
}

/// 启动失败：数据文件夹不可写。
pub fn data_unwritable(root: &std::path::Path, error: &dyn std::fmt::Display) -> String {
    if english() {
        format!(
            "Kinshoko can't write to its data folder:\n{}\n\nReason: {error}\n\n\
             Kinshoko keeps settings, tagging models and other data in the data folder next to the program. \
             Install Kinshoko somewhere the current user can write to (such as the default %LOCALAPPDATA%\\Kinshoko), \
             or give this folder write permission, then start it again.",
            root.display()
        )
    } else {
        format!(
            "Kinshoko 无法写入数据文件夹：\n{}\n\n原因：{error}\n\n\
             Kinshoko 把设置、打标模型等数据保存在程序所在目录下的 data 文件夹。\
             请把 Kinshoko 安装到当前用户可以写入的位置（例如默认的 %LOCALAPPDATA%\\Kinshoko），\
             或者给这个文件夹写入权限后重新启动。",
            root.display()
        )
    }
}

fn pick(en: bool, zh: &'static str, english: &'static str) -> &'static str {
    if en { english } else { zh }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_is_the_text_of_1_0_and_english_follows_the_interface_language() {
        assert_eq!(
            in_lang(interface_lang::ZH_CN, Text::TrayOpen),
            "打开 Kinshoko"
        );
        assert_eq!(in_lang(interface_lang::ZH_CN, Text::TrayQuit), "退出");
        assert_eq!(in_lang(interface_lang::EN, Text::TrayQuit), "Quit");
        assert_eq!(
            in_lang(interface_lang::EN, Text::FilterReferencePackage),
            "Reference group package"
        );
    }
}
