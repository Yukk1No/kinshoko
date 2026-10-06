//! 自动标签（Tagging）：调度打标子进程，写入自动标签建议与内容分级建议（#52，ADR-0004）。
//!
//! - [`Tagging`]：后台调度。按本机条件选模型档位（有独显用 DirectML，没有时退到 CPU 档），
//!   首次使用时经画师确认下载模型（固定版本、校验哈希、断点续传、显示大小与进度），在本机改写为
//!   分块注意力；之后逐张打标，按“模型来源”写入建议，不碰人工标签决定。暂停时结束会话归还显存，
//!   会话崩溃后重启，同一张图反复崩溃就记为无法打标。
//! - 打标 port（[`Tagger`]）有两个 adapter：[`ProcessTagger`]（同一个 exe 以子命令启动的子进程）
//!   与测试用的 [`InMemoryTagger`]。子进程一侧的循环是 [`serve`]，推理由应用壳实现 [`Backend`]
//!   与 [`Engine`]。
//! - [`ModelStore`]：本设备的模型仓库；[`catalog`]：内置的固定版本模型。

mod interpret;
mod memory;
mod models;
mod patch;
mod port;
mod process;
mod scheduler;

pub use memory::InMemoryTagger;
pub use models::{Chunking, HUGGING_FACE, ModelSpec, ModelStore, PrepareStage, catalog};
pub use port::{
    Device, DeviceInfo, GpuInfo, PreparedModel, RawTag, SessionStopper, TagFailure, Tagger,
    TaggerSession,
};
pub use process::{Backend, Engine, EngineError, ProcessTagger, serve};
pub use scheduler::{Tagging, TaggingConfig, TaggingStatus};
