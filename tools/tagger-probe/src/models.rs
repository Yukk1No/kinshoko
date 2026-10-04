//! Pinned model files and their download.

use crate::patch::{self, Chunking};
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
    /// Download folder; variants of the same file share it.
    pub dir: &'static str,
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
    /// Rewrite the downloaded file to chunk its global attention (see `patch`).
    pub chunking: Option<Chunking>,
    /// Approximate peak VRAM on DirectML, measured on the developer machine; the run is
    /// skipped when the adapter's budget is smaller. 0 means no check.
    pub vram_need: u64,
    /// Approximate peak committed memory on CPU; the run is skipped when less RAM is free.
    pub ram_need: u64,
    /// Part of the default run (the others need `--all-models`).
    pub default: bool,
}

impl ModelSpec {
    pub fn threshold(&self, category: u8) -> Option<f32> {
        self.thresholds.iter().find(|(c, _)| *c == category).map(|(_, t)| *t)
    }
}

/// Category thresholds recommended on the PixAI v1.0 model card.
const V1_THRESHOLDS: &[(u8, f32)] = &[(0, 0.17), (1, 0.15), (3, 0.24), (4, 0.27), (5, 0.17), (9, 0.41)];
const V1_REPO: &str = "Mexes/pixai-tagger-v1.0-onnx-fp32-fp16-int8";
const V1_REVISION: &str = "0800778563144a0e6fdf41ddadd84aae3cb0dbcf";
const V1_FP16_SHA256: &str = "cd668e6760bb58ec400ce1b0286e5c9133f83b543caac6a378406b7d56f8c303";
const V1_FP32_SHA256: &str = "1cae6083f07be1e1757125802566c767005ae883e4504c00db4ee1ef93486dad";
/// `global_att_blocks` in the PixAI v1.0 config; their 5184 tokens split into 8 chunks of 648.
const V1_GLOBAL_BLOCKS: &[u32] = &[7, 15, 23, 31];
const GB: u64 = 1_000_000_000;

pub const MODELS: [ModelSpec; 5] = [
    ModelSpec {
        key: "pixai-v1.0-fp16-chunked",
        label: "PixAI Tagger v1.0 FP16 分块注意力",
        dir: "pixai-v1.0-fp16",
        repo: V1_REPO,
        revision: V1_REVISION,
        model_sha256: V1_FP16_SHA256,
        model_size: 992_916_002,
        file: "model_fp16.onnx",
        preprocess: Preprocess::PixAiV1,
        thresholds: V1_THRESHOLDS,
        // FP16 is for GPUs; on CPU it is slower than FP32.
        directml: Limit::All,
        cpu: Limit::Skip,
        chunking: Some(Chunking { blocks: V1_GLOBAL_BLOCKS, chunks: 8, sha256: "238d6772320a9a9290352f75a5a3c066716e6adeb01eb5ce40502626bc3e9c3e" }),
        // 1.6 GiB on an RTX 4070 SUPER (3.6 GiB unchunked).
        vram_need: 1_800_000_000,
        ram_need: 0,
        default: true,
    },
    ModelSpec {
        key: "pixai-v1.0-fp16",
        label: "PixAI Tagger v1.0 FP16 原版（对照）",
        dir: "pixai-v1.0-fp16",
        repo: V1_REPO,
        revision: V1_REVISION,
        model_sha256: V1_FP16_SHA256,
        model_size: 992_916_002,
        file: "model_fp16.onnx",
        preprocess: Preprocess::PixAiV1,
        thresholds: V1_THRESHOLDS,
        // A few images to confirm what the unchunked graph does on small GPUs; no memory
        // check on purpose, the per-image time limit stops it if it stalls.
        directml: Limit::First(5),
        cpu: Limit::Skip,
        chunking: None,
        vram_need: 0,
        ram_need: 0,
        default: true,
    },
    ModelSpec {
        key: "pixai-v1.0-fp32-chunked",
        label: "PixAI Tagger v1.0 FP32 分块注意力",
        dir: "pixai-v1.0-fp32",
        repo: V1_REPO,
        revision: V1_REVISION,
        model_sha256: V1_FP32_SHA256,
        model_size: 1_984_062_544,
        file: "model.onnx",
        preprocess: Preprocess::PixAiV1,
        thresholds: V1_THRESHOLDS,
        // A subset: enough to measure speed, memory and agreement without hours on CPU.
        directml: Limit::First(30),
        cpu: Limit::First(10),
        chunking: Some(Chunking { blocks: V1_GLOBAL_BLOCKS, chunks: 8, sha256: "d55493761dba1da86ba6a927fee959ebcd9b87ea480c92bf01931ea02f025301" }),
        // 3.1 GiB VRAM and 4.6 GiB committed on CPU (7.1 GiB and 11.9 GiB unchunked).
        vram_need: 3_400_000_000,
        ram_need: 5 * GB,
        default: true,
    },
    ModelSpec {
        key: "pixai-v0.9",
        label: "PixAI Tagger v0.9 (DeepGHS ONNX)",
        dir: "pixai-v0.9",
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
        chunking: None,
        vram_need: 0,
        ram_need: 0,
        default: false,
    },
    ModelSpec {
        key: "wd-swinv2-v3",
        label: "WD SwinV2 Tagger v3",
        dir: "wd-swinv2-v3",
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
        chunking: None,
        vram_need: 0,
        ram_need: 0,
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
    let dir = dir.join(spec.dir);
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
    let onnx = match &spec.chunking {
        None => onnx,
        Some(c) => {
            let patched = dir.join(format!("model.chunked{}.onnx", c.chunks));
            let marker = dir.join(format!("model.chunked{}.verified", c.chunks));
            if fs::read_to_string(&marker).ok().as_deref() != Some(c.sha256) || !patched.exists() {
                say!("  生成 {} …", spec.label);
                patch::chunk_attention(&onnx, &patched, c).map_err(|e| format!("改写 {} 失败: {e}", spec.label))?;
                let sha = sha256_file(&patched).map_err(|e| e.to_string())?;
                if sha != c.sha256 {
                    let _ = fs::remove_file(&patched);
                    return Err(format!("{} 改写结果校验失败（{sha}）", spec.label));
                }
                fs::write(&marker, c.sha256).map_err(|e| e.to_string())?;
            }
            patched
        }
    };
    Ok(LocalModel { spec, onnx, tags })
}
