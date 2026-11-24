//! 建库、造图与导入的共用帮手。各测试文件用
//! `#[path = "support/library.rs"] mod support_library;` 引入。

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use image::{Rgba, RgbaImage};
use kinshoko_core::Library;
use kinshoko_core::library::{ImportReport, ImportSource};

/// 在 `path` 写一张 `w`×`h` 的 PNG，像素随 `seed` 变化，返回 `path`。
pub fn write_png(path: &Path, w: u32, h: u32, seed: u8) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    RgbaImage::from_fn(w, h, |x, y| Rgba([seed, x as u8, y as u8, 255]))
        .save(path)
        .unwrap();
    path.to_path_buf()
}

/// 导入一张图，返回它的图片 id。
pub fn import_one(library: &Library, path: &Path) -> String {
    import_all(library, &[path.to_path_buf()]).items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned()
}

/// 导入若干张图，返回导入报告。
pub fn import_all(library: &Library, paths: &[PathBuf]) -> ImportReport {
    library
        .import(ImportSource {
            paths: paths.to_vec(),
        })
        .wait()
}

/// 按种子在 `dir/in/` 下各造一张 4×4 的图并导入，按种子顺序返回图片 id。
pub fn import_seeded(
    library: &Library,
    dir: &Path,
    seeds: impl IntoIterator<Item = u8>,
) -> Vec<String> {
    let paths: Vec<_> = seeds
        .into_iter()
        .map(|i| write_png(&dir.join(format!("in/{i}.png")), 4, 4, i))
        .collect();
    import_all(library, &paths)
        .items
        .into_iter()
        .map(|item| item.outcome.image_id().unwrap().to_owned())
        .collect()
}
