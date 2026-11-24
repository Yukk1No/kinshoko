//! Shared fixtures for the `portable_tags` integration tests.

#![allow(dead_code)]

use image::{Rgba, RgbaImage};
use kinshoko_core::Library;
use kinshoko_core::library::{ImportSource, TagEdit, TagNamespace, TagRef};
use std::path::Path;

pub fn named_library(dir: &Path, name: &str) -> (Library, String, String) {
    let library = Library::create(&dir.join(name), name).unwrap();
    let png = dir.join(format!("{name}.png"));
    RgbaImage::from_pixel(12, 10, Rgba([20, 40, 60, 255]))
        .save(&png)
        .unwrap();
    let report = library.import(ImportSource { paths: vec![png] }).wait();
    let image = report.items[0].outcome.image_id().unwrap().to_owned();
    library
        .edit_tags(
            std::slice::from_ref(&image),
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: "白".into(),
                    lang: "zh-CN".into(),
                },
            }],
        )
        .unwrap();
    let tag = library.vocabulary().unwrap().tags[0].id.clone();
    (library, image, tag)
}

pub fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}
