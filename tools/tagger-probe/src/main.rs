//! Kinshoko tagger probe.
//!
//! Double-click to run on the target machine: it downloads the pinned models and the
//! public all-ages pixiv samples, runs PixAI and WD on DirectML and CPU, checks that
//! both providers agree, and writes a report zip to the desktop. The report contains
//! hardware names, timings and predictions for public sample IDs only; no personal
//! files or paths.
//!
//! Developer options:
//!   --samples-dir <dir>   use local sample folders instead of downloading (repeatable;
//!                         also picks up the R-18 manifest)
//!   --limit <n>           use at most n samples
//!   --skip-cpu / --skip-gpu
//!   --data-dir <dir>      where models, samples and runs are kept
//!   --no-prompt           never wait for keyboard input

mod bench;
mod models;
mod preprocess;
mod report;
mod samples;
mod sysinfo;
mod util;

use bench::Ep;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

struct Args {
    sample_dirs: Vec<PathBuf>,
    limit: usize,
    skip_cpu: bool,
    skip_gpu: bool,
    all_models: bool,
    data_dir: PathBuf,
    prompt: bool,
}

fn parse_args() -> Result<Args, String> {
    let default_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Kinshoko")
        .join("probe");
    let mut a = Args { sample_dirs: vec![], limit: usize::MAX, skip_cpu: false, skip_gpu: false, all_models: false, data_dir: default_data, prompt: true };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--samples-dir" => a.sample_dirs.push(it.next().ok_or("--samples-dir 需要路径")?.into()),
            "--limit" => a.limit = it.next().and_then(|v| v.parse().ok()).ok_or("--limit 需要数字")?,
            "--skip-cpu" => a.skip_cpu = true,
            "--skip-gpu" => a.skip_gpu = true,
            "--all-models" => a.all_models = true,
            "--data-dir" => a.data_dir = it.next().ok_or("--data-dir 需要路径")?.into(),
            "--no-prompt" => a.prompt = false,
            other => return Err(format!("未知参数 {other}")),
        }
    }
    Ok(a)
}

fn wait_enter(prompt: &str) -> String {
    print!("{prompt}");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    line.trim().to_string()
}

fn desktop() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("USERPROFILE")?);
    [home.join("Desktop"), home.join("OneDrive").join("Desktop"), home.join("OneDrive").join("桌面")]
        .into_iter()
        .find(|p| p.is_dir())
}

fn main() {
    sysinfo::utf8_console();
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    let code = match run(&args) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("\n出错了：{e}\n请把这段文字截图发给开发者。");
            1
        }
    };
    if args.prompt {
        wait_enter("\n按回车键关闭窗口…");
    }
    std::process::exit(code);
}

fn run(args: &Args) -> Result<(), String> {
    println!("Kinshoko 打标探测 v{}\n", env!("CARGO_PKG_VERSION"));
    let dev_mode = !args.sample_dirs.is_empty();
    if args.prompt {
        println!("这个程序会测试自动打标模型在这台电脑上的速度和结果：");
        println!("  1. 下载 PixAI v1.0 模型（约 3 GB）和 pixiv 上的公开样本图（约 0.8 GB，已下载过的直接复用）；");
        println!("  2. 分别用显卡和 CPU 给样本打标，可能需要几十分钟；");
        println!("  3. 在桌面生成一个报告压缩包，请把它发给开发者。");
        println!("报告只包含硬件型号、耗时和公开样本的打标结果，不会读取你自己的文件。");
        println!("\n测试期间可以打开优动漫随便画几笔，结束时会问你是否卡顿。");
        wait_enter("\n准备好后按回车开始…");
    }

    let run_id = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let run_dir = args.data_dir.join("runs").join(run_id.to_string());
    std::fs::create_dir_all(&run_dir).map_err(|e| e.to_string())?;

    println!("\n[1/4] 读取硬件信息");
    let hardware = sysinfo::hardware();
    println!("  CPU：{}", hardware.cpu);
    for a in &hardware.adapters {
        println!("  显卡：{}", a.name);
    }

    println!("\n[2/4] 准备模型");
    let models: Vec<_> = models::MODELS
        .iter()
        .filter(|spec| spec.default || args.all_models)
        .map(|spec| models::ensure(spec, &args.data_dir.join("models")))
        .collect::<Result<_, _>>()?;

    println!("\n[3/4] 准备样本");
    let (mut samples, missing) = if dev_mode {
        samples::from_dirs(&args.sample_dirs)
    } else {
        samples::fetch(&args.data_dir.join("samples"), args.limit)?
    };
    samples.truncate(args.limit);
    println!("  可用样本 {} 张，缺失或校验失败 {} 张", samples.len(), missing);
    if samples.is_empty() {
        return Err("没有可用的样本".into());
    }

    println!("\n[4/4] 打标测试");
    let predictions = run_dir.join("predictions.jsonl");
    let mut runs = Vec::new();
    let mut agreements = Vec::new();
    let mut notes = Vec::new();
    let mut first_predictions = true;
    // Scores per (model key, provider) for cross-variant comparison.
    let mut all_scores: Vec<(&str, Ep, Vec<Option<Vec<f32>>>)> = Vec::new();
    for model in &models {
        let mut gpu = None;
        let mut cpu = None;
        for ep in [Ep::DirectMl, Ep::Cpu] {
            if (ep == Ep::Cpu && args.skip_cpu) || (ep == Ep::DirectMl && args.skip_gpu) {
                continue;
            }
            let n = match ep {
                Ep::DirectMl => model.spec.directml,
                Ep::Cpu => model.spec.cpu,
            }
            .take(samples.len());
            if n == 0 {
                continue;
            }
            println!("  {} · {}（{} 张）", model.spec.label, ep.label(), n);
            let r = bench::run(model, ep, &samples[..n], &run_dir);
            if let Some(err) = &r.report.error {
                println!("    {err}");
            }
            if ep == Ep::DirectMl && !r.report.heavy_non_dml_ops.is_empty() {
                let ops = r.report.heavy_non_dml_ops.iter().map(|(k, v)| format!("{k}×{v}")).collect::<Vec<_>>().join("、");
                notes.push(format!("{}：DirectML 运行时有计算密集算子回落 CPU：{ops}。", model.spec.key));
            }
            runs.push(r.report);
            match ep {
                Ep::DirectMl => gpu = Some(r.scores),
                Ep::Cpu => cpu = Some(r.scores),
            }
        }
        if let (Some(c), Some(g)) = (&cpu, &gpu) {
            agreements.push(report::agreement(model, "CPU vs DirectML", c, g));
        }
        // Predictions from the provider that covered more samples, CPU on ties.
        let count = |v: &Option<Vec<Option<Vec<f32>>>>| v.as_ref().map_or(0, |s| s.iter().filter(|x| x.is_some()).count());
        let (provider, scores) = match (&cpu, &gpu) {
            (Some(_), Some(g)) if count(&gpu) > count(&cpu) => ("directml", g),
            (Some(c), _) => ("cpu", c),
            (None, Some(g)) => ("directml", g),
            _ => continue,
        };
        report::write_predictions(&predictions, model, provider, &samples, scores, !first_predictions).map_err(|e| e.to_string())?;
        first_predictions = false;
        if let Some(g) = gpu {
            all_scores.push((model.spec.key, Ep::DirectMl, g));
        }
        if let Some(c) = cpu {
            all_scores.push((model.spec.key, Ep::Cpu, c));
        }
    }
    // PixAI v1.0: FP16 on the GPU against the FP32 reference on the CPU.
    let find = |key: &str, ep: Ep| all_scores.iter().find(|(k, e, _)| *k == key && *e == ep).map(|(_, _, s)| s);
    if let (Some(fp16), Some(fp32), Some(model)) = (
        find("pixai-v1.0-fp16", Ep::DirectMl),
        find("pixai-v1.0-fp32", Ep::Cpu),
        models.iter().find(|m| m.spec.key == "pixai-v1.0-fp32"),
    ) {
        agreements.push(report::agreement(model, "FP32 CPU vs FP16 DirectML", fp32, fp16));
    }

    let drawing_app_answer = args.prompt.then(|| {
        let a = wait_enter("\n测试期间你有没有用优动漫画画？输入数字后回车：1 没开  2 不卡  3 有点卡  4 很卡  > ");
        match a.as_str() {
            "1" => "没开".to_string(),
            "2" => "不卡".to_string(),
            "3" => "有点卡".to_string(),
            "4" => "很卡".to_string(),
            other => format!("未选择（输入：{other}）"),
        }
    });

    let report = report::Report {
        probe_version: env!("CARGO_PKG_VERSION"),
        created_unix: run_id,
        mode: if dev_mode { "developer (local samples)" } else { "target (downloaded samples)" },
        hardware: &hardware,
        samples_used: samples.len(),
        samples_missing: missing,
        runs: &runs,
        agreement: &agreements,
        drawing_app_answer,
        notes,
    };
    let json_path = run_dir.join("report.json");
    let md_path = run_dir.join("report.md");
    std::fs::write(&json_path, serde_json::to_string_pretty(&report).unwrap()).map_err(|e| e.to_string())?;
    let md = report::markdown(&report);
    std::fs::write(&md_path, &md).map_err(|e| e.to_string())?;

    let zip_name = format!("kinshoko-probe-{run_id}.zip");
    // Only the interactive (target-machine) run writes to the desktop.
    let zip_dir = if args.prompt { desktop().unwrap_or_else(|| run_dir.clone()) } else { run_dir.clone() };
    let zip_path = zip_dir.join(zip_name);
    report::bundle(&zip_path, &[md_path, json_path, predictions]).map_err(|e| e.to_string())?;
    println!("\n{md}");
    println!("报告已保存：{}", zip_path.display());
    println!("请把这个压缩包发给开发者。");
    if args.prompt {
        let _ = std::process::Command::new("explorer").arg(format!("/select,{}", zip_path.display())).spawn();
    }
    Ok(())
}
