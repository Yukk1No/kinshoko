//! 原图选区与钉住后的来源；原始像素进截图历史（#227）。
use super::*;

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
    let registry = registered(&library);
    let references = References {
        current: Some(lens),
        registry: &registry,
        detached: &detached,
        safe_mode: true,
    };
    let veils = PinVeils::new(true);
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let CaptureOutcome::CopyReference(copied) = selection
        .prepare(CaptureAction::Copy, "copy", &references, &veils)
        .unwrap()
        .commit_with_history(|prepared| history.add_prepared(prepared))
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
        .prepare(CaptureAction::Pin, "new-pin", &references, &veils)
        .unwrap()
        .commit_with_history(|prepared| history.add_prepared(prepared))
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
    // #227：库内复制与钉住都把原始像素存进截图历史。
    assert_eq!(history.entries().len(), 2);
    assert_eq!(
        CaptureHistory::open(&dir.path().join("captures"))
            .unwrap()
            .entries(),
        history.entries()
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
    let registry = registered(&library);
    let references = References {
        current: Some(lens),
        registry: &registry,
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
    assert_eq!(history.entries().len(), 2, "复制与钉住各存一张原始像素截图");
}

/// #227：框到参考图上得到的原始像素也进截图历史，存的是复制得到的那块原始像素。
#[test]
fn copying_or_pinning_a_reference_selection_keeps_its_original_pixels_in_capture_history() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("library"), "原图进历史").unwrap();
    let input = dir.path().join("detail.png");
    RgbaImage::from_fn(2400, 1600, |x, y| {
        Rgba([x as u8, y as u8, (x / 256) as u8, 255])
    })
    .save(&input)
    .unwrap();
    let image_id = import_image(&library, input);
    let lens = library.take_reference_lens().unwrap();
    let shown = ScreenRect {
        x: 100,
        y: 50,
        width: 600,
        height: 400,
    };
    let surfaces = [CaptureSurface {
        pin: SavedPin::reference(
            "viewer",
            &library.info().id,
            &lens.image(&image_id).unwrap(),
            None,
            Placement::default(),
        )
        .unwrap(),
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
    let registry = registered(&library);
    let references = References {
        current: Some(lens),
        registry: &registry,
        detached: &detached,
        safe_mode: true,
    };
    let veils = PinVeils::new(true);
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let saved = |history: &CaptureHistory, id: &str| {
        image::open(history.file(id).unwrap()).unwrap().to_rgba8()
    };

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
    let entries = history.entries();
    assert_eq!(entries.len(), 1);
    // 原图选区 (200,100) 起 120×80，而不是 30×20 的屏幕区域。
    assert_eq!((entries[0].width, entries[0].height), (120, 80));
    assert_eq!(saved(&history, &entries[0].id), copied);
    assert_eq!(copied.get_pixel(0, 0).0, [200, 100, 0, 255]);

    let CaptureOutcome::PinReference(pinned) = selection
        .finish(CaptureAction::Pin, "pin", &references, &veils, &mut history)
        .unwrap()
    else {
        panic!("钉住仍得到参考视图");
    };
    assert_eq!(pinned.crop.map(|c| (c.width, c.height)), Some((120, 80)));
    let entries = history.entries();
    assert_eq!(entries.len(), 2);
    assert_eq!((entries[0].width, entries[0].height), (120, 80));
    assert_eq!(saved(&history, &entries[0].id), copied);
    assert_eq!(
        CaptureHistory::open(&dir.path().join("captures"))
            .unwrap()
            .entries(),
        entries
    );
}
