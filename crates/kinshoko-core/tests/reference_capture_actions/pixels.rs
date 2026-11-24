//! 复制出的像素：EXIF 方向、色彩声明与动图首帧，普通截图的准备与丢弃。
use super::*;

#[test]
fn copying_honors_all_original_exif_orientations_without_rewriting_originals() {
    use image::ImageEncoder;
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("library"), "方向").unwrap();
    let lens = library.take_reference_lens().unwrap();
    let detached = DetachedLenses::default();
    let registry = registered(&library);
    let references = References {
        current: Some(lens),
        registry: &registry,
        detached: &detached,
        safe_mode: true,
    };
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let colours = [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 0, 255],
    ];
    let source = RgbaImage::from_fn(40, 24, |x, y| {
        Rgba(colours[(y >= 12) as usize * 2 + (x >= 20) as usize])
    });
    // 独立 TIFF 方向表：左上、右上、左下、右下。
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
            .write_image(source.as_raw(), 40, 24, image::ExtendedColorType::Rgba8)
            .unwrap();
        let input = dir.path().join(format!("orientation-{orientation}.png"));
        std::fs::write(&input, &bytes).unwrap();
        let id = import_image(&library, input);
        let copied = copy_whole_image(&library, &id, &references, &mut history);
        let (w, h) = copied.dimensions();
        assert_eq!((w, h), if orientation < 5 { (40, 24) } else { (24, 40) });
        let observed =
            [(1, 1), (w - 2, 1), (1, h - 2), (w - 2, h - 2)].map(|(x, y)| copied.get_pixel(x, y).0);
        assert_eq!(
            observed,
            corners[orientation as usize - 1].map(|i| colours[i]),
            "EXIF {orientation}"
        );
        assert_eq!(
            std::fs::read(library.original_path(&id).unwrap()).unwrap(),
            bytes
        );
    }
    assert_eq!(history.entries().len(), 8);
}

#[test]
fn copying_respects_declared_color_and_the_sdr_animation_first_frame_route() {
    use kinshoko_core::library::DisplayRoute;
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("library"), "显示管线").unwrap();
    let lens = library.take_reference_lens().unwrap();
    let detached = DetachedLenses::default();
    let registry = registered(&library);
    let references = References {
        current: Some(lens),
        registry: &registry,
        detached: &detached,
        safe_mode: true,
    };
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let gamma = dir.path().join("linear.png");
    let mut encoder = png::Encoder::new(std::fs::File::create(&gamma).unwrap(), 40, 24);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_source_gamma(png::ScaledFloat::new(1.0));
    let mut writer = encoder.write_header().unwrap();
    writer
        .write_image_data(RgbaImage::from_pixel(40, 24, Rgba([128, 128, 128, 170])).as_raw())
        .unwrap();
    writer.finish().unwrap();
    let id = import_image(&library, gamma);
    let copied = copy_whole_image(&library, &id, &references, &mut history);
    let pixel = copied.get_pixel(0, 0).0;
    for channel in &pixel[..3] {
        assert!(
            channel.abs_diff(188) <= 1,
            "线性 128 应转换为 sRGB 188，得到 {pixel:?}"
        );
    }
    assert_eq!(pixel[3], 170);
    // APNG 默认图片为绿，实际首动画帧为红。直接解码默认图片会取错内容。
    let apng = dir.path().join("hidden-default.png");
    let mut encoder = png::Encoder::new(std::fs::File::create(&apng).unwrap(), 40, 24);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_animated(2, 0).unwrap();
    encoder.set_sep_def_img(true).unwrap();
    let mut writer = encoder.write_header().unwrap();
    writer
        .write_image_data(RgbaImage::from_pixel(40, 24, Rgba([0, 255, 0, 255])).as_raw())
        .unwrap();
    writer
        .write_image_data(RgbaImage::from_pixel(40, 24, Rgba([255, 0, 0, 255])).as_raw())
        .unwrap();
    writer
        .write_image_data(RgbaImage::from_pixel(40, 24, Rgba([0, 0, 255, 255])).as_raw())
        .unwrap();
    writer.finish().unwrap();
    let bytes = std::fs::read(&apng).unwrap();
    let id = import_image(&library, apng);
    assert_eq!(
        library.display(&id).unwrap().route,
        DisplayRoute::SdrDerivative
    );
    let copied = copy_whole_image(&library, &id, &references, &mut history);
    assert_eq!(copied.dimensions(), (40, 24));
    assert_eq!(copied.get_pixel(0, 0).0, [255, 0, 0, 255]);
    assert_eq!(
        std::fs::read(library.original_path(&id).unwrap()).unwrap(),
        bytes
    );
    assert_eq!(history.entries().len(), 2);
}

#[test]
fn ordinary_capture_preparation_can_be_discarded_without_writing_history() {
    use image::ImageDecoder;
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(dir.path()).unwrap();
    let screen = Screenshot {
        image: RgbaImage::from_fn(12, 10, |x, y| Rgba([x as u8, y as u8, 99, 120])),
        icc: Some(b"display profile retained by history".to_vec()),
    };
    let detached = DetachedLenses::default();
    let references = References {
        current: None,
        registry: &[],
        detached: &detached,
        safe_mode: true,
    };
    let veils = PinVeils::new(true);
    let selection = CaptureSelection {
        screen: &screen,
        origin: (0, 0),
        region: Region {
            x: 3,
            y: 2,
            width: 4,
            height: 3,
        },
        references: &[],
    };
    let prepared = selection
        .prepare(CaptureAction::Copy, "discard", &references, &veils)
        .unwrap();
    assert_eq!(
        prepared.clipboard_image().unwrap().get_pixel(0, 0).0,
        [3, 2, 99, 120]
    );
    assert!(history.entries().is_empty());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    drop(prepared); // Revocation discards preparation before the actual commit.
    assert!(
        CaptureHistory::open(dir.path())
            .unwrap()
            .entries()
            .is_empty()
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    let prepared = selection
        .prepare(CaptureAction::Copy, "commit", &references, &veils)
        .unwrap();
    let CaptureOutcome::CopyCapture(copied) = prepared
        .commit_with_history(|prepared| history.add_prepared(prepared))
        .unwrap()
    else {
        panic!("ordinary copy expected");
    };
    let entries = history.entries();
    assert_eq!(entries.len(), 1);
    assert_eq!((entries[0].width, entries[0].height), (4, 3));
    let mut decoder = image::ImageReader::open(history.file(&entries[0].id).unwrap())
        .unwrap()
        .with_guessed_format()
        .unwrap()
        .into_decoder()
        .unwrap();
    assert_eq!(decoder.icc_profile().unwrap(), screen.icc);
    let saved = image::DynamicImage::from_decoder(decoder)
        .unwrap()
        .to_rgba8();
    assert_eq!(saved, copied);
    assert_eq!(saved.get_pixel(3, 2).0, [6, 4, 99, 120]);
    assert_eq!(CaptureHistory::open(dir.path()).unwrap().entries(), entries);
}

/// 框选复制只裁下选区（#127）：方向转正后的选区与整图转正后再裁逐像素相同，八种 EXIF 方向都对。
#[test]
fn copying_a_part_of_an_oriented_original_gives_exactly_that_upright_region() {
    use image::ImageEncoder;
    use kinshoko_core::reference_groups::ReferenceSource;
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("library"), "方向局部").unwrap();
    let lens = library.take_reference_lens().unwrap();
    let detached = DetachedLenses::default();
    let registry = registered(&library);
    let references = References {
        current: Some(lens),
        registry: &registry,
        detached: &detached,
        safe_mode: true,
    };
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    // 每个像素都不同，裁错一格就能看出来。
    let source = RgbaImage::from_fn(40, 24, |x, y| {
        Rgba([(x * 6) as u8, (y * 10) as u8, ((x + y) * 3) as u8, 255])
    });
    let orientations = [
        image::metadata::Orientation::NoTransforms,
        image::metadata::Orientation::FlipHorizontal,
        image::metadata::Orientation::Rotate180,
        image::metadata::Orientation::FlipVertical,
        image::metadata::Orientation::Rotate90FlipH,
        image::metadata::Orientation::Rotate90,
        image::metadata::Orientation::Rotate270FlipH,
        image::metadata::Orientation::Rotate270,
    ];
    for (index, orientation) in orientations.into_iter().enumerate() {
        let exif_value = index as u16 + 1;
        assert_eq!(orientation.to_exif(), exif_value as u8);
        let mut exif = b"II*\0".to_vec();
        exif.extend(8u32.to_le_bytes());
        exif.extend(1u16.to_le_bytes());
        exif.extend(0x0112u16.to_le_bytes());
        exif.extend(3u16.to_le_bytes());
        exif.extend(1u32.to_le_bytes());
        exif.extend(exif_value.to_le_bytes());
        exif.extend([0, 0]);
        exif.extend(0u32.to_le_bytes());
        let mut bytes = Vec::new();
        let mut encoder = image::codecs::png::PngEncoder::new(&mut bytes);
        encoder.set_exif_metadata(exif).unwrap();
        encoder
            .write_image(source.as_raw(), 40, 24, image::ExtendedColorType::Rgba8)
            .unwrap();
        let input = dir.path().join(format!("part-{exif_value}.png"));
        std::fs::write(&input, &bytes).unwrap();
        let id = import_image(&library, input);
        let image = references.image(&library.info().id, &id).unwrap();
        // 1:1 显示，屏幕选区就是原图选区。
        let shown = ScreenRect {
            x: 0,
            y: 0,
            width: image.width,
            height: image.height,
        };
        let surfaces = [CaptureSurface {
            pin: SavedPin::reference(
                "viewer",
                &library.info().id,
                &image,
                None,
                Placement::default(),
            )
            .unwrap(),
            shown,
            visible: shown,
            covered: vec![],
        }];
        let screen = Screenshot {
            image: RgbaImage::from_pixel(shown.width, shown.height, Rgba([255, 0, 255, 255])),
            icc: None,
        };
        let region = Region {
            x: 5,
            y: 3,
            width: 9,
            height: 13,
        };
        let selection = CaptureSelection {
            screen: &screen,
            origin: (0, 0),
            region,
            references: &surfaces,
        };
        let CaptureOutcome::CopyReference(copied) = selection
            .finish(
                CaptureAction::Copy,
                "copy",
                &references,
                &PinVeils::new(true),
                &mut history,
            )
            .unwrap()
        else {
            panic!("应复制原图选区");
        };
        let mut upright = image::DynamicImage::ImageRgba8(source.clone());
        upright.apply_orientation(orientation);
        let expected = upright
            .crop_imm(region.x, region.y, region.width, region.height)
            .into_rgba8();
        assert_eq!(copied, expected, "EXIF {exif_value}");
    }
    assert_eq!(history.entries().len(), 8);
}
