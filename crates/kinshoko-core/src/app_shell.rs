//! 应用壳：本设备上与具体资料库无关的信息。

use serde::{Deserialize, Serialize};
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
        #[ts(as = "crate::command_error::ErrorKind")]
        message: crate::CommandError,
    },
    /// 此构建由画师运行安装包更新。
    Manual {
        #[ts(as = "crate::command_error::ErrorKind")]
        message: crate::CommandError,
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
    /// 检查或安装失败的原因。
    Failed {
        #[ts(as = "crate::command_error::ErrorKind")]
        message: crate::CommandError,
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

/// 自动更新的通道（#204）。两个入口都在原仓库：正式版通道读 GitHub 的 latest（不含预发布），
/// 测试版通道读固定的预发布 Release `channel-beta`，由发布工作流在每次发布后更新为最新版本。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum UpdateChannel {
    /// 只收正式版。
    Stable,
    /// 收测试版、候选版与正式版中最新的。
    Beta,
}

impl UpdateChannel {
    const STABLE_ENDPOINT: &str =
        "https://github.com/Yukk1No/kinshoko/releases/latest/download/latest.json";
    const BETA_ENDPOINT: &str =
        "https://github.com/Yukk1No/kinshoko/releases/download/channel-beta/latest.json";

    /// 画师没选过通道时：测试版、候选版构建（版本号带“-”）默认测试版通道，其余默认正式版通道。
    pub fn default_for_version(version: &str) -> Self {
        if version.contains('-') {
            UpdateChannel::Beta
        } else {
            UpdateChannel::Stable
        }
    }

    /// 这个通道的 `latest.json` 入口。
    pub fn endpoint(self) -> &'static str {
        match self {
            UpdateChannel::Stable => Self::STABLE_ENDPOINT,
            UpdateChannel::Beta => Self::BETA_ENDPOINT,
        }
    }
}

/// 只提示比已装版本新的版本（按 SemVer，预发布低于同号正式版）。
/// 从测试版通道切回正式版通道时，比已装版本旧的正式版因此不会被当作更新。
pub fn offers_update(current: &semver::Version, remote: &semver::Version) -> bool {
    remote > current
}

/// 构建阶段决定自动检查与安装是否可用；命令层共享这一个边界。
/// `public` 是发布者对原仓库已公开且更新入口可匿名读取的明确声明。
/// 缺少阶段配置的旧配置仍按私有阶段处理。配置里的入口只能是两个通道的原仓库入口；
/// 实际检查哪一个由画师的更新通道决定。
pub struct UpdatePolicy(UpdateStatus);

impl UpdatePolicy {
    pub fn for_build(stage: Option<&str>, pubkey: Option<&str>, endpoints: &[String]) -> Self {
        let original = |url: &String| {
            [UpdateChannel::Stable, UpdateChannel::Beta]
                .iter()
                .any(|channel| channel.endpoint() == url)
        };
        use crate::CommandError;
        use crate::command_error::ErrorKind;
        let disabled = |kind, text: &str| UpdateStatus::Disabled {
            message: CommandError::new(kind, text),
        };
        let status = match stage.unwrap_or("private") {
            "private" => UpdateStatus::Manual {
                message: CommandError::new(ErrorKind::UpdateManual, "当前使用安装包手动更新。"),
            },
            "public" if pubkey.is_none_or(|key| key.trim().is_empty()) => disabled(
                ErrorKind::UpdateNoPublicKey,
                "未配置更新公钥，自动更新未启用。请使用新版安装包手动更新。",
            ),
            "public" if endpoints.is_empty() || !endpoints.iter().all(original) => disabled(
                ErrorKind::UpdateNoEndpoint,
                "未配置原仓库的公开更新入口，自动更新未启用。请使用新版安装包手动更新。",
            ),
            "public" => UpdateStatus::Unchecked,
            _ => disabled(
                ErrorKind::UpdateUnknownStage,
                "更新阶段配置无法识别，自动更新未启用。请使用新版安装包手动更新。",
            ),
        };
        Self(status)
    }

    pub fn initial_status(&self) -> UpdateStatus {
        self.0.clone()
    }

    /// 检查和安装在各自执行前都必须再次通过此边界。
    pub fn require_automatic(&self) -> Result<(), crate::CommandError> {
        match &self.0 {
            UpdateStatus::Unchecked => Ok(()),
            UpdateStatus::Manual { message } | UpdateStatus::Disabled { message } => {
                Err(message.clone())
            }
            _ => unreachable!("构建策略只产生初始更新状态"),
        }
    }
}
