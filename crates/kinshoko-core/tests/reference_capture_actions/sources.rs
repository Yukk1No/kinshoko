//! 来源的遮蔽、失效、遮挡，以及多个库都有这张图时读哪一张。
use super::*;

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
    let registry = registered(&library);
    let references = References {
        current: Some(lens),
        registry: &registry,
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
    assert_eq!(
        history.entries().len(),
        1,
        "只有读到原图的那次复制进截图历史"
    );
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
    let registry = registered(&library);
    let mut references = References {
        // Registry withdrawal must revoke even an active reference retained in memory.
        current: Some(lens.clone()),
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
    references.registry = &registry;
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
    assert_eq!(history.entries().len(), 1);
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
