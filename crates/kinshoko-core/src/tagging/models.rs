//! 固定版本的打标模型与本机模型仓库：下载（断点续传）、校验 SHA-256、改写为分块注意力。
//!
//! 版本、大小与哈希沿用 `tools/tagger-probe` 在画师机器上跑通的那一组（#6）。
//! 目录布局：`<模型目录>/<key>/model.onnx`、`model.onnx.verified`（校验过的哈希，下次不再重算）、
//! `selected_tags.csv`，有分块改写时另有 `model.chunked<N>.onnx` 与 `model.chunked<N>.verified`。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use sha2::{Digest, Sha256};
use ts_rs::TS;

use super::patch;
use super::port::{Device, PreparedModel};

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
    /// 设置界面显示的名称。
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
        label: label.into(),
        source: "pixai-tagger-v1.0".into(),
        repo: V1_REPO.into(),
        revision: V1_REVISION.into(),
        file: file.into(),
        size,
        sha256: sha.into(),
        tags_file: "selected_tags.csv".into(),
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
                "PixAI Tagger v1.0 FP16（显卡）",
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
                "PixAI Tagger v1.0 FP32（CPU）",
                "model.onnx",
                1_984_062_544,
                "1cae6083f07be1e1757125802566c767005ae883e4504c00db4ee1ef93486dad",
                "d55493761dba1da86ba6a927fee959ebcd9b87ea480c92bf01931ea02f025301",
            )
        },
    ]
}

/// 设置界面里的一个可选模型：名称、设备档位、显存或内存需求、大小、本机是否已装好。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ModelOption {
    pub key: String,
    pub label: String,
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
    pub installed: bool,
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
        let verified = fs::read_to_string(&p.marker).ok()? == spec.sha256
            && file_len(&p.onnx) == Some(spec.size)
            && p.tags.is_file();
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

    /// 设置界面的模型列表，按 `models` 的顺序。
    pub fn options(&self, models: &[ModelSpec]) -> Vec<ModelOption> {
        models
            .iter()
            .map(|spec| ModelOption {
                key: spec.key.clone(),
                label: spec.label.clone(),
                device: spec.device,
                vram_need: spec.vram_need,
                ram_need: spec.ram_need,
                size: spec.download_size(),
                installed: self.ready(spec).is_some(),
            })
            .collect()
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
    ) -> Result<PreparedModel, String> {
        let p = self.paths(spec);
        fs::create_dir_all(&p.dir).map_err(|e| format!("无法建立模型目录：{e}"))?;
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
            let sha = sha256_file(&p.onnx).map_err(|e| format!("无法读取模型：{e}"))?;
            if sha != spec.sha256 {
                let _ = fs::remove_file(&p.onnx);
                return Err(format!("{} 校验失败，已删除，稍后重新下载", spec.label));
            }
            fs::write(&p.marker, &spec.sha256).map_err(|e| e.to_string())?;
        }
        if !p.tags.is_file() {
            download(
                &self.url(spec, &spec.tags_file),
                &p.tags,
                None,
                &mut |_| {},
                cancel,
            )?;
        }
        chunk(spec, &p, progress)?;
        self.ready(spec)
            .ok_or_else(|| format!("{} 准备后仍不完整", spec.label))
    }

    /// 从文件导入模型包（没有网络时）：zip 里有一个模型文件（`.onnx`，名字不限、可在子文件夹里）
    /// 和词表 `selected_tags.csv`。按大小与 SHA-256 认出是 `models` 中的哪一个，校验通过才装进
    /// 模型目录（随后在本机改写为分块注意力）；校验不过时什么也不留下。返回装好的模型。
    pub fn import_package(
        &self,
        package: &Path,
        models: &[ModelSpec],
    ) -> Result<ModelSpec, String> {
        let file = fs::File::open(package).map_err(|e| format!("无法打开模型包：{e}"))?;
        let mut zip =
            zip::ZipArchive::new(file).map_err(|e| format!("无法读取模型包（不是 zip）：{e}"))?;
        let unreadable = |e: zip::result::ZipError| format!("无法读取模型包：{e}");
        let (mut onnx, mut tags) = (None, None);
        for i in 0..zip.len() {
            let entry = zip.by_index(i).map_err(unreadable)?;
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().rsplit(['/', '\\']).next().unwrap_or("");
            if name.to_ascii_lowercase().ends_with(".onnx") {
                if onnx.is_some() {
                    return Err("模型包里有不止一个模型文件（.onnx）".into());
                }
                onnx = Some((i, name.to_owned(), entry.size()));
            } else if name == TAGS_FILE {
                tags = Some(i);
            }
        }
        let (onnx_index, onnx_name, size) =
            onnx.ok_or("模型包里没有模型文件（.onnx）".to_owned())?;
        let tags_index = tags.ok_or(format!("模型包里没有词表 {TAGS_FILE}"))?;
        let mut tags_csv = Vec::new();
        zip.by_index(tags_index)
            .map_err(unreadable)?
            .read_to_end(&mut tags_csv)
            .map_err(|e| format!("无法读取模型包：{e}"))?;
        check_tags_csv(&tags_csv)?;
        let candidates: Vec<&ModelSpec> = models.iter().filter(|s| s.size == size).collect();
        if candidates.is_empty() {
            return Err(format!("模型包里的 {onnx_name} 不是 Kinshoko 支持的模型"));
        }

        // 先解压到模型目录里的临时文件，边写边算哈希；认出是哪个模型后再改名就位。
        fs::create_dir_all(&self.dir).map_err(|e| format!("无法建立模型目录：{e}"))?;
        let tmp = self
            .dir
            .join(format!(".import-{}.part", uuid::Uuid::new_v4()));
        let extracted = zip
            .by_index(onnx_index)
            .map_err(unreadable)
            .and_then(|mut entry| {
                let mut out = fs::File::create(&tmp).map_err(|e| e.to_string())?;
                copy_hashing(&mut entry, &mut out).map_err(|e| format!("解压模型失败：{e}"))
            });
        let spec = match extracted {
            Ok(sha) => candidates.into_iter().find(|s| s.sha256 == sha),
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(e);
            }
        };
        let Some(spec) = spec else {
            let _ = fs::remove_file(&tmp);
            return Err(format!(
                "模型包校验失败：{onnx_name} 已损坏，或不是 Kinshoko 支持的版本"
            ));
        };
        let p = self.paths(spec);
        let installed = (|| {
            fs::create_dir_all(&p.dir)?;
            let _ = fs::remove_file(&p.marker);
            let _ = fs::remove_file(p.onnx.with_extension("part"));
            fs::rename(&tmp, &p.onnx)?;
            fs::write(&p.tags, &tags_csv)?;
            fs::write(&p.marker, &spec.sha256)
        })();
        if let Err(e) = installed {
            let _ = fs::remove_file(&tmp);
            return Err(format!("无法安装模型：{e}"));
        }
        chunk(spec, &p, &mut |_| {})?;
        self.ready(spec)
            .map(|_| spec.clone())
            .ok_or_else(|| format!("{} 导入后仍不完整", spec.label))
    }
}

const TAGS_FILE: &str = "selected_tags.csv";

/// 词表要有 `name` 与 `category` 两列、至少一行，类别是数字（与打标子进程读词表的规则一致）。
fn check_tags_csv(bytes: &[u8]) -> Result<(), String> {
    let bad = || format!("模型包里的词表 {TAGS_FILE} 格式不对");
    let mut reader = csv::Reader::from_reader(bytes);
    let header = reader.headers().map_err(|_| bad())?.clone();
    let column = |name: &str| header.iter().position(|h| h.trim() == name);
    let (Some(name), Some(category)) = (column("name"), column("category")) else {
        return Err(bad());
    };
    let mut rows = 0;
    for record in reader.records() {
        let record = record.map_err(|_| bad())?;
        let ok = record.get(name).is_some_and(|n| !n.is_empty())
            && record
                .get(category)
                .is_some_and(|c| c.trim().parse::<u8>().is_ok());
        if !ok {
            return Err(bad());
        }
        rows += 1;
    }
    if rows == 0 {
        return Err(bad());
    }
    Ok(())
}

/// 有分块改写时，在本机把模型改写为分块注意力并校验结果。
fn chunk(
    spec: &ModelSpec,
    p: &Paths,
    progress: &mut dyn FnMut(PrepareStage),
) -> Result<(), String> {
    if let (Some(c), Some((onnx, marker))) = (&spec.chunking, &p.chunked)
        && (fs::read_to_string(marker).ok().as_deref() != Some(&c.sha256) || !onnx.is_file())
    {
        progress(PrepareStage::Verifying);
        let _ = fs::remove_file(marker);
        patch::chunk_attention(&p.onnx, onnx, c)
            .map_err(|e| format!("改写 {} 失败：{e}", spec.label))?;
        let sha = sha256_file(onnx).map_err(|e| e.to_string())?;
        if sha != c.sha256 {
            let _ = fs::remove_file(onnx);
            return Err(format!("{} 改写结果校验失败（{sha}）", spec.label));
        }
        fs::write(marker, &c.sha256).map_err(|e| e.to_string())?;
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

/// 把 `url` 下载到 `dest`：先写 `.part`，有旧的 `.part` 时用 `Range` 续传，完整后改名。
fn download(
    url: &str,
    dest: &Path,
    expected_size: Option<u64>,
    progress: &mut dyn FnMut(PrepareStage),
    cancel: &AtomicBool,
) -> Result<(), String> {
    let part = dest.with_extension("part");
    let mut have = file_len(&part).unwrap_or(0);
    if let Some(size) = expected_size {
        if have == size {
            // 上次下完但没来得及改名；随后的哈希校验兜底。
            return fs::rename(&part, dest).map_err(|e| e.to_string());
        }
        if have > size {
            let _ = fs::remove_file(&part);
            have = 0;
        }
    }
    let mut req = ureq::get(url).set("User-Agent", "kinshoko");
    if have > 0 {
        req = req.set("Range", &format!("bytes={have}-"));
    }
    let resp = req.call().map_err(|e| format!("下载失败：{e}"))?;
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
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 1 << 16];
    let mut last_report = 0u64;
    progress(PrepareStage::Downloading {
        downloaded: done,
        total: total.unwrap_or(0),
    });
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("下载已停止".into());
        }
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("下载中断：{e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if done - last_report >= 1 << 20 || Some(done) == total {
            last_report = done;
            progress(PrepareStage::Downloading {
                downloaded: done,
                total: total.unwrap_or(0),
            });
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    if let Some(total) = total
        && done != total
    {
        return Err(format!("下载中断：只收到 {done} / {total} 字节"));
    }
    fs::rename(&part, dest).map_err(|e| e.to_string())
}
