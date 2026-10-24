//! Shared fixtures for the `backup_content_definitions` integration tests.

#![allow(dead_code)]

use image::{Rgba, RgbaImage};
use kinshoko_core::backup::Stamp;
use kinshoko_core::desktop::{Placement, Region, SavedPin};
use kinshoko_core::library::{ImportSource, TagEdit, TagNamespace, TagRef};
use kinshoko_core::{Library, RegisteredLibrary};
use std::path::Path;

pub fn at(hour: i64) -> Stamp {
    Stamp::new(1_791_158_400_000 + hour * 3_600_000, 480)
}

pub fn tagged(root: &Path, name: &str, seed: u8) -> (Library, String, String) {
    let library = Library::create(&root.join(name), name).unwrap();
    let input = root.join(format!("{name}.png"));
    RgbaImage::from_fn(24, 16, |x, y| Rgba([seed, x as u8, y as u8, 255]))
        .save(&input)
        .unwrap();
    let report = library.import(ImportSource { paths: vec![input] }).wait();
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
    let local = library.vocabulary().unwrap().tags[0].id.clone();
    (library, image, local)
}

pub fn registration(library: &Library) -> RegisteredLibrary {
    RegisteredLibrary {
        id: library.info().id.clone(),
        name: library.info().name.clone(),
        root: library.info().root.clone(),
    }
}

pub fn pin(library: &Library, image: &str, name: &str) -> SavedPin {
    SavedPin::reference(
        name,
        &library.info().id,
        &kinshoko_core::library::ReferenceImage {
            id: image.into(),
            width: 24,
            height: 16,
            sealed: false,
        },
        Some(Region {
            x: 2,
            y: 3,
            width: 8,
            height: 6,
        }),
        Placement {
            x: 123,
            y: 234,
            scale: 1.75,
            flip_h: true,
            flip_v: false,
            rotation: 1,
        },
    )
    .unwrap()
}
