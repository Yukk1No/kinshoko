//! Synthetic native T15 fixture, exclusively public core actions and real PNG/SQLite.
use image::{Rgb, RgbImage};
use kinshoko_core::{
    Library,
    library::{ContentRating, ImageEdit, ImportSource, TagEdit, TagNamespace, TagRef},
};
use serde_json::json;
use sha2::{Digest, Sha256};
fn import(library: &Library, path: &std::path::Path) -> String {
    library
        .import(ImportSource {
            paths: vec![path.into()],
        })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .into()
}
fn main() {
    let root = std::path::PathBuf::from(std::env::args_os().nth(1).expect("fixture directory"));
    std::fs::create_dir_all(&root).unwrap();
    let sealed = root.join("sealed-duplicate.png");
    let visible = root.join("unknown-visible.png");
    let unrelated = root.join("unrelated-sealed.png");
    let new = root.join("new-unknown.png");
    for (path, seed, w, h) in [
        (&sealed, 40u8, 2400, 1800),
        (&visible, 120, 480, 320),
        (&unrelated, 200, 600, 400),
        (&new, 85, 400, 480),
    ] {
        RgbImage::from_fn(w, h, |x, y| {
            Rgb([
                seed.wrapping_add((x / 25) as u8),
                30u8.wrapping_add((y / 20) as u8),
                120,
            ])
        })
        .save(path)
        .unwrap();
    }
    let adult = Library::create(&root.join("adult"), "T15 已知成人来源").unwrap();
    let target = Library::create(&root.join("target"), "T15 未分级目标").unwrap();
    let adult_image = import(&adult, &sealed);
    let unrelated_image = import(&adult, &unrelated);
    let target_image = import(&target, &sealed);
    let visible_image = import(&target, &visible);
    target
        .edit(
            std::slice::from_ref(&target_image),
            &[ImageEdit::SetNote {
                text: "T15 原有人工备注".into(),
            }],
        )
        .unwrap();
    target
        .edit_tags(
            std::slice::from_ref(&target_image),
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: "t15-sealed-only".into(),
                    lang: "en".into(),
                },
            }],
        )
        .unwrap();
    let mut originals = serde_json::Map::new();
    for (library, ids) in [
        (&adult, vec![&adult_image, &unrelated_image]),
        (&target, vec![&target_image, &visible_image]),
    ] {
        for id in ids {
            let path = library.original_path(id).unwrap();
            originals.insert(
                path.to_string_lossy().into_owned(),
                json!(format!(
                    "{:x}",
                    Sha256::digest(std::fs::read(path).unwrap())
                )),
            );
        }
    }
    adult
        .edit(
            &[adult_image.clone(), unrelated_image.clone()],
            &[ImageEdit::SetRating {
                rating: ContentRating::Explicit,
            }],
        )
        .unwrap();
    println!(
        "{}",
        json!({"adult":adult.info(),"target":target.info(),"adultImage":adult_image,"unrelatedImage":unrelated_image,"targetImage":target_image,"visibleImage":visible_image,"sealedPath":sealed,"visiblePath":visible,"newPath":new,"originals":originals})
    );
}
