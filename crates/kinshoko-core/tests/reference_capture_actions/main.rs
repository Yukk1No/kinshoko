//! F1 的公开完成动作：真实原图、资料库、截图历史。
//!
//! - `regions`：原图选区、钉住后的来源，以及进截图历史的原始像素（#227）。
//! - `sources`：来源的遮蔽、失效、遮挡与多库时选哪张原图。
//! - `pixels`：复制出的像素：方向、色彩声明，以及普通截图的准备与丢弃。

mod pixels;
mod regions;
mod sources;
use image::{Rgba, RgbaImage};
use kinshoko_core::Library;
use kinshoko_core::desktop::{
    CaptureAction, CaptureHistory, CaptureOutcome, CaptureSelection, CaptureSurface, PinContent,
    PinVeils, Placement, Region, SavedPin, ScreenRect, Screenshot,
};
use kinshoko_core::library::{ImportOutcome, ImportSource};
use kinshoko_core::reference_groups::{DetachedLenses, References};

fn registered(library: &Library) -> [kinshoko_core::RegisteredLibrary; 1] {
    [kinshoko_core::RegisteredLibrary {
        id: library.info().id.clone(),
        name: library.info().name.clone(),
        root: library.info().root.clone(),
    }]
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
