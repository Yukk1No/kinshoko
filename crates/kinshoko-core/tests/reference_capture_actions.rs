//! F1 的公开完成动作：真实原图、资料库、截图历史。
use image::{Rgba, RgbaImage};
use kinshoko_core::Library;
use kinshoko_core::desktop::{
    CaptureAction, CaptureHistory, CaptureOutcome, CaptureSelection, CaptureSurface, PinContent,
    PinVeils, Placement, Region, SavedPin, ScreenRect, Screenshot,
};
use kinshoko_core::library::{ImportOutcome, ImportSource};
use kinshoko_core::reference_groups::{DetachedLenses, References};

#[test]
fn copying_a_downscaled_reference_keeps_original_pixels_and_pinning_keeps_its_source() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("library"), "原图裁切").unwrap();
    let input = dir.path().join("detail.png");
    RgbaImage::from_fn(2400, 1600, |x, y| {
        Rgba([
            x as u8,
            y as u8,
            (x % 2 * 255) as u8,
            if y % 2 == 0 { 0 } else { 170 },
        ])
    })
    .save(&input)
    .unwrap();
    let original = std::fs::read(&input).unwrap();
    let report = library.import(ImportSource { paths: vec![input] }).wait();
    let ImportOutcome::Imported { image_id } = &report.items[0].outcome else {
        panic!("导入失败：{:?}", report.items[0].outcome);
    };
    let lens = library.take_reference_lens().unwrap();
    let pin = SavedPin::reference(
        "viewer",
        &library.info().id,
        &lens.image(image_id).unwrap(),
        None,
        Placement::default(),
    )
    .unwrap();
    let surface = CaptureSurface {
        pin,
        shown: ScreenRect {
            x: 100,
            y: 50,
            width: 600,
            height: 400,
        },
        visible: ScreenRect {
            x: 100,
            y: 50,
            width: 600,
            height: 400,
        },
        covered: vec![],
    };
    // 冻结屏幕故意全是紫色。被测动作必须从已导入的高分辨率原图取内容。
    let screen = Screenshot {
        image: RgbaImage::from_pixel(800, 600, Rgba([255, 0, 255, 255])),
        icc: None,
    };
    let surfaces = [surface];
    let selection = CaptureSelection {
        screen: &screen,
        origin: (0, 0),
        region: Region {
            x: 150,
            y: 75,
            width: 30,
            height: 20,
        },
        references: &surfaces,
    };
    let detached = DetachedLenses::default();
    let references = References {
        current: Some(lens),
        registry: &[],
        detached: &detached,
        safe_mode: true,
    };
    let veils = PinVeils::new(true);
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let CaptureOutcome::CopyReference(copied) = selection
        .finish(
            CaptureAction::Copy,
            "copy",
            &references,
            &veils,
            &mut history,
        )
        .unwrap()
    else {
        panic!("应得到复制内容");
    };
    assert_eq!(
        copied.dimensions(),
        (120, 80),
        "复制尺寸必须是原图选区，而非 30×20 的屏幕区域"
    );
    assert_eq!(copied.get_pixel(0, 0).0, [200, 100, 0, 0]);
    assert_eq!(copied.get_pixel(1, 1).0, [201, 101, 255, 170]);
    assert_eq!(copied.get_pixel(119, 79).0, [63, 179, 255, 170]);
    let CaptureOutcome::PinReference(pinned) = selection
        .finish(
            CaptureAction::Pin,
            "new-pin",
            &references,
            &veils,
            &mut history,
        )
        .unwrap()
    else {
        panic!("应得到参考视图");
    };
    assert_eq!(
        pinned.content,
        PinContent::Reference {
            library_id: library.info().id.clone(),
            image_id: image_id.clone(),
            source_width: 2400,
            source_height: 1600
        }
    );
    assert_eq!(
        pinned.crop,
        Some(Region {
            x: 200,
            y: 100,
            width: 120,
            height: 80
        })
    );
    assert_eq!((pinned.width, pinned.height), (120, 80));
    assert!(history.entries().is_empty(), "库内复制与钉住都不写截图历史");
    assert!(
        CaptureHistory::open(&dir.path().join("captures"))
            .unwrap()
            .entries()
            .is_empty()
    );
    assert_eq!(
        std::fs::read(library.original_path(image_id).unwrap()).unwrap(),
        original
    );
}

#[test]
fn selecting_a_transformed_prior_crop_copies_the_same_original_region_as_the_new_pin() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("library"), "已有局部").unwrap();
    let input = dir.path().join("detail.png");
    RgbaImage::from_fn(2400, 1600, |x, y| {
        Rgba([
            x as u8,
            y as u8,
            (x % 2 * 255) as u8,
            if y % 2 == 0 { 0 } else { 170 },
        ])
    })
    .save(&input)
    .unwrap();
    let report = library.import(ImportSource { paths: vec![input] }).wait();
    let ImportOutcome::Imported { image_id } = &report.items[0].outcome else {
        panic!("导入失败");
    };
    let lens = library.take_reference_lens().unwrap();
    let placement = Placement {
        x: -300,
        y: -200,
        scale: 0.5,
        flip_h: true,
        rotation: 1,
        ..Placement::default()
    };
    let pin = SavedPin::reference(
        "prior-pin",
        &library.info().id,
        &lens.image(image_id).unwrap(),
        Some(Region {
            x: 100,
            y: 200,
            width: 400,
            height: 200,
        }),
        placement,
    )
    .unwrap();
    let shown = ScreenRect {
        x: -300,
        y: -200,
        width: 101,
        height: 199,
    };
    let surfaces = [CaptureSurface {
        pin,
        shown,
        visible: shown,
        covered: vec![],
    }];
    let screen = Screenshot {
        image: RgbaImage::from_pixel(800, 600, Rgba([255, 0, 255, 255])),
        icc: None,
    };
    let selection = CaptureSelection {
        screen: &screen,
        origin: (-400, -300),
        region: Region {
            x: 101,
            y: 103,
            width: 25,
            height: 51,
        },
        references: &surfaces,
    };
    let detached = DetachedLenses::default();
    let references = References {
        current: Some(lens),
        registry: &[],
        detached: &detached,
        safe_mode: true,
    };
    let veils = PinVeils::new(true);
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let CaptureOutcome::CopyReference(copied) = selection
        .finish(
            CaptureAction::Copy,
            "copy",
            &references,
            &veils,
            &mut history,
        )
        .unwrap()
    else {
        panic!("应得到原图复制内容");
    };
    // worked example: 撤销 90° 与水平翻转，原图边界向外取整为 [391,494) × [348,399)。
    assert_eq!(
        copied.dimensions(),
        (51, 103),
        "复制保留原图精度与屏幕所见方向"
    );
    assert_eq!(copied.get_pixel(0, 0).0, [237, 142, 255, 0]);
    assert_eq!(copied.get_pixel(50, 0).0, [237, 92, 255, 0]);
    assert_eq!(copied.get_pixel(0, 102).0, [135, 142, 255, 0]);
    assert_eq!(copied.get_pixel(1, 1).0, [236, 141, 0, 170]);
    let CaptureOutcome::PinReference(pinned) = selection
        .finish(
            CaptureAction::Pin,
            "next-pin",
            &references,
            &veils,
            &mut history,
        )
        .unwrap()
    else {
        panic!("应得到参考视图");
    };
    assert_eq!(pinned.content, surfaces[0].pin.content);
    assert_eq!(
        pinned.crop,
        Some(Region {
            x: 391,
            y: 348,
            width: 103,
            height: 51
        })
    );
    assert_eq!(pinned.placement, placement);
    assert!(history.entries().is_empty());
}

fn import_image(library: &Library, input: std::path::PathBuf) -> String {
    match &library
        .import(ImportSource { paths: vec![input] })
        .wait()
        .items[0]
        .outcome
    {
        ImportOutcome::Imported { image_id } => image_id.clone(),
        other => panic!("导入失败：{other:?}"),
    }
}

#[test]
fn a_reference_resealed_after_freezing_is_not_read_and_an_explicitly_revealed_pin_remains_usable() {
    use kinshoko_core::desktop::CaptureError;
    use kinshoko_core::library::{ContentRating, ImageEdit};
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("library"), "封印").unwrap();
    let input = dir.path().join("visible.png");
    RgbaImage::from_pixel(64, 32, Rgba([20, 40, 60, 170]))
        .save(&input)
        .unwrap();
    let image_id = import_image(&library, input);
    let lens = library.take_reference_lens().unwrap();
    let pin = SavedPin::reference(
        "visible-pin",
        &library.info().id,
        &lens.image(&image_id).unwrap(),
        None,
        Placement::default(),
    )
    .unwrap();
    let shown = ScreenRect {
        x: 0,
        y: 0,
        width: 32,
        height: 16,
    };
    let surfaces = [CaptureSurface {
        pin,
        shown,
        visible: shown,
        covered: vec![],
    }];
    let screen = Screenshot {
        image: RgbaImage::from_pixel(64, 32, Rgba([255, 0, 255, 255])),
        icc: None,
    };
    let selection = CaptureSelection {
        screen: &screen,
        origin: (0, 0),
        region: Region {
            x: 4,
            y: 4,
            width: 8,
            height: 8,
        },
        references: &surfaces,
    };
    let detached = DetachedLenses::default();
    let references = References {
        current: Some(lens),
        registry: &[],
        detached: &detached,
        safe_mode: true,
    };
    let mut veils = PinVeils::new(true);
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    // 冻结之后分级发生变化。必须重新核对，不能复制旧冻结帧或隐藏原图。
    library
        .edit(
            &[image_id],
            &[ImageEdit::SetRating {
                rating: ContentRating::Explicit,
            }],
        )
        .unwrap();
    for action in [CaptureAction::Pin, CaptureAction::Copy] {
        assert!(matches!(
            selection.finish(action, "new", &references, &veils, &mut history),
            Err(CaptureError::Sealed)
        ));
    }
    veils.reveal("visible-pin");
    let CaptureOutcome::CopyReference(copied) = selection
        .finish(
            CaptureAction::Copy,
            "copy",
            &references,
            &veils,
            &mut history,
        )
        .unwrap()
    else {
        panic!("已确认显示的钉图可复制");
    };
    assert_eq!(copied.dimensions(), (16, 16));
    assert_eq!(copied.get_pixel(0, 0).0, [20, 40, 60, 170]);
    veils.set_safe_mode(false);
    veils.set_safe_mode(true);
    assert!(matches!(
        selection.finish(
            CaptureAction::Copy,
            "copy",
            &references,
            &veils,
            &mut history
        ),
        Err(CaptureError::Sealed)
    ));
    assert!(history.entries().is_empty());
}

#[test]
fn missing_or_changed_reference_sources_cannot_fall_back_to_old_pixels() {
    use kinshoko_core::desktop::CaptureError;
    use kinshoko_core::reference_groups::UnavailableReason;
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("library"), "来源").unwrap();
    let input = dir.path().join("original.png");
    RgbaImage::from_pixel(64, 32, Rgba([20, 40, 60, 170]))
        .save(&input)
        .unwrap();
    let image_id = import_image(&library, input);
    let lens = library.take_reference_lens().unwrap();
    let pin = SavedPin::reference(
        "viewer",
        &library.info().id,
        &lens.image(&image_id).unwrap(),
        None,
        Placement::default(),
    )
    .unwrap();
    let shown = ScreenRect {
        x: 0,
        y: 0,
        width: 32,
        height: 16,
    };
    let mut surfaces = [CaptureSurface {
        pin,
        shown,
        visible: shown,
        covered: vec![],
    }];
    let screen = Screenshot {
        image: RgbaImage::from_pixel(64, 32, Rgba([255, 0, 255, 255])),
        icc: None,
    };
    let detached = DetachedLenses::default();
    let mut references = References {
        current: None,
        registry: &[],
        detached: &detached,
        safe_mode: true,
    };
    let veils = PinVeils::new(true);
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let region = Region {
        x: 4,
        y: 4,
        width: 8,
        height: 8,
    };
    for action in [CaptureAction::Pin, CaptureAction::Copy] {
        let selection = CaptureSelection {
            screen: &screen,
            origin: (0, 0),
            region,
            references: &surfaces,
        };
        assert!(matches!(
            selection.finish(action, "new", &references, &veils, &mut history),
            Err(CaptureError::SourceUnavailable(
                UnavailableReason::LibraryNotRegistered
            ))
        ));
    }
    references.current = Some(lens);
    if let PinContent::Reference { source_width, .. } = &mut surfaces[0].pin.content {
        *source_width = 999;
    }
    let selection = CaptureSelection {
        screen: &screen,
        origin: (0, 0),
        region,
        references: &surfaces,
    };
    assert!(matches!(
        selection.finish(
            CaptureAction::Copy,
            "new",
            &references,
            &veils,
            &mut history
        ),
        Err(CaptureError::SourceChanged)
    ));
    if let PinContent::Reference { source_width, .. } = &mut surfaces[0].pin.content {
        *source_width = 64;
    }
    std::fs::remove_file(library.original_path(&image_id).unwrap()).unwrap();
    let selection = CaptureSelection {
        screen: &screen,
        origin: (0, 0),
        region,
        references: &surfaces,
    };
    for action in [CaptureAction::Pin, CaptureAction::Copy] {
        assert!(matches!(
            selection.finish(action, "new", &references, &veils, &mut history),
            Err(CaptureError::SourceUnavailable(
                UnavailableReason::OriginalMissing
            ))
        ));
    }
    assert!(history.entries().is_empty());
}

#[test]
fn occluded_clipped_cross_boundary_and_external_selections_keep_the_screen_capture_path() {
    let dir = tempfile::tempdir().unwrap();
    let pin = SavedPin::reference(
        "viewer",
        "unavailable-library",
        &kinshoko_core::library::ReferenceImage {
            id: "missing".into(),
            width: 1000,
            height: 1000,
            sealed: false,
        },
        None,
        Placement::default(),
    )
    .unwrap();
    let shown = ScreenRect {
        x: 0,
        y: 0,
        width: 50,
        height: 50,
    };
    let mut surface = CaptureSurface {
        pin,
        shown,
        visible: shown,
        covered: vec![],
    };
    let screen = Screenshot {
        image: RgbaImage::from_fn(100, 100, |x, y| Rgba([x as u8, y as u8, 123, 170])),
        icc: None,
    };
    let detached = DetachedLenses::default();
    let references = References {
        current: None,
        registry: &[],
        detached: &detached,
        safe_mode: true,
    };
    let veils = PinVeils::new(true);
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    for (case, region) in [
        (
            "occluded",
            Region {
                x: 10,
                y: 10,
                width: 20,
                height: 20,
            },
        ),
        (
            "clipped",
            Region {
                x: 10,
                y: 10,
                width: 20,
                height: 20,
            },
        ),
        (
            "cross-boundary",
            Region {
                x: 40,
                y: 40,
                width: 20,
                height: 20,
            },
        ),
        (
            "external",
            Region {
                x: 60,
                y: 60,
                width: 20,
                height: 20,
            },
        ),
    ] {
        surface.covered = if case == "occluded" {
            vec![ScreenRect {
                x: 15,
                y: 15,
                width: 1,
                height: 1,
            }]
        } else {
            vec![]
        };
        surface.visible = if case == "clipped" {
            ScreenRect { width: 20, ..shown }
        } else {
            shown
        };
        let surfaces = [surface.clone()];
        let selection = CaptureSelection {
            screen: &screen,
            origin: (0, 0),
            region,
            references: &surfaces,
        };
        let CaptureOutcome::CopyCapture(copied) = selection
            .finish(
                CaptureAction::Copy,
                "copy",
                &references,
                &veils,
                &mut history,
            )
            .unwrap()
        else {
            panic!("{case} 应走屏幕截图");
        };
        assert_eq!(copied.dimensions(), (20, 20));
        assert_eq!(
            copied.get_pixel(0, 0).0,
            [region.x as u8, region.y as u8, 123, 170]
        );
        let CaptureOutcome::PinCapture(entry) = selection
            .finish(CaptureAction::Pin, "pin", &references, &veils, &mut history)
            .unwrap()
        else {
            panic!("{case} 应钉截图");
        };
        assert_eq!((entry.width, entry.height), (20, 20));
        assert_eq!(
            image::open(history.file(&entry.id).unwrap())
                .unwrap()
                .to_rgba8(),
            copied
        );
    }
    assert_eq!(history.entries().len(), 8);
    assert_eq!(
        CaptureHistory::open(&dir.path().join("captures"))
            .unwrap()
            .entries()
            .len(),
        8
    );
}

fn copy_whole_image(
    library: &Library,
    image_id: &str,
    references: &References<'_>,
    history: &mut CaptureHistory,
) -> RgbaImage {
    use kinshoko_core::reference_groups::ReferenceSource;
    let image = references.image(&library.info().id, image_id).unwrap();
    let shown = ScreenRect {
        x: 0,
        y: 0,
        width: image.width / 4,
        height: image.height / 4,
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
    let selection = CaptureSelection {
        screen: &screen,
        origin: (0, 0),
        region: Region {
            x: 0,
            y: 0,
            width: shown.width,
            height: shown.height,
        },
        references: &surfaces,
    };
    let CaptureOutcome::CopyReference(copied) = selection
        .finish(
            CaptureAction::Copy,
            "copy",
            references,
            &PinVeils::new(true),
            history,
        )
        .unwrap()
    else {
        panic!("应复制原尺寸参考图");
    };
    copied
}

#[test]
fn copying_uses_the_explicit_inactive_library_even_when_another_library_is_current() {
    use kinshoko_core::DeviceRegistry;
    let dir = tempfile::tempdir().unwrap();
    let original = Library::create(&dir.path().join("original"), "来源库").unwrap();
    let current = Library::create(&dir.path().join("current"), "当前库").unwrap();
    let input = dir.path().join("original.png");
    RgbaImage::from_pixel(64, 32, Rgba([20, 40, 60, 170]))
        .save(&input)
        .unwrap();
    let id = import_image(&original, input);
    let current_input = dir.path().join("current.png");
    RgbaImage::from_pixel(64, 32, Rgba([200, 100, 50, 255]))
        .save(&current_input)
        .unwrap();
    import_image(&current, current_input);
    let mut registry = DeviceRegistry::open(&dir.path().join("device")).unwrap();
    registry.register(original.info()).unwrap();
    registry.register(current.info()).unwrap();
    let detached = DetachedLenses::default();
    let references = References {
        current: current.take_reference_lens(),
        registry: registry.libraries(),
        detached: &detached,
        safe_mode: true,
    };
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let copied = copy_whole_image(&original, &id, &references, &mut history);
    assert_eq!(copied.dimensions(), (64, 32));
    assert_eq!(copied.get_pixel(0, 0).0, [20, 40, 60, 170]);
    assert!(history.entries().is_empty());
}

#[test]
fn copying_honors_all_original_exif_orientations_without_rewriting_originals() {
    use image::ImageEncoder;
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("library"), "方向").unwrap();
    let lens = library.take_reference_lens().unwrap();
    let detached = DetachedLenses::default();
    let references = References {
        current: Some(lens),
        registry: &[],
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
    assert!(history.entries().is_empty());
}

#[test]
fn copying_respects_declared_color_and_the_sdr_animation_first_frame_route() {
    use kinshoko_core::library::DisplayRoute;
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("library"), "显示管线").unwrap();
    let lens = library.take_reference_lens().unwrap();
    let detached = DetachedLenses::default();
    let references = References {
        current: Some(lens),
        registry: &[],
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
    assert!(history.entries().is_empty());
}

#[test]
fn an_ambiguous_visible_source_is_a_screen_capture_instead_of_choosing_one_library() {
    use kinshoko_core::DeviceRegistry;
    let dir = tempfile::tempdir().unwrap();
    let first = Library::create(&dir.path().join("first"), "第一库").unwrap();
    let second = Library::create(&dir.path().join("second"), "第二库").unwrap();
    let first_input = dir.path().join("first.png");
    let second_input = dir.path().join("second.png");
    RgbaImage::from_pixel(64, 64, Rgba([10, 20, 30, 255]))
        .save(&first_input)
        .unwrap();
    RgbaImage::from_pixel(64, 64, Rgba([40, 50, 60, 255]))
        .save(&second_input)
        .unwrap();
    let first_id = import_image(&first, first_input);
    let second_id = import_image(&second, second_input);
    let first_lens = first.take_reference_lens().unwrap();
    let second_lens = second.take_reference_lens().unwrap();
    let shown = ScreenRect {
        x: 0,
        y: 0,
        width: 32,
        height: 32,
    };
    let surfaces = [
        CaptureSurface {
            pin: SavedPin::reference(
                "first",
                &first.info().id,
                &first_lens.image(&first_id).unwrap(),
                None,
                Placement::default(),
            )
            .unwrap(),
            shown,
            visible: shown,
            covered: vec![],
        },
        CaptureSurface {
            pin: SavedPin::reference(
                "second",
                &second.info().id,
                &second_lens.image(&second_id).unwrap(),
                None,
                Placement::default(),
            )
            .unwrap(),
            shown,
            visible: shown,
            covered: vec![],
        },
    ];
    let mut registry = DeviceRegistry::open(&dir.path().join("device")).unwrap();
    registry.register(second.info()).unwrap();
    let detached = DetachedLenses::default();
    let references = References {
        current: Some(first_lens),
        registry: registry.libraries(),
        detached: &detached,
        safe_mode: true,
    };
    let screen = Screenshot {
        image: RgbaImage::from_pixel(64, 64, Rgba([255, 0, 255, 255])),
        icc: None,
    };
    let selection = CaptureSelection {
        screen: &screen,
        origin: (0, 0),
        region: Region {
            x: 8,
            y: 8,
            width: 8,
            height: 8,
        },
        references: &surfaces,
    };
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let CaptureOutcome::CopyCapture(copied) = selection
        .finish(
            CaptureAction::Copy,
            "copy",
            &references,
            &PinVeils::new(true),
            &mut history,
        )
        .unwrap()
    else {
        panic!("只有唯一可见来源才能读取原图；不能按登记顺序选择第一库");
    };
    assert_eq!(copied.dimensions(), (8, 8));
    assert_eq!(copied.get_pixel(0, 0).0, [255, 0, 255, 255]);
    assert_eq!(history.entries().len(), 1);
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
    let CaptureOutcome::CopyCapture(copied) = prepared.commit(&mut history).unwrap() else {
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
