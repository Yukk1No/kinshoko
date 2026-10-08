//! F1 落在参考图上时，按原图像素保存来源与局部，包含已裁切、翻转和旋转的钉图。
use kinshoko_core::desktop::{Placement, Region, SavedPin, ScreenRect};
use kinshoko_core::library::ReferenceImage;

#[test]
fn a_screen_selection_maps_back_to_the_original_reference_pixels() {
    let mut pin = SavedPin::reference(
        "pin",
        "library",
        &ReferenceImage {
            id: "image".into(),
            width: 1000,
            height: 800,
            sealed: false,
        },
        Some(Region {
            x: 100,
            y: 200,
            width: 400,
            height: 200,
        }),
        Placement::default(),
    )
    .unwrap();
    let shown = ScreenRect {
        x: 10,
        y: 20,
        width: 800,
        height: 400,
    };
    assert_eq!(
        pin.reference_region(
            shown,
            ScreenRect {
                x: 210,
                y: 120,
                width: 200,
                height: 200
            }
        ),
        Some(Region {
            x: 200,
            y: 250,
            width: 100,
            height: 100
        })
    );
    assert_eq!(
        pin.reference_region(
            shown,
            ScreenRect {
                x: 0,
                y: 0,
                width: 200,
                height: 200
            }
        ),
        None
    );
    pin.placement.rotation = 1;
    pin.placement.flip_h = true;
    assert_eq!(
        pin.reference_region(
            ScreenRect {
                x: 0,
                y: 0,
                width: 400,
                height: 800
            },
            ScreenRect {
                x: 0,
                y: 0,
                width: 100,
                height: 200
            }
        ),
        Some(Region {
            x: 400,
            y: 350,
            width: 100,
            height: 50
        })
    );
}
