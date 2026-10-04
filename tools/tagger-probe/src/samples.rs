//! Sample images: fetched from pixiv by manifest, or found in local folders.

use crate::util::{sha256_bytes, sha256_file};
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const PIXIV_MANIFEST: &str = include_str!("../../../docs/validation/sample-manifest.pixiv.json");
const R18_MANIFEST: &str = include_str!("../../../docs/validation/sample-manifest.pixiv-r18.json");
const PIXIV_HEADERS: [(&str, &str); 2] = [("Referer", "https://www.pixiv.net/"), ("User-Agent", "Mozilla/5.0")];

#[derive(Deserialize)]
struct Manifest {
    samples: Vec<Entry>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Source {
    kind: String,
    artwork_id: Option<String>,
    page: Option<u32>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    source: Source,
    sha256: String,
    split: String,
    coverage: Vec<String>,
    #[serde(default)]
    author_tags: Vec<String>,
    rating: String,
}

pub struct Sample {
    pub id: String,
    pub split: String,
    pub rating: String,
    pub coverage: Vec<String>,
    pub author_tags: Vec<String>,
    pub path: PathBuf,
}

fn entries(include_r18: bool) -> Vec<Entry> {
    let mut all: Vec<Entry> = serde_json::from_str::<Manifest>(PIXIV_MANIFEST).expect("embedded manifest").samples;
    if include_r18 {
        all.extend(serde_json::from_str::<Manifest>(R18_MANIFEST).expect("embedded manifest").samples);
    }
    all.retain(|e| e.source.kind == "pixiv" && e.source.artwork_id.is_some());
    all
}

fn to_sample(e: Entry, path: PathBuf) -> Sample {
    Sample { id: e.id, split: e.split, rating: e.rating, coverage: e.coverage, author_tags: e.author_tags, path }
}

/// Find manifest samples in local folders (developer mode). Files must keep pixiv names.
pub fn from_dirs(dirs: &[PathBuf]) -> (Vec<Sample>, usize) {
    let mut by_prefix = std::collections::HashMap::new();
    for dir in dirs {
        for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some((art, rest)) = name.split_once('_') else { continue };
            let art = art.split('-').next().unwrap_or(art);
            let page = rest.trim_start_matches('p').split('.').next().unwrap_or("");
            by_prefix.insert(format!("{art}_p{page}"), entry.path());
        }
    }
    let mut out = Vec::new();
    let mut missing = 0;
    for e in entries(true) {
        let key = format!("{}_p{}", e.source.artwork_id.as_deref().unwrap(), e.source.page.unwrap_or(0));
        match by_prefix.get(&key) {
            Some(p) if sha256_file(p).map(|h| h == e.sha256).unwrap_or(false) => out.push(to_sample(e, p.clone())),
            _ => missing += 1,
        }
    }
    (out, missing)
}

/// Fetch the all-ages manifest samples into `dir` (target-machine mode).
pub fn fetch(dir: &Path, limit: usize) -> Result<(Vec<Sample>, usize), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let wanted: Vec<Entry> = entries(false).into_iter().take(limit).collect();
    let mut out = Vec::new();
    let mut failed = 0;
    for (i, e) in wanted.iter().enumerate() {
        let art = e.source.artwork_id.as_deref().unwrap();
        let page = e.source.page.unwrap_or(0) as usize;
        let cached = fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|d| d.path())
            .find(|p| p.file_name().map_or(false, |n| n.to_string_lossy().starts_with(&format!("{art}_p{page}."))));
        let path = match cached {
            Some(p) if sha256_file(&p).map(|h| h == e.sha256).unwrap_or(false) => p,
            _ => match fetch_one(dir, art, page, &e.sha256) {
                Ok(p) => p,
                Err(err) => {
                    failed += 1;
                    eprintln!("    跳过 {}: {err}", e.id);
                    continue;
                }
            },
        };
        out.push(to_sample(e.clone(), path));
        if (i + 1) % 20 == 0 || i + 1 == wanted.len() {
            println!("    {}/{}", i + 1, wanted.len());
        }
    }
    Ok((out, failed))
}

fn fetch_one(dir: &Path, art: &str, page: usize, sha: &str) -> Result<PathBuf, String> {
    let pages: serde_json::Value = ureq::get(&format!("https://www.pixiv.net/ajax/illust/{art}/pages"))
        .set(PIXIV_HEADERS[0].0, PIXIV_HEADERS[0].1)
        .set(PIXIV_HEADERS[1].0, PIXIV_HEADERS[1].1)
        .call()
        .map_err(|e| e.to_string())?
        .into_json()
        .map_err(|e| e.to_string())?;
    let url = pages["body"][page]["urls"]["original"].as_str().ok_or("没有原图地址")?.to_string();
    std::thread::sleep(Duration::from_millis(1200));
    let mut data = Vec::new();
    ureq::get(&url)
        .set(PIXIV_HEADERS[0].0, PIXIV_HEADERS[0].1)
        .set(PIXIV_HEADERS[1].0, PIXIV_HEADERS[1].1)
        .call()
        .map_err(|e| e.to_string())?
        .into_reader()
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(1200));
    if sha256_bytes(&data) != sha {
        return Err("哈希与清单不一致".into());
    }
    let path = dir.join(url.rsplit('/').next().unwrap());
    fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(path)
}

use std::io::Read as _;
