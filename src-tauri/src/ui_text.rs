//! Rust 侧直接给画师看的文字（#355）：托盘菜单与提示、系统对话框。按当前界面语言取，
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
