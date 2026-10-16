//! 应用壳：本设备上与具体资料库无关的信息。

use serde::Serialize;
use ts_rs::TS;

/// 应用本身的名称与版本，供标题栏和“关于”显示。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppInfo {
    pub product_name: String,
    pub version: String,
}

pub fn app_info() -> AppInfo {
    AppInfo {
        product_name: "Kinshoko".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    }
}

/// 检查更新的结果（#70）。更新来自 GitHub Releases，安装包的签名由 Tauri updater 校验。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum UpdateStatus {
    /// 这个构建没有配置更新公钥（开发构建或未签名的发布），不检查更新。
    Disabled,
    /// 还没有检查过。
    Unchecked,
    UpToDate,
    /// 有新版本可以安装。
    Available {
        version: String,
        /// 发布说明。
        notes: Option<String>,
    },
    /// 检查或安装失败；`message` 是给画师看的中文。
    Failed {
        message: String,
    },
}

/// 下载更新的进度，经 `update-progress` 事件推送。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateProgress {
    #[ts(type = "number")]
    pub downloaded: u64,
    #[ts(type = "number | null")]
    pub total: Option<u64>,
}
