//! ONNX Runtime 推理（移植自 `tools/tagger-probe` 的 bench.rs）。

use std::path::Path;

use kinshoko_core::tagging::{Device, EngineError, RawTag};
use ort::session::{HasSelectedOutputs, OutputSelector, RunOptions, Session};
use ort::value::Tensor;

use crate::preprocess;
use crate::sysinfo;

/// 低于这个分数的结果不回传；最低的类别阈值是 0.15。
const REPORT_FLOOR: f32 = 0.05;

struct VocabEntry {
    name: String,
    category: u8,
}

pub struct OrtEngine {
    session: Session,
    output: String,
    options: RunOptions<HasSelectedOutputs>,
    vocab: Vec<VocabEntry>,
    device: Device,
}

/// DXGI 的设备被移除、挂起、重置、驱动内部错误，以及内存不足（显存溢出时 DirectML 报告）。
fn is_device_lost(msg: &str) -> bool {
    let m = msg.to_ascii_uppercase();
    ["887A0005", "887A0006", "887A0007", "887A0020", "8007000E"]
        .iter()
        .any(|c| m.contains(c))
}

fn load_vocab(path: &Path) -> Result<Vec<VocabEntry>, String> {
    let mut rdr = csv::Reader::from_path(path).map_err(|e| e.to_string())?;
    let headers = rdr.headers().map_err(|e| e.to_string())?.clone();
    let col = |name: &str| {
        headers
            .iter()
            .position(|h| h == name)
            .ok_or_else(|| format!("词表缺少 {name} 列"))
    };
    let (name_i, cat_i) = (col("name")?, col("category")?);
    rdr.records()
        .map(|r| {
            let r = r.map_err(|e| e.to_string())?;
            Ok(VocabEntry {
                name: r[name_i].to_owned(),
                category: r[cat_i]
                    .parse()
                    .map_err(|_| "词表的 category 不是数字".to_owned())?,
            })
        })
        .collect()
}

fn build(onnx: &Path, device: Device) -> ort::Result<Session> {
    let mut b = Session::builder()?;
    if device == Device::DirectMl {
        let mut ep = ort::ep::DirectML::default();
        if let Some(gpu) = sysinfo::discrete_gpu() {
            ep = ep.with_device_id(gpu.index as i32);
        }
        // DirectML 要求顺序执行、不用内存模式；`error_on_failure` 让静默退回 CPU 变成错误。
        b = b
            .with_parallel_execution(false)?
            .with_memory_pattern(false)?
            .with_execution_providers([ep.build().error_on_failure()])?;
    }
    b.commit_from_file(onnx)
}

impl OrtEngine {
    pub fn load(onnx: &Path, tags_csv: &Path, device: Device) -> Result<OrtEngine, EngineError> {
        let vocab = load_vocab(tags_csv).map_err(EngineError::Fatal)?;
        let session = build(onnx, device).map_err(|e| classify(&e, "加载模型失败"))?;
        // 只取分数输出；PixAI 的 ONNX 还有别的输出。
        let outlets = session.outputs();
        let output = outlets
            .iter()
            .find(|o| o.name() == "prediction")
            .or(outlets.first())
            .map(|o| o.name().to_owned())
            .ok_or_else(|| EngineError::Fatal("模型没有输出".into()))?;
        let options = RunOptions::new()
            .map(|o| o.with_outputs(OutputSelector::no_default().with(output.clone())))
            .map_err(|e| EngineError::Fatal(e.to_string()))?;
        Ok(OrtEngine {
            session,
            output,
            options,
            vocab,
            device,
        })
    }

    fn infer(&mut self, prepared: preprocess::Prepared) -> ort::Result<Vec<f32>> {
        let input = Tensor::from_array((prepared.shape, prepared.data))?;
        let outputs = self
            .session
            .run_with_options(ort::inputs![input], &self.options)?;
        let (_, data) = outputs[self.output.as_str()].try_extract_tensor::<f32>()?;
        Ok(data.to_vec())
    }
}

fn classify(e: &ort::Error, what: &str) -> EngineError {
    let msg = format!("{what}：{e}");
    if is_device_lost(&msg) {
        EngineError::DeviceLost(msg)
    } else {
        EngineError::Fatal(msg)
    }
}

impl kinshoko_core::tagging::Engine for OrtEngine {
    fn tag(&mut self, image: &Path) -> Result<Vec<RawTag>, EngineError> {
        let img =
            image::open(image).map_err(|e| EngineError::BadImage(format!("无法解码：{e}")))?;
        let prepared = preprocess::prepare(&img);
        drop(img);
        let scores = self.infer(prepared).map_err(|e| classify(&e, "推理失败"))?;
        // 超出显存额度时 Windows 把显存换页出去，一张要一分钟；当作显存溢出处理。
        if self.device == Device::DirectMl
            && let Some(gpu) = sysinfo::discrete_gpu()
            && gpu.usage > gpu.budget
        {
            return Err(EngineError::DeviceLost(format!(
                "显存占用 {} 超过系统额度 {}",
                gpu.usage, gpu.budget
            )));
        }
        Ok(self
            .vocab
            .iter()
            .zip(scores)
            .filter(|(_, s)| *s >= REPORT_FLOOR)
            .map(|(v, score)| RawTag {
                name: v.name.clone(),
                category: v.category,
                score,
            })
            .collect())
    }
}
