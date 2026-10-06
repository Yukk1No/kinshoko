//! 原图查看器（#47）：通过 Library 公开接口，用真库、真文件验证显示来源。

use std::path::Path;

use kinshoko_core::Library;
use kinshoko_core::library::{DisplayKind, ImportOutcome, ImportSource};

fn import(library: &Library, path: &Path) -> String {
    let report = library
        .import(ImportSource {
            paths: vec![path.to_owned()],
        })
        .wait();
    match &report.items[0].outcome {
        ImportOutcome::Imported { image_id } => image_id.clone(),
        other => panic!("未导入：{other:?}"),
    }
}

#[test]
fn static_sdr_at_original_pixels_and_above_uses_the_unchanged_original() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("参考"), "参考").unwrap();
    let input = dir.path().join("细线.png");
    image::RgbaImage::from_fn(120, 80, |x, y| image::Rgba([x as u8, y as u8, 23, 170]))
        .save(&input)
        .unwrap();
    let bytes = std::fs::read(&input).unwrap();
    let id = import(&library, &input);

    for px in [120, 132, 240, 480] {
        let display = library.display_image(&id, px).unwrap();
        assert_eq!(display.kind, DisplayKind::Original);
        assert_eq!((display.width, display.height), (120, 80));
        assert_eq!(display.path, library.original_path(&id).unwrap());
        assert_eq!(std::fs::read(display.path).unwrap(), bytes);
    }
}

#[test]
fn fitting_uses_an_exact_size_lossless_derivative_and_rebuilds_a_missing_cache() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "参考").unwrap();
    let input = dir.path().join("透明图.png");
    image::RgbaImage::from_pixel(120, 80, image::Rgba([41, 82, 123, 170]))
        .save(&input)
        .unwrap();
    let original = std::fs::read(&input).unwrap();
    let id = import(&library, &input);

    let display = library.display_image(&id, 37).unwrap();
    assert_eq!(display.kind, DisplayKind::SdrDerivative);
    assert_ne!(display.path, library.original_path(&id).unwrap());
    assert_eq!((display.width, display.height), (37, 25));
    let decoded = image::open(&display.path).unwrap().to_rgba8();
    assert_eq!(decoded.dimensions(), (37, 25));
    assert_eq!(decoded.get_pixel(18, 12).0, [41, 82, 123, 170]);

    std::fs::remove_file(&display.path).unwrap();
    let rebuilt = library.display_image(&id, 37).unwrap();
    assert_eq!(image::open(rebuilt.path).unwrap().to_rgba8(), decoded);
    assert_eq!(
        std::fs::read(library.original_path(&id).unwrap()).unwrap(),
        original
    );
}

#[test]
fn animations_use_a_still_first_frame_at_every_zoom() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "参考").unwrap();
    let first = image::RgbaImage::from_pixel(12, 8, image::Rgba([255, 0, 0, 255]));
    let second = image::RgbaImage::from_pixel(12, 8, image::Rgba([0, 0, 255, 255]));

    let gif = dir.path().join("两帧.gif");
    let mut encoder = image::codecs::gif::GifEncoder::new(std::fs::File::create(&gif).unwrap());
    encoder
        .encode_frames(
            [first.clone(), second.clone()]
                .into_iter()
                .map(image::Frame::new),
        )
        .unwrap();
    drop(encoder);

    let apng = dir.path().join("两帧.png");
    let mut encoder = png::Encoder::new(std::fs::File::create(&apng).unwrap(), 12, 8);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_animated(2, 0).unwrap();
    let mut writer = encoder.write_header().unwrap();
    writer.write_image_data(first.as_raw()).unwrap();
    writer.write_image_data(second.as_raw()).unwrap();
    writer.finish().unwrap();

    let webp = dir.path().join("两帧.webp");
    std::fs::write(&webp, animated_webp(&first, &second)).unwrap();

    for input in [gif, apng, webp] {
        let original = std::fs::read(&input).unwrap();
        let id = import(&library, &input);
        for px in [6, 12, 24, 48] {
            let display = library.display_image(&id, px).unwrap();
            assert_eq!(
                display.kind,
                DisplayKind::SdrDerivative,
                "{} at {px}",
                input.display()
            );
            let decoded = image::open(display.path).unwrap().to_rgba8();
            assert_eq!(
                decoded
                    .get_pixel(decoded.width() / 2, decoded.height() / 2)
                    .0,
                [255, 0, 0, 255]
            );
            assert_eq!(
                std::fs::read(library.original_path(&id).unwrap()).unwrap(),
                original
            );
        }
    }
}

/// 自己生成的两帧无损 WebP：第 1 帧红、第 2 帧蓝，ANMF 不混合。
fn animated_webp(first: &image::RgbaImage, second: &image::RgbaImage) -> Vec<u8> {
    use image::ImageEncoder;
    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], payload: &[u8]) {
        out.extend(kind);
        out.extend((payload.len() as u32).to_le_bytes());
        out.extend(payload);
        if payload.len() % 2 == 1 {
            out.push(0);
        }
    }
    let mut chunks = Vec::new();
    chunk(&mut chunks, b"VP8X", &[2, 0, 0, 0, 11, 0, 0, 7, 0, 0]);
    chunk(&mut chunks, b"ANIM", &[0, 0, 0, 0, 0, 0]);
    for image in [first, second] {
        let mut encoded = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut encoded)
            .write_image(image.as_raw(), 12, 8, image::ExtendedColorType::Rgba8)
            .unwrap();
        let mut frame = vec![0, 0, 0, 0, 0, 0, 11, 0, 0, 7, 0, 0, 100, 0, 0, 2];
        frame.extend(&encoded[12..]);
        chunk(&mut chunks, b"ANMF", &frame);
    }
    let mut out = b"RIFF".to_vec();
    out.extend(((chunks.len() + 4) as u32).to_le_bytes());
    out.extend(b"WEBP");
    out.extend(chunks);
    out
}

#[test]
fn hdr_marked_originals_use_sdr_derivatives_even_at_original_pixels_and_above() {
    use image::ImageEncoder;
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "参考").unwrap();
    let mut inputs = Vec::new();
    for transfer in [16, 18] {
        let path = dir.path().join(format!("hdr-{transfer}.png"));
        let mut encoder = png::Encoder::new(std::fs::File::create(&path).unwrap(), 12, 8);
        encoder.set_color(png::ColorType::Rgb);
        let mut writer = encoder.write_header().unwrap();
        writer
            .write_chunk(png::chunk::ChunkType(*b"cICP"), &[9, transfer, 0, 1])
            .unwrap();
        writer.write_image_data(&[128; 12 * 8 * 3]).unwrap();
        writer.finish().unwrap();
        inputs.push(path);
    }
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
        .write_image(&[128; 12 * 8 * 3], 12, 8, image::ExtendedColorType::Rgb8)
        .unwrap();
    let xmp = b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:hdrgm=\"http://ns.adobe.com/hdr-gain-map/1.0/\"><hdrgm:Version>1.0</hdrgm:Version></x:xmpmeta>";
    let mut marked = jpeg[..2].to_vec();
    marked.extend([0xff, 0xe1]);
    marked.extend(((xmp.len() + 2) as u16).to_be_bytes());
    marked.extend(xmp);
    marked.extend(&jpeg[2..]);
    let gain_map = dir.path().join("增益图.jpg");
    std::fs::write(&gain_map, marked).unwrap();
    inputs.push(gain_map);

    for input in inputs {
        let id = import(&library, &input);
        for px in [6, 12, 24] {
            let display = library.display_image(&id, px).unwrap();
            assert_eq!(
                display.kind,
                DisplayKind::SdrDerivative,
                "{} at {px}",
                input.display()
            );
            assert_eq!(
                (display.width, display.height),
                (px.min(12), px.min(12) * 2 / 3)
            );
            assert_eq!(
                image::guess_format(&std::fs::read(display.path).unwrap()).unwrap(),
                image::ImageFormat::WebP
            );
        }
    }
}

#[test]
fn all_eight_exif_orientations_keep_original_bytes_and_upright_derivatives() {
    use image::ImageEncoder;
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "参考").unwrap();
    let colours = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
    let source = image::RgbImage::from_fn(40, 24, |x, y| {
        image::Rgb(colours[(y >= 12) as usize * 2 + (x >= 20) as usize])
    });
    // TIFF 方向 1～8 在四角的已知排列：左上、右上、左下、右下。
    let corners = [
        [0, 1, 2, 3],
        [1, 0, 3, 2],
        [3, 2, 1, 0],
        [2, 3, 0, 1],
        [0, 2, 1, 3],
        [2, 0, 3, 1],
        [3, 1, 2, 0],
        [1, 3, 0, 2],
    ];
    for orientation in 1u16..=8 {
        let mut exif = b"II*\0".to_vec();
        exif.extend(8u32.to_le_bytes());
        exif.extend(1u16.to_le_bytes());
        exif.extend(0x0112u16.to_le_bytes());
        exif.extend(3u16.to_le_bytes());
        exif.extend(1u32.to_le_bytes());
        exif.extend(orientation.to_le_bytes());
        exif.extend([0, 0]);
        exif.extend(0u32.to_le_bytes());
        let mut bytes = Vec::new();
        let mut encoder = image::codecs::png::PngEncoder::new(&mut bytes);
        encoder.set_exif_metadata(exif).unwrap();
        encoder
            .write_image(source.as_raw(), 40, 24, image::ExtendedColorType::Rgb8)
            .unwrap();
        let input = dir.path().join(format!("方向-{orientation}.png"));
        std::fs::write(&input, &bytes).unwrap();
        let id = import(&library, &input);
        let original = library.display_image(&id, 80).unwrap();
        assert_eq!(
            (original.width, original.height),
            if orientation < 5 { (40, 24) } else { (24, 40) }
        );
        assert_eq!(std::fs::read(original.path).unwrap(), bytes);
        let display = library.display_image(&id, 20).unwrap();
        let decoded = image::open(display.path).unwrap().to_rgb8();
        let (w, h) = decoded.dimensions();
        let observed = [(1, 1), (w - 2, 1), (1, h - 2), (w - 2, h - 2)]
            .map(|(x, y)| decoded.get_pixel(x, y).0);
        assert_eq!(
            observed,
            corners[orientation as usize - 1].map(|i| colours[i]),
            "EXIF {orientation}"
        );
    }
}

#[test]
fn invalid_display_requests_have_a_domain_error() {
    use kinshoko_core::library::Error;
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "参考").unwrap();
    assert!(matches!(
        library.display_image("missing", 100),
        Err(Error::UnknownImage)
    ));
    assert!(matches!(
        library.display_image("missing", 0),
        Err(Error::InvalidDisplaySize)
    ));
}
