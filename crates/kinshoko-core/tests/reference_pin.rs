//! 库内整图与局部钉图（#65）：从查看器钉整图或框出的局部，局部按原图像素、边界在各种变换下固定，
//! 重新打开后恢复。通过 `kinshoko_core::desktop` 的对外接口，用临时目录里的真文件。

use kinshoko_core::desktop::{
    CaptureHistory, PinContent, PinError, PinStore, Placement, Region, SavedPin, ScreenRect,
    Turn, initial_scale,
};
use kinshoko_core::library::ReferenceImage;

const MONITOR: ScreenRect = ScreenRect {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
};

fn image(width: u32, height: u32) -> ReferenceImage {
    ReferenceImage {
        id: "img-1".into(),
        width,
        height,
        sealed: false,
    }
}

fn region(x: u32, y: u32, width: u32, height: u32) -> Region {
    Region {
        x,
        y,
        width,
        height,
    }
}

fn at(x: i32, y: i32) -> Placement {
    Placement {
        x,
        y,
        ..Placement::default()
    }
}

#[test]
fn a_whole_image_pin_shows_the_whole_reference_image() {
    let pin = SavedPin::reference("p1", "lib-1", &image(800, 600), None, at(10, 20)).unwrap();
    assert_eq!(
        pin.content,
        PinContent::Reference {
            library_id: "lib-1".into(),
            image_id: "img-1".into(),
            source_width: 800,
            source_height: 600,
        }
    );
    assert_eq!(pin.crop, None);
    assert_eq!((pin.width, pin.height), (800, 600));
    assert_eq!(pin.opacity, 1.0);
    assert!(!pin.locked);
    assert_eq!(
        pin.rect(),
        ScreenRect {
            x: 10,
            y: 20,
            width: 800,
            height: 600
        }
    );
}

#[test]
fn a_partial_pin_is_sized_in_original_pixels() {
    let pin = SavedPin::reference(
        "p1",
        "lib-1",
        &image(800, 600),
        Some(region(100, 50, 300, 200)),
        at(0, 0),
    )
    .unwrap();
    assert_eq!(pin.crop, Some(region(100, 50, 300, 200)));
    assert_eq!((pin.width, pin.height), (300, 200));
    assert_eq!(pin.window_size(), (300, 200), "未缩放时一个原图像素一个物理像素");
}

#[test]
fn a_crop_covering_the_whole_image_is_kept_as_a_crop() {
    let pin = SavedPin::reference(
        "p1",
        "lib-1",
        &image(800, 600),
        Some(region(0, 0, 800, 600)),
        at(0, 0),
    )
    .unwrap();
    assert_eq!(pin.crop, Some(region(0, 0, 800, 600)));
}

#[test]
fn a_crop_must_be_non_empty_and_inside_the_image() {
    let img = image(800, 600);
    for crop in [
        region(0, 0, 0, 10),
        region(0, 0, 10, 0),
        region(700, 0, 101, 10),
        region(0, 590, 10, 11),
        region(800, 0, 1, 1),
        region(u32::MAX, 0, 2, 1),
    ] {
        assert_eq!(
            SavedPin::reference("p1", "lib-1", &img, Some(crop), at(0, 0)),
            Err(PinError::CropOutsideImage),
            "{crop:?}"
        );
    }
}

#[test]
fn the_crop_does_not_change_when_the_pin_moves_zooms_flips_or_rotates() {
    let crop = region(100, 50, 300, 200);
    let mut pin =
        SavedPin::reference("p1", "lib-1", &image(800, 600), Some(crop), at(0, 0)).unwrap();
    assert!(pin.move_to(40, 60));
    assert!(pin.zoom(2.5, (100.0, 100.0)));
    for turn in [
        Turn::FlipHorizontal,
        Turn::RotateClockwise,
        Turn::FlipVertical,
        Turn::RotateCounterClockwise,
        Turn::RotateClockwise,
    ] {
        pin.turn(turn);
    }
    assert!(pin.zoom(0.3, (10.0, 10.0)));
    assert_eq!(pin.crop, Some(crop));
    assert_eq!((pin.width, pin.height), (300, 200));
    // 旋转奇数圈时窗口宽高互换，仍是局部按缩放取整。
    assert_eq!(pin.window_size(), (60, 90));
}

#[test]
fn a_large_image_starts_at_most_sixty_percent_of_the_monitor() {
    assert_eq!(initial_scale(800, 600, MONITOR), 1.0, "放得下的不缩小");
    assert_eq!(initial_scale(3200, 1000, MONITOR), 0.36);
    assert_eq!(initial_scale(1000, 3240, MONITOR), 0.2);
}

#[test]
fn reference_pins_come_back_after_reopening_without_any_capture() {
    let dir = tempfile::tempdir().unwrap();
    let mut pin = SavedPin::reference(
        "p1",
        "lib-1",
        &image(800, 600),
        Some(region(100, 50, 300, 200)),
        at(300, 200),
    )
    .unwrap();
    pin.turn(Turn::FlipHorizontal);
    pin.set_opacity(0.5);
    pin.locked = true;
    let mut store = PinStore::open(dir.path()).unwrap();
    store.put(pin.clone());
    store.save().unwrap();
    drop(store);

    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let mut store = PinStore::open(dir.path()).unwrap();
    assert_eq!(store.restore(&mut history, &[MONITOR]), vec![pin]);
    assert!(history.entries().is_empty());
}

#[test]
fn a_reference_pin_off_every_monitor_is_pulled_back_on_restore() {
    let dir = tempfile::tempdir().unwrap();
    let pin = SavedPin::reference("p1", "lib-1", &image(200, 100), None, at(5000, 5000)).unwrap();
    let mut store = PinStore::open(dir.path()).unwrap();
    store.put(pin);
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let restored = store.restore(&mut history, &[MONITOR]);
    assert_eq!(
        (restored[0].placement.x, restored[0].placement.y),
        (1920 - 64, 1080 - 64)
    );
}
