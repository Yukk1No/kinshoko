//! F1 框选读数（#103）：选区得到参考视图时读原始像素，其余情况读屏幕像素。
use image::{Rgba, RgbaImage};
use kinshoko_core::desktop::{
    CaptureSelection, CaptureSurface, OriginalPixels, Placement, Region, SavedPin, ScreenRect,
    Screenshot,
};
use kinshoko_core::library::ReferenceImage;

fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
    ScreenRect {
        x,
        y,
        width,
        height,
    }
}

/// 2400×1600 的原图在屏幕 (100, 50) 处缩小显示为 600×400：一个屏幕像素是 4 个原始像素。
fn surface(id: &str, shown: ScreenRect, placement: Placement) -> CaptureSurface {
    let image = ReferenceImage {
        id: id.into(),
        width: 2400,
        height: 1600,
        sealed: false,
    };
    CaptureSurface {
        pin: SavedPin::reference(id, "library", &image, None, placement).unwrap(),
        shown,
        visible: shown,
        covered: vec![],
    }
}

fn readout(
    surfaces: &[CaptureSurface],
    origin: (i32, i32),
    region: Region,
) -> Option<OriginalPixels> {
    let screen = Screenshot {
        image: RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 255])),
        icc: None,
    };
    CaptureSelection {
        screen: &screen,
        origin,
        region,
        references: surfaces,
    }
    .original_pixels()
}

const INSIDE: Region = Region {
    x: 150,
    y: 75,
    width: 30,
    height: 20,
};

#[test]
fn a_selection_inside_one_reference_reads_the_original_region_size() {
    let surfaces = [surface("a", rect(100, 50, 600, 400), Placement::default())];
    assert_eq!(
        readout(&surfaces, (0, 0), INSIDE),
        Some(OriginalPixels {
            width: 120,
            height: 80
        })
    );
    // 选区相对显示器；位于左侧显示器（负坐标）时同样成立。
    assert_eq!(
        readout(
            &[surface(
                "a",
                rect(-1820, 50, 600, 400),
                Placement::default()
            )],
            (-1920, 0),
            INSIDE
        ),
        Some(OriginalPixels {
            width: 120,
            height: 80
        })
    );
}

#[test]
fn a_quarter_turned_pin_reads_the_size_of_the_result_as_shown() {
    let turned = Placement {
        rotation: 1,
        ..Placement::default()
    };
    // 转了一圈四分之一的钉图在屏幕上为 400×600。
    let surfaces = [surface("a", rect(100, 50, 400, 600), turned)];
    assert_eq!(
        readout(&surfaces, (0, 0), INSIDE),
        Some(OriginalPixels {
            width: 120,
            height: 80
        })
    );
}

#[test]
fn crossing_covered_ambiguous_or_outside_selections_read_screen_pixels() {
    let base = surface("a", rect(100, 50, 600, 400), Placement::default());
    let crossing = Region {
        x: 690,
        y: 75,
        width: 30,
        height: 20,
    };
    assert_eq!(readout(std::slice::from_ref(&base), (0, 0), crossing), None);
    let outside = Region {
        x: 0,
        y: 0,
        width: 30,
        height: 20,
    };
    assert_eq!(readout(std::slice::from_ref(&base), (0, 0), outside), None);
    let covered = CaptureSurface {
        covered: vec![rect(160, 80, 1, 1)],
        ..base.clone()
    };
    assert_eq!(readout(&[covered], (0, 0), INSIDE), None);
    // 两张图叠在同一处：不能由登记顺序决定读哪张原图。
    let twin = surface("b", rect(100, 50, 600, 400), Placement::default());
    assert_eq!(readout(&[base, twin], (0, 0), INSIDE), None);
    assert_eq!(readout(&[], (0, 0), INSIDE), None);
}
