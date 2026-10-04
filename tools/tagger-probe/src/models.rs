//! Pinned model files and their download.

use crate::util::{human_bytes, sha256_file};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preprocess {
    /// PixAI (DeepGHS ONNX): direct resize to 448², RGB, CHW, (x - 0.5) / 0.5.
    PixAi,
    /// WD v3: pad to white square, resize to 448², BGR, NHWC, 0–255.
    Wd,
    /// PixAI v1.0: keep aspect, resize longest side to 1008, pad black, RGB, CHW, (x - 0.5) / 0.5.
    PixAiV1,
}

/// How many samples a model runs on a provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Limit {
    Skip,
    All,
    First(usize),
}

impl Limit {
    pub fn take(self, n: usize) -> usize {
        match self {
            Limit::Skip => 0,
            Limit::All => n,
            Limit::First(k) => k.min(n),
        }
    }
}

pub struct ModelSpec {
    pub key: &'static str,
    pub label: &'static str,
    pub repo: &'static str,
    pub revision: &'static str,
    pub model_sha256: &'static str,
    pub model_size: u64,
    /// Model file name in the repository.
    pub file: &'static str,
    pub preprocess: Preprocess,
    /// Per-category thresholds; categories not listed are not reported as tags.
    pub thresholds: &'static [(u8, f32)],
    pub directml: Limit,
    pub cpu: Limit,
    /// Part of the default run (the others need `--models all`).
    pub default: bool,
}

impl ModelSpec {
    pub fn threshold(&self, category: u8) -> Option<f32> {
        self.thresholds.iter().find(|(c, _)| *c == category).map(|(_, t)| *t)
    }
}

/// Category thresholds recommended on the PixAI v1.0 model card.
const V1_THRESHOLDS: &[(u8, f32)] = &[(0, 0.17), (1, 0.15), (3, 0.24), (4, 0.27), (5, 0.17), (9, 0.41)];

pub const MODELS: [ModelSpec; 4] = [
    ModelSpec {
        key: "pixai-v1.0-fp16",
        label: "PixAI Tagger v1.0 FP16 (Mexes ONNX)",
        repo: "Mexes/pixai-tagger-v1.0-onnx-fp32-fp16-int8",
        revision: "0800778563144a0e6fdf41ddadd84aae3cb0dbcf",
        model_sha256: "cd668e6760bb58ec400ce1b0286e5c9133f83b543caac6a378406b7d56f8c303",
        model_size: 992_916_002,
        file: "model_fp16.onnx",
        preprocess: Preprocess::PixAiV1,
        thresholds: V1_THRESHOLDS,
        // FP16 is for GPUs; on CPU it is slower than FP32.
        directml: Limit::All,
        cpu: Limit::Skip,
        default: true,
    },
    ModelSpec {
        key: "pixai-v1.0-fp32",
        label: "PixAI Tagger v1.0 FP32 (Mexes ONNX)",
        repo: "Mexes/pixai-tagger-v1.0-onnx-fp32-fp16-int8",
        revision: "0800778563144a0e6fdf41ddadd84aae3cb0dbcf",
        model_sha256: "1cae6083f07be1e1757125802566c767005ae883e4504c00db4ee1ef93486dad",
        model_size: 1_984_062_544,
        file: "model.onnx",
        preprocess: Preprocess::PixAiV1,
        thresholds: V1_THRESHOLDS,
        // A subset: enough to measure speed, memory and agreement without hours on CPU.
        directml: Limit::First(30),
        cpu: Limit::First(30),
        default: true,
    },
    ModelSpec {
        key: "pixai-v0.9",
        label: "PixAI Tagger v0.9 (DeepGHS ONNX)",
        repo: "deepghs/pixai-tagger-v0.9-onnx",
        revision: "d8cf666911a2c3d10d586d7823259192313c7eb7",
        model_sha256: "a8d479098b5e23f253543c93df42391736abbb77c21c2efd3a513b9cda7b3657",
        model_size: 1_271_365_854,
        file: "model.onnx",
        preprocess: Preprocess::PixAi,
        // From the repo's thresholds.csv.
        thresholds: &[(0, 0.3), (4, 0.85)],
        directml: Limit::All,
        cpu: Limit::All,
        default: false,
    },
    ModelSpec {
        key: "wd-swinv2-v3",
        label: "WD SwinV2 Tagger v3",
        repo: "SmilingWolf/wd-swinv2-tagger-v3",
        revision: "627aef95638667ddcaa3ac8ae625e88ea5b02f51",
        model_sha256: "e6774bff34d43bd49f75a47db4ef217dce701c9847b546523eb85ff6dbba1db1",
        model_size: 467_460_978,
        file: "model.onnx",
        preprocess: Preprocess::Wd,
        // P=R threshold from the model card; character default from the author's demo.
        thresholds: &[(0, 0.2653), (4, 0.85)],
        directml: Limit::All,
        cpu: Limit::All,
        default: false,
    },
];

pub struct Tag {
    pub name: String,
    pub category: u8,
}

pub struct LocalModel {
    pub spec: &'static ModelSpec,
    pub onnx: PathBuf,
    pub tags: Vec<Tag>,
}

fn url(spec: &ModelSpec, file: &str) -> String {
    format!("https://huggingface.co/{}/resolve/{}/{}", spec.repo, spec.revision, file)
}

/// Download `url` to `dest`, resuming a partial `.part` file when possible.
pub fn download(url: &str, dest: &Path, expected_size: Option<u64>, extra_headers: &[(&str, &str)]) -> Result<(), String> {
    let part = dest.with_extension("part");
    let have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let mut req = ureq::get(url).set("User-Agent", "kinshoko-tagger-probe");
    for (k, v) in extra_headers {
        req = req.set(k, v);
    }
    if have > 0 {
        req = req.set("Range", &format!("bytes={have}-"));
    }
    let resp = req.call().map_err(|e| format!("请求失败 {url}: {e}"))?;
    let resumed = resp.status() == 206;
    let total = expected_size.or_else(|| {
        resp.header("Content-Length")
            .and_then(|v| v.parse::<u64>().ok())
            .map(|n| if resumed { n + have } else { n })
    });
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&part)
        .map_err(|e| e.to_string())?;
    let mut done = if resumed { have } else { 0 };
    let initial = done;
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 1 << 20];
    let start = Instant::now();
    let mut last_print = Instant::now();
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("下载中断: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if let Some(total) = total.filter(|t| *t > 50_000_000) {
            if last_print.elapsed().as_secs_f32() > 2.0 {
                let rate = (done - initial) as f64 / start.elapsed().as_secs_f64().max(0.001);
                print!(
                    "\r    {} / {}  ({}/s)        ",
                    human_bytes(done),
                    human_bytes(total),
                    human_bytes(rate as u64)
                );
                let _ = std::io::stdout().flush();
                last_print = Instant::now();
            }
        }
    }
    drop(file);
    if total.map_or(false, |t| t > 50_000_000) {
        println!();
    }
    fs::rename(&part, dest).map_err(|e| e.to_string())
}

fn load_tags(path: &Path) -> Result<Vec<Tag>, String> {
    let mut rdr = csv::Reader::from_path(path).map_err(|e| e.to_string())?;
    let headers = rdr.headers().map_err(|e| e.to_string())?.clone();
    let name_i = headers.iter().position(|h| h == "name").ok_or("selected_tags.csv 缺少 name 列")?;
    let cat_i = headers.iter().position(|h| h == "category").ok_or("selected_tags.csv 缺少 category 列")?;
    rdr.records()
        .map(|r| {
            let r = r.map_err(|e| e.to_string())?;
            Ok(Tag {
                name: r[name_i].to_string(),
                category: r[cat_i].parse().map_err(|_| "category 不是数字".to_string())?,
            })
        })
        .collect()
}

/// Make sure the model and tag list are present and intact, downloading when needed.
pub fn ensure(spec: &'static ModelSpec, dir: &Path) -> Result<LocalModel, String> {
    let dir = dir.join(spec.key);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let onnx = dir.join("model.onnx");
    let tags_csv = dir.join("selected_tags.csv");

    let verified_marker = dir.join("model.onnx.verified");
    let needs_check = !verified_marker.exists() || fs::metadata(&onnx).map(|m| m.len()).unwrap_or(0) != spec.model_size;
    if needs_check {
        if fs::metadata(&onnx).map(|m| m.len()).unwrap_or(0) != spec.model_size {
            println!("  下载 {}（{}）…", spec.label, human_bytes(spec.model_size));
            download(&url(spec, spec.file), &onnx, Some(spec.model_size), &[])?;
        }
        println!("  校验 {} …", spec.label);
        let sha = sha256_file(&onnx).map_err(|e| e.to_string())?;
        if sha != spec.model_sha256 {
            let _ = fs::remove_file(&onnx);
            return Err(format!("{} 校验失败（已删除，请重新运行）", spec.label));
        }
        fs::write(&verified_marker, spec.model_sha256).map_err(|e| e.to_string())?;
    }
    if !tags_csv.exists() {
        download(&url(spec, "selected_tags.csv"), &tags_csv, None, &[])?;
    }
    let tags = load_tags(&tags_csv)?;
    Ok(LocalModel { spec, onnx, tags })
}
