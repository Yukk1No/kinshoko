//! Run one model on one execution provider over the samples and measure it.

use crate::models::LocalModel;
use crate::preprocess;
use crate::samples::Sample;
use crate::sysinfo::PeakSampler;
use crate::util::percentile;
use ort::session::{HasSelectedOutputs, OutputSelector, RunOptions, Session};
use ort::value::Tensor;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Ep {
    #[serde(rename = "cpu")]
    Cpu,
    #[serde(rename = "directml")]
    DirectMl,
}

impl Ep {
    pub fn label(self) -> &'static str {
        match self {
            Ep::Cpu => "CPU",
            Ep::DirectMl => "DirectML (GPU)",
        }
    }
}

#[derive(Serialize, Default)]
pub struct Timing {
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub mean_ms: f64,
}

fn timing(mut v: Vec<f64>) -> Timing {
    if v.is_empty() {
        return Timing::default();
    }
    v.sort_by(|a, b| a.total_cmp(b));
    Timing { p50_ms: percentile(&v, 50.0), p95_ms: percentile(&v, 95.0), mean_ms: v.iter().sum::<f64>() / v.len() as f64 }
}

#[derive(Serialize, Default)]
pub struct RunReport {
    pub model: String,
    pub ep: Option<Ep>,
    pub ok: bool,
    pub error: Option<String>,
    pub input_names: Vec<String>,
    pub output_names: Vec<String>,
    pub load_ms: f64,
    pub first_image_ms: f64,
    pub images: usize,
    pub failed_images: usize,
    pub decode: Timing,
    pub preprocess: Timing,
    pub inference: Timing,
    pub total_seconds: f64,
    pub peak_working_set_bytes: u64,
    pub peak_vram_bytes: u64,
    /// Graph nodes by execution provider, from an ORT profiling pass.
    pub nodes_by_provider: BTreeMap<String, usize>,
    /// Operator types of nodes that did not run on DirectML, with counts.
    pub non_dml_ops: BTreeMap<String, usize>,
    /// Compute-heavy operators among `non_dml_ops`: a sign of real CPU fallback.
    pub heavy_non_dml_ops: BTreeMap<String, usize>,
}

pub struct Run {
    pub report: RunReport,
    /// Per-sample scores, aligned with the sample list (None if that sample failed).
    pub scores: Vec<Option<Vec<f32>>>,
}

fn build(model: &LocalModel, ep: Ep, profile: Option<&Path>) -> ort::Result<Session> {
    let mut b = Session::builder()?;
    if ep == Ep::DirectMl {
        // DirectML requires sequential execution without memory patterns.
        b = b
            .with_parallel_execution(false)?
            .with_memory_pattern(false)?
            .with_execution_providers([ort::ep::DirectML::default().build().error_on_failure()])?;
    }
    if let Some(p) = profile {
        b = b.with_profiling(p)?;
    }
    b.commit_from_file(&model.onnx)
}

/// Request only the score output; PixAI's ONNX also exposes other outputs we do not use.
struct Output {
    name: String,
    options: RunOptions<HasSelectedOutputs>,
}

fn select_output(session: &Session) -> ort::Result<Output> {
    let outlets = session.outputs();
    let name = outlets
        .iter()
        .find(|o| o.name() == "prediction")
        .unwrap_or(&outlets[0])
        .name()
        .to_string();
    let options = RunOptions::new()?.with_outputs(OutputSelector::no_default().with(name.clone()));
    Ok(Output { name, options })
}

fn infer(session: &mut Session, out: &Output, prepared: preprocess::Prepared) -> ort::Result<Vec<f32>> {
    let input = Tensor::from_array((prepared.shape, prepared.data))?;
    let outputs = session.run_with_options(ort::inputs![input], &out.options)?;
    let (_, data) = outputs[out.name.as_str()].try_extract_tensor::<f32>()?;
    Ok(data.to_vec())
}

/// Operators whose placement on CPU would mean the model's main compute fell back.
const HEAVY_OPS: [&str; 14] = [
    "Conv", "ConvTranspose", "MatMul", "MatMulInteger", "Gemm", "Attention", "MultiHeadAttention",
    "Einsum", "Softmax", "LayerNormalization", "SkipLayerNormalization", "BatchNormalization", "Gelu", "FusedMatMul",
];

#[derive(Default)]
struct Placement {
    by_provider: BTreeMap<String, usize>,
    non_dml_ops: BTreeMap<String, usize>,
}

/// Count nodes per provider using a short profiled session (DirectML only).
fn node_providers(model: &LocalModel, ep: Ep, samples: &[Sample], workdir: &Path) -> Placement {
    let mut counts = Placement::default();
    let prefix = workdir.join(format!("profile-{}-{:?}", model.spec.key, ep));
    let Ok(mut session) = build(model, ep, Some(&prefix)) else { return counts };
    let Ok(out) = select_output(&session) else { return counts };
    for s in samples.iter().take(2) {
        if let Ok(img) = preprocess::load(&s.path) {
            let _ = infer(&mut session, &out, preprocess::prepare(&img, model.spec.preprocess));
        }
    }
    let Ok(file) = session.end_profiling() else { return counts };
    let Ok(text) = std::fs::read_to_string(&file) else { return counts };
    let _ = std::fs::remove_file(&file);
    let Ok(events) = serde_json::from_str::<Vec<serde_json::Value>>(&text) else { return counts };
    let mut seen = std::collections::HashSet::new();
    for e in events {
        if e["cat"] != "Node" {
            continue;
        }
        let (Some(name), Some(provider)) = (e["name"].as_str(), e["args"]["provider"].as_str()) else { continue };
        let node = name.trim_end_matches("_kernel_time").trim_end_matches("_fence_before").trim_end_matches("_fence_after");
        if seen.insert(node.to_string()) {
            *counts.by_provider.entry(provider.to_string()).or_insert(0) += 1;
            if provider != "DmlExecutionProvider" {
                let op = e["args"]["op_name"].as_str().unwrap_or("?");
                *counts.non_dml_ops.entry(op.to_string()).or_insert(0) += 1;
            }
        }
    }
    counts
}

pub fn run(model: &LocalModel, ep: Ep, samples: &[Sample], workdir: &Path) -> Run {
    let mut report = RunReport { model: model.spec.key.to_string(), ep: Some(ep), ..Default::default() };
    let mut scores = Vec::with_capacity(samples.len());
    let sampler = PeakSampler::start();
    let start = Instant::now();

    let t = Instant::now();
    let mut session = match build(model, ep, None) {
        Ok(s) => s,
        Err(e) => {
            report.error = Some(format!("创建会话失败: {e}"));
            let (ram, vram) = sampler.finish();
            report.peak_working_set_bytes = ram;
            report.peak_vram_bytes = vram;
            return Run { report, scores: samples.iter().map(|_| None).collect() };
        }
    };
    report.load_ms = t.elapsed().as_secs_f64() * 1000.0;
    report.input_names = session.inputs().iter().map(|i| i.name().to_string()).collect();
    report.output_names = session.outputs().iter().map(|o| o.name().to_string()).collect();
    let out = match select_output(&session) {
        Ok(o) => o,
        Err(e) => {
            report.error = Some(format!("选择输出失败: {e}"));
            let (ram, vram) = sampler.finish();
            report.peak_working_set_bytes = ram;
            report.peak_vram_bytes = vram;
            return Run { report, scores: samples.iter().map(|_| None).collect() };
        }
    };

    let (mut dec, mut pre, mut inf) = (Vec::new(), Vec::new(), Vec::new());
    for (i, s) in samples.iter().enumerate() {
        let t0 = Instant::now();
        let img = match preprocess::load(&s.path) {
            Ok(img) => img,
            Err(_) => {
                report.failed_images += 1;
                scores.push(None);
                continue;
            }
        };
        let t1 = Instant::now();
        let prepared = preprocess::prepare(&img, model.spec.preprocess);
        drop(img);
        let t2 = Instant::now();
        match infer(&mut session, &out, prepared) {
            Ok(v) => {
                let t3 = Instant::now();
                let infer_ms = (t3 - t2).as_secs_f64() * 1000.0;
                if i == 0 {
                    // First run includes warm-up; keep it out of the steady-state numbers.
                    report.first_image_ms = infer_ms;
                } else {
                    dec.push((t1 - t0).as_secs_f64() * 1000.0);
                    pre.push((t2 - t1).as_secs_f64() * 1000.0);
                    inf.push(infer_ms);
                }
                scores.push(Some(v));
            }
            Err(e) => {
                report.failed_images += 1;
                scores.push(None);
                if report.error.is_none() {
                    report.error = Some(format!("推理失败: {e}"));
                }
            }
        }
        if (i + 1) % 20 == 0 || i + 1 == samples.len() {
            let done = i + 1;
            let eta = start.elapsed().as_secs_f64() / done as f64 * (samples.len() - done) as f64;
            println!("    {done}/{}  剩余约 {:.0} 秒", samples.len(), eta);
        }
    }
    drop(session);
    report.total_seconds = start.elapsed().as_secs_f64();
    let (ram, vram) = sampler.finish();
    report.peak_working_set_bytes = ram;
    report.peak_vram_bytes = vram;
    report.images = samples.len() - report.failed_images;
    report.decode = timing(dec);
    report.preprocess = timing(pre);
    report.inference = timing(inf);
    report.ok = report.images > 0 && report.error.is_none();
    if ep == Ep::DirectMl && report.images > 0 {
        let p = node_providers(model, ep, samples, workdir);
        report.heavy_non_dml_ops =
            p.non_dml_ops.iter().filter(|(op, _)| HEAVY_OPS.contains(&op.as_str())).map(|(k, v)| (k.clone(), *v)).collect();
        report.nodes_by_provider = p.by_provider;
        report.non_dml_ops = p.non_dml_ops;
    }
    Run { report, scores }
}
