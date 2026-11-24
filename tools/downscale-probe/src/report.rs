//! 报告：画师逐组的选择与留言，写成本地 zip（`report.json` 与 `报告.md`）。
//!
//! 报告只有清单 id、比例、哪一边是哪种算法、选择、留言、用时、缩略图哈希与环境信息；
//! 不含文件名、路径与图片本身。

use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{Algorithm, Plan};

/// 画师在一组里的选择：哪一边更还原，或看不出区别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Choice {
    Left,
    Right,
    Same,
}

/// 一组的回答。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    /// 组号（从 1 起）。
    pub group: usize,
    pub choice: Option<Choice>,
    #[serde(default)]
    pub comment: String,
    /// 这一组看了多久（秒）。
    #[serde(default)]
    pub seconds: f64,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// 报告的 JSON。
pub fn report_json(plan: &Plan, answers: &[Answer], comment: &str, environment: Value) -> Value {
    let mut linear = 0;
    let mut encoded = 0;
    let mut same = 0;
    let mut unanswered = 0;
    let groups: Vec<Value> = plan
        .groups
        .iter()
        .map(|g| {
            let answer = answers.iter().find(|a| a.group == g.number);
            let chosen = match answer.and_then(|a| a.choice) {
                None => {
                    unanswered += 1;
                    Value::Null
                }
                Some(choice) => match g.algorithm(choice) {
                    None => {
                        same += 1;
                        json!("same")
                    }
                    Some(a) => {
                        match a {
                            Algorithm::LinearLight => linear += 1,
                            Algorithm::EncodedValue => encoded += 1,
                        }
                        json!(a.key())
                    }
                },
            };
            json!({
                "group": g.number,
                "sample": g.sample_id,
                "sampleKind": g.sample_kind.key(),
                "scale": g.scale,
                "left": g.left.key(),
                "right": g.right.key(),
                "chosen": chosen,
                "comment": answer.map(|a| a.comment.trim()).unwrap_or(""),
                "seconds": answer.map(|a| a.seconds).unwrap_or(0.0),
                "size": [g.left_image.width, g.left_image.height],
                "thumbnailSha256": {
                    g.left.key(): hash(&g.left_image.bytes),
                    g.right.key(): hash(&g.right_image.bytes),
                },
            })
        })
        .collect();
    json!({
        "probe": "kinshoko-downscale-probe",
        "version": env!("CARGO_PKG_VERSION"),
        "issue": 48,
        "seed": plan.seed,
        "comment": comment.trim(),
        "tally": {
            Algorithm::LinearLight.key(): linear,
            Algorithm::EncodedValue.key(): encoded,
            "same": same,
            "unanswered": unanswered,
        },
        "groups": groups,
        "environment": environment,
    })
}

/// 给人看的报告。
pub fn report_markdown(report: &Value) -> String {
    let t = &report["tally"];
    let n = |k: &str| t[k].as_u64().unwrap_or(0);
    let (linear, encoded) = (
        n(Algorithm::LinearLight.key()),
        n(Algorithm::EncodedValue.key()),
    );
    let verdict = if linear > encoded {
        "线性光更还原的组更多"
    } else if encoded > linear {
        "编码值空间更还原的组更多"
    } else {
        "两种一样多"
    };
    let mut md = String::new();
    md.push_str("# Kinshoko 缩小对比报告（#48）\n\n");
    md.push_str(&format!(
        "线性光 {linear} 组，编码值空间 {encoded} 组，看不出区别 {} 组，未选 {} 组：{verdict}。\n\n",
        n("same"),
        n("unanswered"),
    ));
    let comment = report["comment"].as_str().unwrap_or("");
    if !comment.is_empty() {
        md.push_str(&format!("整体留言：{comment}\n\n"));
    }
    md.push_str("| 组 | 样本 | 比例 | 左 | 右 | 选择 | 留言 |\n|---|---|---|---|---|---|---|\n");
    let label = |k: &str| match k {
        "linear-light" => Algorithm::LinearLight.label(),
        "encoded-value" => Algorithm::EncodedValue.label(),
        "same" => "看不出区别",
        _ => "未选",
    };
    for g in report["groups"].as_array().into_iter().flatten() {
        let s = |k: &str| g[k].as_str().unwrap_or("").to_string();
        md.push_str(&format!(
            "| {} | {} | {} | {} | {} | {} | {} |\n",
            g["group"],
            s("sample"),
            s("scale"),
            label(&s("left")),
            label(&s("right")),
            label(&s("chosen")),
            s("comment").replace('|', "／").replace('\n', " "),
        ));
    }
    md.push_str(&format!(
        "\n环境：\n\n```json\n{}\n```\n",
        serde_json::to_string_pretty(&report["environment"]).unwrap_or_default()
    ));
    md
}

/// 写报告 zip 到 `dir`，返回 zip 的路径。
pub fn write_report(
    dir: &Path,
    plan: &Plan,
    answers: &[Answer],
    comment: &str,
    environment: Value,
) -> std::io::Result<PathBuf> {
    let report = report_json(plan, answers, comment, environment);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("kinshoko-缩小对比报告-{stamp}.zip"));
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&path)?);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let json = serde_json::to_string_pretty(&report).map_err(std::io::Error::other)?;
    for (name, text) in [("report.json", json), ("报告.md", report_markdown(&report))] {
        zip.start_file(name, opts).map_err(std::io::Error::other)?;
        zip.write_all(text.as_bytes())?;
    }
    zip.finish().map_err(std::io::Error::other)?;
    Ok(path)
}
