//! 打标子进程（ADR-0004）：应用 exe 以子命令 [`SUBCOMMAND`] 启动自己，进入 [`run_worker`]。
//!
//! 经标准输入输出与主进程交换 JSON（协议在 `kinshoko_core::tagging::serve`）。推理用 ONNX Runtime：
//! 有独显时走 DirectML，没有时走 CPU。显存溢出或驱动崩溃只结束这个子进程，钉图和主窗口不受影响。
//! 预处理按 PixAI v1.0（内置模型都是它的不同精度）。

mod engine;
mod preprocess;
mod sysinfo;

use std::io::BufReader;
use std::path::Path;

use kinshoko_core::tagging::{Backend, Device, DeviceInfo, Engine, EngineError, GpuInfo};

/// 打标子进程的子命令。
pub const SUBCOMMAND: &str = "tagger";

struct OrtBackend;

impl Backend for OrtBackend {
    fn probe(&mut self) -> DeviceInfo {
        DeviceInfo {
            gpu: sysinfo::discrete_gpu().map(|g| GpuInfo {
                name: g.name,
                vram_budget: g.budget,
            }),
            available_ram: sysinfo::available_ram(),
        }
    }

    fn load(
        &mut self,
        onnx: &Path,
        tags_csv: &Path,
        device: Device,
    ) -> Result<Box<dyn Engine>, EngineError> {
        Ok(Box::new(engine::OrtEngine::load(onnx, tags_csv, device)?))
    }
}

/// 子进程入口；返回进程退出码。
pub fn run_worker() -> i32 {
    let stdin = std::io::stdin();
    kinshoko_core::tagging::serve(
        &mut OrtBackend,
        BufReader::new(stdin.lock()),
        std::io::stdout(),
    )
}
