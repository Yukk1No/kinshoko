//! 还原度管线（ADR-0005、`docs/research/image-fidelity-pipeline.md`）。
//!
//! 画师看到的像素只有两条来路：原图由 WebView2 直接解释；缩小显示由这里生成派生图。
//! 派生图按与 Chromium 相同的色彩声明规则解释（`moxcms`），在线性光 f32 下预乘 alpha 缩放
//! （`fast_image_resize`，Lanczos3），按来源分档无损保存。`image` 只负责解码与 EXIF 方向。

mod description;
pub mod gate;
pub(crate) mod inspect;
pub(crate) mod profiles;
pub(crate) mod render;

pub use description::{
    Cicp, ColourDeclaration, ColourDescription, ColourModel, HdrKind, IccKind, IccSummary,
};
