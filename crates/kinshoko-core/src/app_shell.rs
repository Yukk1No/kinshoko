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
    /// 公开构建缺少自动更新条件；说明具体原因。
    Disabled {
        message: String,
    },
    /// 私有阶段由画师运行安装包更新。
    Manual {
        message: String,
    },
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

/// 构建阶段决定自动检查与安装是否可用；命令层共享这一个边界。
/// `public` 是发布者对原仓库已公开且更新入口可匿名读取的明确声明。
/// 缺少阶段配置的旧配置仍按私有阶段处理。
pub struct UpdatePolicy(UpdateStatus);

impl UpdatePolicy {
    pub fn for_build(stage: Option<&str>, pubkey: Option<&str>, endpoints: &[String]) -> Self {
        const ENDPOINT: &str =
            "https://github.com/Yukk1No/kinshoko/releases/latest/download/latest.json";
        let status = match stage.unwrap_or("private") {
            "private" => UpdateStatus::Manual {
                message: "当前为私有阶段，请使用新版安装包手动更新。".to_owned(),
            },
            "public" if pubkey.is_none_or(|key| key.trim().is_empty()) => {
                UpdateStatus::Disabled {
                    message: "未配置更新公钥，自动更新未启用。请使用新版安装包手动更新。"
                        .to_owned(),
                }
            }
            "public" if endpoints.len() != 1 || endpoints[0] != ENDPOINT => {
                UpdateStatus::Disabled {
                    message:
                        "未配置原仓库的公开更新入口，自动更新未启用。请使用新版安装包手动更新。"
                            .to_owned(),
                }
            }
            "public" => UpdateStatus::Unchecked,
            _ => UpdateStatus::Disabled {
                message: "更新阶段配置无法识别，自动更新未启用。请使用新版安装包手动更新。"
                    .to_owned(),
            },
        };
        Self(status)
    }

    pub fn initial_status(&self) -> UpdateStatus {
        self.0.clone()
    }

    /// 检查和安装在各自执行前都必须再次通过此边界。
    pub fn require_automatic(&self) -> Result<(), String> {
        match &self.0 {
            UpdateStatus::Unchecked => Ok(()),
            UpdateStatus::Manual { message } | UpdateStatus::Disabled { message } => {
                Err(message.clone())
            }
            _ => unreachable!("构建策略只产生初始更新状态"),
        }
    }
}
