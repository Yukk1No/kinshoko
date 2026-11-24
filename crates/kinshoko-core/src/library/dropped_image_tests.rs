use super::stage_dropped_image;
use image::{ExtendedColorType, ImageEncoder, codecs::png::PngEncoder};

fn png() -> Vec<u8> {
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(&[10, 20, 30, 255], 1, 1, ExtendedColorType::Rgba8)
        .unwrap();
    bytes
}

#[test]
fn stages_png_with_detected_extension_and_original_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = png();
    let path = stage_dropped_image(dir.path(), "参考.jpg", &bytes).unwrap();
    assert_eq!(path.file_name().unwrap(), "参考.png");
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn rejects_non_images_empty_and_corrupt_images_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    for bytes in [b"not an image".as_slice(), b"", b"\x89PNG\r\n\x1a\n"] {
        assert!(stage_dropped_image(dir.path(), "image.png", bytes).is_err());
    }
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn reports_an_unwritable_staging_location() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("not-a-directory");
    std::fs::write(&file, b"keep").unwrap();
    assert!(stage_dropped_image(&file, "image.png", &png()).is_err());
    assert_eq!(std::fs::read(file).unwrap(), b"keep");
}

#[test]
fn sanitizes_names_and_never_overwrites_collisions() {
    let dir = tempfile::tempdir().unwrap();
    for name in [
        "../../CON.jpg",
        "..\\..\\bad:<name>?.exe",
        "",
        ".",
        "NUL.png",
        &"雪".repeat(300),
    ] {
        let first = stage_dropped_image(dir.path(), name, &png()).unwrap();
        let second = stage_dropped_image(dir.path(), name, &png()).unwrap();
        assert_ne!(first, second);
        assert_eq!(first.parent(), Some(dir.path()));
        assert_eq!(first.extension().unwrap(), "png");
        assert!(
            !first
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
        );
        assert_eq!(std::fs::read(first).unwrap(), png());
    }
}
