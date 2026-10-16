//! 还原度管线（ADR-0005、`docs/research/image-fidelity-pipeline.md`）。
//!
//! 画师看到的像素只有两条来路：原图由 WebView2 直接解释；缩小显示由这里生成派生图。
//! 派生图按与 Chromium 相同的色彩声明规则解释（`moxcms`），在线性光 f32 下预乘 alpha 缩放
//! （`fast_image_resize`，Lanczos3），按来源分档无损保存。`image` 只负责解码与 EXIF 方向。
//! 缩小所在的空间（线性光／编码值）是管线参数，见 [`Downscale`]。

mod description;
pub mod gate;
pub(crate) mod inspect;
pub(crate) mod profiles;
pub(crate) mod render;

pub use render::{DEFAULT_DOWNSCALE, Downscale, SdrDerivative, render_sdr};

pub use description::{
    Cicp, ColourDeclaration, ColourDescription, ColourModel, HdrKind, IccKind, IccSummary,
};
