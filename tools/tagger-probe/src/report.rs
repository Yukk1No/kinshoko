//! CPU/DirectML agreement, per-sample predictions and the final report bundle.

use crate::bench::RunReport;
use crate::models::LocalModel;
use crate::samples::Sample;
use crate::sysinfo::Hardware;
use crate::util::human_bytes;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

const RATING_CATEGORY: u8 = 9;

#[derive(Serialize, Default)]
pub struct Agreement {
    pub model: String,
    pub compared_images: usize,
    pub max_abs_diff: f32,
    pub mean_abs_diff: f32,
    /// Images whose thresholded tag set is identical on both providers.
    pub identical_tag_sets: usize,
    pub min_tag_jaccard: f32,
    /// WD only: images whose top rating class matches.
    pub rating_agree: Option<usize>,
}

pub fn tag_set(model: &LocalModel, scores: &[f32]) -> BTreeSet<usize> {
    scores
        .iter()
        .enumerate()
        .filter(|(i, &s)| match model.tags.get(*i).map(|t| t.category) {
            Some(0) => s >= model.spec.general_threshold,
            Some(4) => s >= model.spec.character_threshold,
            _ => false,
        })
        .map(|(i, _)| i)
        .collect()
}

pub fn ratings(model: &LocalModel, scores: &[f32]) -> Option<BTreeMap<String, f32>> {
    let r: BTreeMap<String, f32> = model
        .tags
        .iter()
        .zip(scores)
        .filter(|(t, _)| t.category == RATING_CATEGORY)
        .map(|(t, &s)| (t.name.clone(), s))
        .collect();
    (!r.is_empty()).then_some(r)
}

fn top_rating(r: &BTreeMap<String, f32>) -> Option<&str> {
    r.iter().max_by(|a, b| a.1.total_cmp(b.1)).map(|(k, _)| k.as_str())
}

pub fn agreement(model: &LocalModel, cpu: &[Option<Vec<f32>>], gpu: &[Option<Vec<f32>>]) -> Agreement {
    let mut a = Agreement { model: model.spec.key.to_string(), min_tag_jaccard: 1.0, ..Default::default() };
    let (mut sum, mut count, mut rating_agree, mut has_rating) = (0f64, 0usize, 0usize, false);
    for (c, g) in cpu.iter().zip(gpu) {
        let (Some(c), Some(g)) = (c, g) else { continue };
        if c.len() != g.len() {
            continue;
        }
        a.compared_images += 1;
        for (x, y) in c.iter().zip(g) {
            let d = (x - y).abs();
            a.max_abs_diff = a.max_abs_diff.max(d);
            sum += d as f64;
            count += 1;
        }
        let (sc, sg) = (tag_set(model, c), tag_set(model, g));
        let union = sc.union(&sg).count();
        let jac = if union == 0 { 1.0 } else { sc.intersection(&sg).count() as f32 / union as f32 };
        a.min_tag_jaccard = a.min_tag_jaccard.min(jac);
        if sc == sg {
            a.identical_tag_sets += 1;
        }
        if let (Some(rc), Some(rg)) = (ratings(model, c), ratings(model, g)) {
            has_rating = true;
            if top_rating(&rc) == top_rating(&rg) {
                rating_agree += 1;
            }
        }
    }
    a.mean_abs_diff = if count == 0 { 0.0 } else { (sum / count as f64) as f32 };
    a.rating_agree = has_rating.then_some(rating_agree);
    a
}

#[derive(Serialize)]
struct Prediction<'a> {
    sample: &'a str,
    split: &'a str,
    truth_rating: &'a str,
    coverage: &'a [String],
    author_tags: &'a [String],
    model: &'a str,
    provider: &'a str,
    tags: BTreeMap<&'a str, f32>,
    ratings: Option<BTreeMap<String, f32>>,
}

/// One JSON line per sample and model, from the given provider's scores.
pub fn write_predictions(
    path: &Path,
    model: &LocalModel,
    provider: &str,
    samples: &[Sample],
    scores: &[Option<Vec<f32>>],
    append: bool,
) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new().create(true).append(append).write(true).truncate(!append).open(path)?;
    for (s, sc) in samples.iter().zip(scores) {
        let Some(sc) = sc else { continue };
        let tags = tag_set(model, sc).into_iter().map(|i| (model.tags[i].name.as_str(), sc[i])).collect();
        let p = Prediction {
            sample: &s.id,
            split: &s.split,
            truth_rating: &s.rating,
            coverage: &s.coverage,
            author_tags: &s.author_tags,
            model: model.spec.key,
            provider,
            tags,
            ratings: ratings(model, sc),
        };
        serde_json::to_writer(&mut f, &p)?;
        f.write_all(b"\n")?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct Report<'a> {
    pub probe_version: &'static str,
    pub created_unix: u64,
    pub mode: &'a str,
    pub hardware: &'a Hardware,
    pub samples_used: usize,
    pub samples_missing: usize,
    pub runs: &'a [RunReport],
    pub agreement: &'a [Agreement],
    pub drawing_app_answer: Option<String>,
    pub notes: Vec<String>,
}

fn ms(v: f64) -> String {
    if v >= 1000.0 {
        format!("{:.2} s", v / 1000.0)
    } else {
        format!("{v:.0} ms")
    }
}

pub fn markdown(r: &Report) -> String {
    let mut s = String::new();
    let _ = writeln!(s, "# Kinshoko 打标探测报告\n");
    let h = r.hardware;
    let _ = writeln!(s, "- 系统：{}\n- CPU：{}（{} 线程）\n- 内存：{}", h.os, h.cpu, h.logical_cores, human_bytes(h.ram_bytes));
    for a in &h.adapters {
        let _ = writeln!(s, "- 显卡：{}（专用显存 {}）", a.name, human_bytes(a.dedicated_vram_bytes));
    }
    let _ = writeln!(s, "- 显示器：{}", h.displays.join("、"));
    let _ = writeln!(s, "- 模式：{}；样本 {} 张（缺失 {}）\n", r.mode, r.samples_used, r.samples_missing);
    let _ = writeln!(s, "| 模型 | 设备 | 结果 | 加载 | 首张 | 推理 p50 | 推理 p95 | 解码 p50 | 预处理 p50 | 总耗时 | 峰值内存 | 峰值显存 | 节点分布 |");
    let _ = writeln!(s, "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for run in r.runs {
        let mut nodes = run.nodes_by_provider.iter().map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>().join("<br>");
        if !run.nodes_by_provider.is_empty() {
            let heavy = if run.heavy_non_dml_ops.is_empty() {
                "无".to_string()
            } else {
                run.heavy_non_dml_ops.iter().map(|(k, v)| format!("{k}×{v}")).collect::<Vec<_>>().join(" ")
            };
            nodes.push_str(&format!("<br>计算密集算子回落 CPU：{heavy}"));
        }
        let _ = writeln!(
            s,
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {:.0} s | {} | {} | {} |",
            run.model,
            run.ep.map(|e| e.label()).unwrap_or("-"),
            if run.ok { format!("✓ {} 张", run.images) } else { format!("✗ {}", run.error.as_deref().unwrap_or("失败")) },
            ms(run.load_ms),
            ms(run.first_image_ms),
            ms(run.inference.p50_ms),
            ms(run.inference.p95_ms),
            ms(run.decode.p50_ms),
            ms(run.preprocess.p50_ms),
            run.total_seconds,
            human_bytes(run.peak_working_set_bytes),
            human_bytes(run.peak_vram_bytes),
            nodes
        );
    }
    if !r.agreement.is_empty() {
        let _ = writeln!(s, "\n## CPU 与 DirectML 结果一致性\n");
        let _ = writeln!(s, "| 模型 | 比较张数 | 最大分数差 | 平均分数差 | 标签集合完全一致 | 最低 Jaccard | 分级一致 |");
        let _ = writeln!(s, "|---|---|---|---|---|---|---|");
        for a in r.agreement {
            let _ = writeln!(
                s,
                "| {} | {} | {:.2e} | {:.2e} | {} | {:.3} | {} |",
                a.model,
                a.compared_images,
                a.max_abs_diff,
                a.mean_abs_diff,
                a.identical_tag_sets,
                a.min_tag_jaccard,
                a.rating_agree.map(|n| n.to_string()).unwrap_or("-".into())
            );
        }
    }
    if let Some(ans) = &r.drawing_app_answer {
        let _ = writeln!(s, "\n运行期间优动漫的情况：{ans}");
    }
    for n in &r.notes {
        let _ = writeln!(s, "\n> {n}");
    }
    s
}

/// Zip the given files (stored under their file names) into `dest`.
pub fn bundle(dest: &Path, files: &[PathBuf]) -> zip::result::ZipResult<()> {
    let mut zip = zip::ZipWriter::new(File::create(dest)?);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for f in files {
        if let (Some(name), Ok(data)) = (f.file_name(), std::fs::read(f)) {
            zip.start_file(name.to_string_lossy(), opts)?;
            zip.write_all(&data)?;
        }
    }
    zip.finish()?;
    Ok(())
}
