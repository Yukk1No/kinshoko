//! 缩小对比探测程序（#48）的对外接口：样本、并排分组与报告。窗口只是这些接口的外壳。

use std::io::Read;

use kinshoko_downscale_probe::report::{Answer, Choice, write_report};
use kinshoko_downscale_probe::samples::{self, SampleKind};
use kinshoko_downscale_probe::{Algorithm, Plan, SCALES};

fn small_plan(seed: u64) -> Plan {
    let samples = samples::constructed();
    Plan::prepare(&samples[..2], seed, |_, _| {}).unwrap()
}

#[test]
fn constructed_line_art_is_the_same_bytes_on_every_machine() {
    let a = samples::constructed();
    let b = samples::constructed();
    assert!(a.len() >= 4);
    for (x, y) in a.iter().zip(&b) {
        assert_eq!(x.id, y.id);
        assert_eq!(x.kind, SampleKind::Constructed);
        assert_eq!(x.bytes, y.bytes, "{} 不可重复", x.id);
        let img = image::load_from_memory(&x.bytes).unwrap();
        assert!(img.width() >= 1500, "{} 太小，缩到 1/7.5 看不出细线", x.id);
    }
}

#[test]
fn public_samples_are_the_all_ages_line_art_of_the_manifest() {
    let entries = samples::public_entries();
    assert_eq!(entries.len(), 8);
    assert!(entries.iter().all(|e| e.id.starts_with("pixiv-")));
}

#[test]
fn every_sample_and_scale_is_one_group_with_both_algorithms_side_by_side() {
    let plan = small_plan(7);

    assert_eq!(plan.groups.len(), 2 * SCALES.len());
    let mut seen: Vec<(String, &str)> = plan
        .groups
        .iter()
        .map(|g| (g.sample_id.clone(), g.scale))
        .collect();
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), plan.groups.len());
    for (i, g) in plan.groups.iter().enumerate() {
        assert_eq!(g.number, i + 1);
        assert_ne!(g.left, g.right);
        assert_eq!(g.left_image.width, g.right_image.width);
        assert_ne!(g.left_image.bytes, g.right_image.bytes);
    }
}

#[test]
fn a_third_and_two_fifteenths_of_the_width() {
    let samples = samples::constructed();
    let width = image::load_from_memory(&samples[0].bytes).unwrap().width();
    let plan = Plan::prepare(&samples[..1], 1, |_, _| {}).unwrap();
    let mut widths: Vec<u32> = plan.groups.iter().map(|g| g.left_image.width).collect();
    widths.sort();
    let expect = |d: f64| (width as f64 / d).round() as u32;
    assert_eq!(widths, vec![expect(7.5), expect(3.0)]);
}

#[test]
fn order_and_sides_are_shuffled() {
    let many = Plan::prepare(&samples::constructed(), 11, |_, _| {}).unwrap();
    let left_linear = many
        .groups
        .iter()
        .filter(|g| g.left == Algorithm::LinearLight)
        .count();
    assert!(left_linear > 0 && left_linear < many.groups.len());

    let order = |p: &Plan| -> Vec<(String, &str)> {
        p.groups
            .iter()
            .map(|g| (g.sample_id.clone(), g.scale))
            .collect()
    };
    let other = Plan::prepare(&samples::constructed(), 12, |_, _| {}).unwrap();
    assert_ne!(order(&many), order(&other));
    let again = Plan::prepare(&samples::constructed(), 11, |_, _| {}).unwrap();
    assert_eq!(order(&many), order(&again));
}

fn unzip(path: &std::path::Path) -> Vec<(String, String)> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    (0..zip.len())
        .map(|i| {
            let mut f = zip.by_index(i).unwrap();
            let mut s = String::new();
            f.read_to_string(&mut s).unwrap();
            (f.name().to_string(), s)
        })
        .collect()
}

#[test]
fn the_report_records_which_algorithm_the_artist_chose() {
    let plan = small_plan(3);
    let first = &plan.groups[0];
    let answers = vec![
        Answer {
            group: 1,
            choice: Some(Choice::Left),
            comment: "左边线更实".into(),
            seconds: 4.5,
        },
        Answer {
            group: 2,
            choice: Some(Choice::Same),
            comment: String::new(),
            seconds: 2.0,
        },
    ];
    let dir = tempfile::tempdir().unwrap();

    let path = write_report(
        dir.path(),
        &plan,
        &answers,
        "整体差别不大",
        serde_json::json!({"devicePixelRatio": 1.25}),
    )
    .unwrap();

    let files = unzip(&path);
    let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, vec!["report.json", "报告.md"]);
    let json: serde_json::Value = serde_json::from_str(&files[0].1).unwrap();
    let g1 = &json["groups"][0];
    assert_eq!(g1["chosen"], first.left.key());
    assert_eq!(g1["comment"], "左边线更实");
    assert_eq!(json["groups"][1]["chosen"], "same");
    assert_eq!(json["groups"][2]["chosen"], serde_json::Value::Null);
    assert_eq!(json["comment"], "整体差别不大");
    assert_eq!(json["environment"]["devicePixelRatio"], 1.25);
    assert_eq!(json["seed"], 3);
    let tally = &json["tally"];
    assert_eq!(tally[first.left.key()], 1);
    assert_eq!(tally["same"], 1);
    assert_eq!(tally["unanswered"], plan.groups.len() - 2);
    assert!(files[1].1.contains("整体差别不大"));
}

#[test]
fn the_report_carries_no_file_names_or_pictures() {
    let plan = small_plan(5);
    let dir = tempfile::tempdir().unwrap();
    let path = write_report(dir.path(), &plan, &[], "", serde_json::json!({})).unwrap();

    let files = unzip(&path);
    for (name, text) in &files {
        assert!(name.ends_with(".json") || name.ends_with(".md"));
        for needle in [".png", ".jpg", ".webp", ":\\", "Users", "RIFF"] {
            assert!(!text.contains(needle), "{name} 含有 {needle}");
        }
        let dir_text = dir.path().display().to_string();
        assert!(!text.contains(&dir_text));
    }
}
