//! Generate a real registered provider fixture using this executable's public core format.
//! Run before an application schema update to test detached old-provider availability honestly.
use image::{Rgba, RgbaImage};
use kinshoko_core::{DeviceLibraries, library::ImportSource};
use std::path::PathBuf;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("fixture output directory required")?,
    );
    std::fs::create_dir_all(&root)?;
    let app = root.join("app-data");
    let mut device = DeviceLibraries::open(&app)?;
    let file = root.join("legacy.png");
    RgbaImage::from_pixel(8, 6, Rgba([18, 28, 38, 255])).save(&file)?;
    let a = device.create(&root.join("legacy-a"), "旧格式提供方")?;
    let ai = a
        .import(ImportSource {
            paths: vec![file.clone()],
        })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .ok_or("import failed")?
        .to_owned();
    let b = device.create(&root.join("legacy-b"), "启动资料库")?;
    let bi = b.import(ImportSource { paths: vec![file] }).wait().items[0]
        .outcome
        .image_id()
        .ok_or("import failed")?
        .to_owned();
    std::fs::write(
        root.join("legacy-fixture.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "first": a.info(), "second": b.info(), "firstImage": ai, "secondImage": bi
        }))?,
    )?;
    Ok(())
}
