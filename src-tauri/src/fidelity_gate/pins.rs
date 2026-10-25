//! 门槛实验的“钉图离屏渲染 vs 正式派生图”（#282）：每个样本应用 1:1 显示的文件在钉图渲染层上
//! 画出、经查找表到主显示器，与 moxcms 把同一文件直接转到这台显示器的结果比较。

use kinshoko_core::desktop::pin_colour::{self, PinLut};
use kinshoko_core::fidelity::gate::{GateItem, GateRun};
use kinshoko_core::fidelity::pin_gate::{PinGate, PinGateItem};
use pin_render::{Draw, LutData, Pixels, Rect, Renderer, Window};

/// 主显示器：名称（报告用）与它的 ICC（读不到为 `None`，按 sRGB）。
pub struct MainDisplay {
    pub name: String,
    pub icc: Option<Vec<u8>>,
}

/// 渲染层起不来、查找表建不成时整项记为出错；单个样本出错只记在那一项上。
pub fn run(run: &GateRun, display: &MainDisplay) -> PinGate {
    let icc = display.icc.as_deref();
    let mut gate = PinGate {
        display: format!(
            "{}（{}）",
            display.name,
            if icc.is_some() {
                "显示器 ICC"
            } else {
                "没有 ICC，按 sRGB"
            }
        ),
        ..PinGate::default()
    };
    let renderer = match Renderer::new() {
        Ok(r) => r,
        Err(e) => {
            gate.error = Some(format!("钉图渲染层起不来：{e}"));
            return gate;
        }
    };
    gate.adapter = renderer.describe();
    let lut = pin_colour::lut(None, icc).and_then(|lut| {
        match &lut {
            PinLut::Identity => renderer.lut(LutData::Identity),
            PinLut::Table {
                clut,
                curve,
                linear,
            } => renderer.lut(LutData::Table {
                clut,
                curve,
                linear: *linear,
            }),
        }
        .map_err(|e| e.to_string())
    });
    let lut = match lut {
        Ok(lut) => lut,
        Err(e) => {
            gate.error = Some(format!("查找表：{e}"));
            return gate;
        }
    };
    gate.items = run
        .items
        .iter()
        .map(|item| {
            compare(run, item, &renderer, &lut, icc)
                .unwrap_or_else(|e| PinGateItem::failed(&item.sample, e))
        })
        .collect();
    gate
}

fn compare(
    run: &GateRun,
    item: &GateItem,
    renderer: &Renderer,
    lut: &pin_render::Lut,
    icc: Option<&[u8]>,
) -> Result<PinGateItem, String> {
    let path = run
        .library
        .display(&item.image_id)
        .map_err(|e| e.to_string())?
        .path;
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let pixels = pin_colour::derivative(&bytes)?;
    let reference = pin_colour::display_reference(&bytes, icc)?;
    let (w, h) = (pixels.width, pixels.height);
    let image = renderer
        .upload(Pixels {
            width: w,
            height: h,
            rgba: &pixels.rgba,
        })
        .map_err(|e| e.to_string())?;
    let rect = Rect::new(0.0, 0.0, w as f32, h as f32);
    let window = Window {
        x: 0,
        y: 0,
        width: w,
        height: h,
    };
    let out = renderer
        .render_offscreen(&image, &Draw::new(window, rect, rect), lut)
        .map_err(|e| e.to_string())?;
    let rendered = image::RgbaImage::from_raw(w, h, out.data).ok_or("读回尺寸不符")?;
    PinGateItem::compare(&item.sample, icc, &rendered, &reference)
}
