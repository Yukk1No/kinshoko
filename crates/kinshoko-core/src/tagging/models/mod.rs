//! 固定版本的打标模型与本机模型仓库：下载（断点续传）、校验 SHA-256、改写为分块注意力。
//!
//! 版本、大小与哈希沿用 `tools/tagger-probe` 在画师机器上跑通的那一组（#6）。
//! 目录布局：`<模型目录>/<key>/model.onnx`、`model.onnx.verified`（校验过的哈希，下次不再重算）、
//! `selected_tags.csv`，有分块改写时另有 `model.chunked<N>.onnx` 与 `model.chunked<N>.verified`。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use serde::Serialize;
use sha2::{Digest, Sha256};
use ts_rs::TS;

mod download;
mod package;

use download::download;

use super::patch;
use super::port::{Device, PreparedModel};
use crate::CommandError;
use crate::command_error::ErrorKind;

/// 分块注意力改写（见 [`patch`]）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunking {
    /// 全局注意力块的编号（节点名 `/blocks.{i}/attn/...`）。
    pub blocks: Vec<u32>,
    /// 查询分成几块；token 数必须能整除。
    pub chunks: u32,
    /// 改写结果的 SHA-256，用来发现与测过的改写不同的结果。
    pub sha256: String,
}

/// 一个固定版本的打标模型。
#[derive(Debug, Clone, PartialEq)]
pub struct ModelSpec {
    pub key: String,
    /// 打标模型的名称（设置里“Tagger 模型”一行），同一模型的各硬件档相同。
    pub name: String,
    /// 这个条目（打标模型 × 硬件档）的名称，用在状态与出错原因里；不写精度。
    pub label: String,
    /// 写入资料库时的模型来源名（`FactSource::model`）。同一模型的不同精度共用一个来源，
    /// 换设备档位不会重复打标。
    pub source: String,
    pub repo: String,
    pub revision: String,
    /// 仓库中的模型文件名。
    pub file: String,
    pub size: u64,
    pub sha256: String,
    /// 仓库中的词表文件名（列 `name`、`category`）。
    pub tags_file: String,
    /// 词表的 SHA-256。模型输出按词表的行一一对应，内容、顺序与行数都随模型固定；
    /// 不符的词表一律不装、不算就绪。
    pub tags_sha256: String,
    pub chunking: Option<Chunking>,
    /// 这个模型用的设备档位。
    pub device: Device,
    /// DirectML 下的显存峰值估计；可用额度要比它多 25%。
    pub vram_need: u64,
    /// CPU 下的内存峰值估计；可用内存要比它多 1.5 GB。0 表示不检查。
    pub ram_need: u64,
    /// 各类别的阈值；没有列出的类别不是标签。
    pub thresholds: Vec<(u8, f32)>,
    /// 分级所在的类别；最高分的一项就是分级建议。
    pub rating_category: Option<u8>,
}

impl ModelSpec {
    pub fn threshold(&self, category: u8) -> Option<f32> {
        self.thresholds
            .iter()
            .find(|(c, _)| *c == category)
            .map(|(_, t)| *t)
    }

    /// 首次使用要下载的字节数（模型文件；词表很小，不计）。
    pub fn download_size(&self) -> u64 {
        self.size
    }
}

const V1_REPO: &str = "Mexes/pixai-tagger-v1.0-onnx-fp32-fp16-int8";
const V1_REVISION: &str = "0800778563144a0e6fdf41ddadd84aae3cb0dbcf";
/// 这一修订的 `selected_tags.csv`（与 `data/builtin-approx-table.json` 记录的词表同一文件）。
const V1_TAGS_SHA256: &str = "a9455cbf0a910d4a3890739f2f70bd986278f4594285ef1049121a03896e2a6d";
/// PixAI v1.0 配置中的 `global_att_blocks`；5184 个 token 分成 8 块，每块 648。
const V1_GLOBAL_BLOCKS: [u32; 4] = [7, 15, 23, 31];
/// PixAI v1.0 模型卡推荐的各类别阈值；第 9 类是分级。
const V1_THRESHOLDS: [(u8, f32); 6] = [
    (0, 0.17),
    (1, 0.15),
    (3, 0.24),
    (4, 0.27),
    (5, 0.17),
    (9, 0.41),
];

/// 内置的模型，按优先顺序：有独显时用 FP16 分块版，没有时退到 CPU 档的 FP32 分块版。
pub fn catalog() -> Vec<ModelSpec> {
    let v1 = |key: &str, label: &str, file: &str, size: u64, sha: &str, chunked: &str| ModelSpec {
        key: key.into(),
        name: "PixAI Tagger v1.0".into(),
        label: label.into(),
        source: "pixai-tagger-v1.0".into(),
        repo: V1_REPO.into(),
        revision: V1_REVISION.into(),
        file: file.into(),
        size,
        sha256: sha.into(),
        tags_file: "selected_tags.csv".into(),
        tags_sha256: V1_TAGS_SHA256.into(),
        chunking: Some(Chunking {
            blocks: V1_GLOBAL_BLOCKS.to_vec(),
            chunks: 8,
            sha256: chunked.into(),
        }),
        device: Device::DirectMl,
        vram_need: 0,
        ram_need: 0,
        thresholds: V1_THRESHOLDS.to_vec(),
        rating_category: Some(9),
    };
    vec![
        ModelSpec {
            // RTX 4070 SUPER 上峰值 1.6 GiB（不分块 3.6 GiB）；RX 6500 XT 4 GB 上约 2.75 秒一张。
            vram_need: 1_800_000_000,
            ..v1(
                "pixai-v1.0-fp16-chunked",
                "PixAI Tagger v1.0（显卡）",
                "model_fp16.onnx",
                992_916_002,
                "cd668e6760bb58ec400ce1b0286e5c9133f83b543caac6a378406b7d56f8c303",
                "238d6772320a9a9290352f75a5a3c066716e6adeb01eb5ce40502626bc3e9c3e",
            )
        },
        ModelSpec {
            // FP16 在 CPU 上比 FP32 慢；CPU 档提交内存峰值 4.6 GiB，约 29 秒一张。
            device: Device::Cpu,
            ram_need: 5_000_000_000,
            ..v1(
                "pixai-v1.0-fp32-chunked",
                "PixAI Tagger v1.0（CPU）",
                "model.onnx",
                1_984_062_544,
                "1cae6083f07be1e1757125802566c767005ae883e4504c00db4ee1ef93486dad",
                "d55493761dba1da86ba6a927fee959ebcd9b87ea480c92bf01931ea02f025301",
            )
        },
    ]
}

/// 设置里“硬件加速”的一个选项：这一档模型文件的显存或内存需求、下载大小、本机是否已下载。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HardwareOption {
    pub device: Device,
    /// DirectML 下的显存峰值估计。
    #[ts(type = "number")]
    pub vram_need: u64,
    /// CPU 下的内存峰值估计；0 表示不检查。
    #[ts(type = "number")]
    pub ram_need: u64,
    /// 首次使用要下载的字节数。
    #[ts(type = "number")]
    pub size: u64,
    /// 已下载、校验（并改写）好，不必再下载。
    pub downloaded: bool,
}

/// 设置中“自动标签 › 模型”一节：打标模型的名称、画师选的硬件档与各档的选项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ModelChoice {
    pub model: String,
    /// 画师选的硬件档；`None` 表示按本机条件自动选择。
    pub selected: Option<Device>,
    /// 每个硬件档一项，按 `models` 中第一次出现的顺序。
    pub options: Vec<HardwareOption>,
}

/// 默认的下载地址前缀。
pub const HUGGING_FACE: &str = "https://huggingface.co";

/// 准备模型时的阶段，用于显示进度。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrepareStage {
    Downloading {
        downloaded: u64,
        total: u64,
    },
    /// 校验哈希、改写为分块注意力。
    Verifying,
}

/// 本机的模型仓库。
#[derive(Debug, Clone)]
pub struct ModelStore {
    dir: PathBuf,
    base_url: String,
}

impl ModelStore {
    pub fn new(dir: PathBuf, base_url: &str) -> ModelStore {
        ModelStore {
            dir,
            base_url: base_url.trim_end_matches('/').to_owned(),
        }
    }

    fn url(&self, spec: &ModelSpec, file: &str) -> String {
        format!(
            "{}/{}/resolve/{}/{}",
            self.base_url, spec.repo, spec.revision, file
        )
    }

    fn paths(&self, spec: &ModelSpec) -> Paths {
        let dir = self.dir.join(&spec.key);
        let chunked = spec.chunking.as_ref().map(|c| {
            (
                dir.join(format!("model.chunked{}.onnx", c.chunks)),
                dir.join(format!("model.chunked{}.verified", c.chunks)),
            )
        });
        Paths {
            onnx: dir.join("model.onnx"),
            marker: dir.join("model.onnx.verified"),
            tags: dir.join("selected_tags.csv"),
            chunked,
            dir,
        }
    }

    /// 模型已就绪时返回它；不下载、不重算哈希。
    pub fn ready(&self, spec: &ModelSpec) -> Option<PreparedModel> {
        let p = self.paths(spec);
        // 词表很小（PixAI v1.0 约 0.8 MB），每次都重算哈希：校验之前装好的目录、事后被换掉的词表都不算就绪。
        let verified = fs::read_to_string(&p.marker).ok()? == spec.sha256
            && file_len(&p.onnx) == Some(spec.size)
            && tags_match(spec, &p.tags);
        if !verified {
            return None;
        }
        let onnx = match (&spec.chunking, &p.chunked) {
            (Some(c), Some((onnx, marker))) => {
                if fs::read_to_string(marker).ok()? != c.sha256 || !onnx.is_file() {
                    return None;
                }
                onnx.clone()
            }
            _ => p.onnx.clone(),
        };
        Some(PreparedModel {
            spec: spec.clone(),
            onnx,
            tags_csv: p.tags,
        })
    }

    /// 设置里的模型一节：每个硬件档取 `models` 中这一档的第一个条目（调度器选的也是它）。
    pub fn choice(&self, models: &[ModelSpec], selected: Option<Device>) -> ModelChoice {
        let mut options: Vec<HardwareOption> = Vec::new();
        for spec in models {
            if options.iter().any(|o| o.device == spec.device) {
                continue;
            }
            options.push(HardwareOption {
                device: spec.device,
                vram_need: spec.vram_need,
                ram_need: spec.ram_need,
                size: spec.download_size(),
                downloaded: self.ready(spec).is_some(),
            });
        }
        ModelChoice {
            model: models.first().map(|m| m.name.clone()).unwrap_or_default(),
            selected,
            options,
        }
    }

    /// 已经下载了多少字节（含上次中断留下的部分）。
    pub fn downloaded(&self, spec: &ModelSpec) -> u64 {
        let p = self.paths(spec);
        file_len(&p.onnx)
            .filter(|n| *n == spec.size)
            .or_else(|| file_len(&p.onnx.with_extension("part")))
            .unwrap_or(0)
    }

    /// 下载（可续传）、校验并改写模型。`cancel` 置位时尽快停下，已下载的部分保留。
    pub fn prepare(
        &self,
        spec: &ModelSpec,
        progress: &mut dyn FnMut(PrepareStage),
        cancel: &AtomicBool,
    ) -> Result<PreparedModel, CommandError> {
        let p = self.paths(spec);
        fs::create_dir_all(&p.dir).map_err(no_model_dir)?;
        let verified = fs::read_to_string(&p.marker).ok().as_deref() == Some(&spec.sha256)
            && file_len(&p.onnx) == Some(spec.size);
        if !verified {
            let _ = fs::remove_file(&p.marker);
            if file_len(&p.onnx) != Some(spec.size) {
                download(
                    &self.url(spec, &spec.file),
                    &p.onnx,
                    Some(spec.size),
                    progress,
                    cancel,
                )?;
            }
            progress(PrepareStage::Verifying);
            let sha = sha256_file(&p.onnx).map_err(|e| {
                CommandError::new(
                    ErrorKind::ModelUnreadable {
                        detail: e.to_string(),
                    },
                    format!("无法读取模型：{e}"),
                )
            })?;
            if sha != spec.sha256 {
                let _ = fs::remove_file(&p.onnx);
                return Err(CommandError::new(
                    ErrorKind::ModelChecksumFailed {
                        model: spec.label.clone(),
                    },
                    format!("{} 校验失败，已删除，稍后重新下载", spec.label),
                ));
            }
            fs::write(&p.marker, &spec.sha256).map_err(CommandError::system)?;
        }
        if !tags_match(spec, &p.tags) {
            let _ = fs::remove_file(&p.tags);
            download(
                &self.url(spec, &spec.tags_file),
                &p.tags,
                None,
                &mut |_| {},
                cancel,
            )?;
            if !tags_match(spec, &p.tags) {
                let _ = fs::remove_file(&p.tags);
                return Err(CommandError::new(
                    ErrorKind::ModelTagsChecksumFailed {
                        model: spec.label.clone(),
                    },
                    format!("{} 的词表校验失败，已删除，稍后重新下载", spec.label),
                ));
            }
        }
        chunk(spec, &p, progress)?;
        self.ready(spec).ok_or_else(|| {
            CommandError::new(
                ErrorKind::ModelIncomplete {
                    model: spec.label.clone(),
                },
                format!("{} 准备后仍不完整", spec.label),
            )
        })
    }
}

const TAGS_FILE: &str = "selected_tags.csv";

/// 有分块改写时，在本机把模型改写为分块注意力并校验结果。
fn chunk(
    spec: &ModelSpec,
    p: &Paths,
    progress: &mut dyn FnMut(PrepareStage),
) -> Result<(), CommandError> {
    if let (Some(c), Some((onnx, marker))) = (&spec.chunking, &p.chunked)
        && (fs::read_to_string(marker).ok().as_deref() != Some(&c.sha256) || !onnx.is_file())
    {
        progress(PrepareStage::Verifying);
        let _ = fs::remove_file(marker);
        patch::chunk_attention(&p.onnx, onnx, c).map_err(|e| {
            CommandError::new(
                ErrorKind::ModelChunkFailed {
                    model: spec.label.clone(),
                    detail: e.to_string(),
                },
                format!("改写 {} 失败：{e}", spec.label),
            )
        })?;
        let sha = sha256_file(onnx).map_err(CommandError::system)?;
        if sha != c.sha256 {
            let _ = fs::remove_file(onnx);
            return Err(CommandError::new(
                ErrorKind::ModelChunkChecksumFailed {
                    model: spec.label.clone(),
                    sha: sha.clone(),
                },
                format!("{} 改写结果校验失败（{sha}）", spec.label),
            ));
        }
        fs::write(marker, &c.sha256).map_err(CommandError::system)?;
    }
    Ok(())
}

struct Paths {
    dir: PathBuf,
    onnx: PathBuf,
    marker: PathBuf,
    tags: PathBuf,
    chunked: Option<(PathBuf, PathBuf)>,
}

fn file_len(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().map(|m| m.len())
}

/// 词表文件在且与模型固定的词表一致。
fn tags_match(spec: &ModelSpec, path: &Path) -> bool {
    sha256_file(path).is_ok_and(|sha| sha == spec.tags_sha256)
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    copy_hashing(&mut fs::File::open(path)?, &mut std::io::sink())
}

/// 把 `from` 全部写进 `to`，返回内容的 SHA-256。
fn copy_hashing(from: &mut dyn Read, to: &mut dyn Write) -> std::io::Result<String> {
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        to.write_all(&buf[..n])?;
    }
    to.flush()?;
    Ok(format!("{:x}", h.finalize()))
}

fn no_model_dir(e: std::io::Error) -> CommandError {
    CommandError::new(
        ErrorKind::ModelDirFailed {
            detail: e.to_string(),
        },
        format!("无法建立模型目录：{e}"),
    )
}
