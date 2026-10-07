//! 打标 port：主进程与打标子进程之间的接缝（ADR-0004）。
//!
//! 生产用 [`super::ProcessTagger`]（同一个 exe 以子命令启动的子进程），测试用
//! [`super::InMemoryTagger`]。丢弃 [`TaggerSession`] 就结束会话、归还显存。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::models::ModelSpec;

/// 推理设备档位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Device {
    /// 独立显卡，经 ONNX Runtime + DirectML。
    DirectMl,
    /// 没有独显时的 CPU 档。
    Cpu,
}

impl Device {
    pub fn as_str(self) -> &'static str {
        match self {
            Device::DirectMl => "directml",
            Device::Cpu => "cpu",
        }
    }

    pub fn parse(s: &str) -> Option<Device> {
        match s {
            "directml" => Some(Device::DirectMl),
            "cpu" => Some(Device::Cpu),
            _ => None,
        }
    }
}

/// 本机的推理条件。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    /// 第一块独立显卡（DirectML 的 0 号设备）；没有独显时为空。
    pub gpu: Option<GpuInfo>,
    /// 当前可用的物理内存。
    pub available_ram: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    /// 系统当前允许本进程使用的显存额度。
    pub vram_budget: u64,
}

/// 模型对一张图的原始结果之一：外部名称（模型词表中的名称）、类别与分数。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawTag {
    pub name: String,
    pub category: u8,
    pub score: f32,
}

/// 已下载、校验（并改写）好的模型。
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedModel {
    pub spec: ModelSpec,
    /// 推理用的 ONNX 文件（有分块改写时是改写后的文件）。
    pub onnx: PathBuf,
    /// 模型词表（`selected_tags.csv`）。
    pub tags_csv: PathBuf,
}

/// 打标失败的种类。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TagFailure {
    /// 这张图本身无法打标（例如解码失败）；会话照常可用。
    BadImage(String),
    /// 打标子进程崩溃、超时或无响应；会话已不可用。
    Crashed(String),
    /// 显卡被系统重置或显存溢出；会话已不可用。
    DeviceLost(String),
}

impl std::fmt::Display for TagFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TagFailure::BadImage(r) => write!(f, "无法打标这张图：{r}"),
            TagFailure::Crashed(r) => write!(f, "打标子进程异常退出：{r}"),
            TagFailure::DeviceLost(r) => write!(f, "显卡被重置或显存不足：{r}"),
        }
    }
}

/// 打标 port。
pub trait Tagger: Send + Sync {
    /// 查询本机的推理条件，用来选模型档位。
    fn probe(&self) -> DeviceInfo;
    /// 开始一个会话：加载模型到 `device` 上。
    ///
    /// 开始加载之前（子进程一启动）就把这个会话的结束开关交给 `on_stopper`：加载模型可能要几分钟，
    /// 期间画师暂停或关闭资料库时要能立即结束它。加载中被结束时返回 [`TagFailure::Crashed`]。
    fn start(
        &self,
        model: &PreparedModel,
        device: Device,
        on_stopper: &dyn Fn(SessionStopper),
    ) -> Result<Box<dyn TaggerSession>, TagFailure>;
}

/// 一个加载了模型的打标会话。丢弃即结束（子进程被结束，显存归还）。
pub trait TaggerSession: Send {
    /// 对一张图打标，返回模型的原始结果（按外部名称）。
    fn tag(&mut self, image: &Path) -> Result<Vec<RawTag>, TagFailure>;
}

/// 从别的线程立即结束会话的开关（见 [`Tagger::start`]）：正在加载的模型或正在打的图随即以
/// [`TagFailure::Crashed`] 返回，不等它完成（画师暂停打标时立刻归还显存）。可以多次调用。
pub type SessionStopper = Arc<dyn Fn() + Send + Sync>;
