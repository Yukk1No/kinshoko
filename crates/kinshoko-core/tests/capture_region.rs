//! 框选截图：选区按物理像素从冻结的屏幕上裁下（#62）。

use image::RgbaImage;
use kinshoko_core::desktop::{Region, Screenshot};

fn screen() -> Screenshot {
    Screenshot {
        image: RgbaImage::from_fn(100, 60, |x, y| image::Rgba([x as u8, y as u8, 7, 255])),
        icc: Some(b"display".to_vec()),
    }
}

#[test]
fn the_selected_region_keeps_the_exact_screen_pixels_and_profile() {
    let region = Region {
        x: 10,
        y: 5,
        width: 3,
        height: 2,
    };

    let cut = screen().crop(region).unwrap();

    assert_eq!((cut.image.width(), cut.image.height()), (3, 2));
    assert_eq!(cut.image.get_pixel(0, 0).0, [10, 5, 7, 255]);
    assert_eq!(cut.image.get_pixel(2, 1).0, [12, 6, 7, 255]);
    assert_eq!(cut.icc.as_deref(), Some(&b"display"[..]));
}

#[test]
fn a_region_reaching_past_the_screen_edge_is_clamped() {
    let cut = screen()
        .crop(Region {
            x: 95,
            y: 50,
            width: 20,
            height: 20,
        })
        .unwrap();

    assert_eq!((cut.image.width(), cut.image.height()), (5, 10));
    assert_eq!(cut.image.get_pixel(4, 9).0, [99, 59, 7, 255]);
}

#[test]
fn an_empty_region_or_one_outside_the_screen_gives_nothing() {
    let empty = Region {
        x: 10,
        y: 10,
        width: 0,
        height: 4,
    };
    let outside = Region {
        x: 100,
        y: 0,
        width: 4,
        height: 4,
    };
    assert_eq!(screen().crop(empty), None);
    assert_eq!(screen().crop(outside), None);
}
