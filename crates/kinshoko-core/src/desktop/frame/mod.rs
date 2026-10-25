//! 原生钉图的几何（#277、ADR 0013）：纯函数，不接窗口和 GPU。平台壳、渲染层和编排都只调用它。
//!
//! 状态就是 [`SavedPin`](super::SavedPin) 与 [`Placement`](super::Placement)，这里不另存一份；
//! 坐标一律是屏幕物理像素。
//! - 摆放与绘制：以光标为中心缩放（[`ZoomAnchor`]）、拖角缩放、透明度、绘制变换（[`drawing`]）、
//!   局部在源图上的位置（[`source_rect`]）；旋转翻转沿用 [`SavedPin::turn`](super::SavedPin::turn)；
//! - 输入：命中（[`hit`]）、按住开菜单（[`held_for_menu`]）；
//! - 动画：缩放、贴边滑动、出现提示的动画曲线，按时间求值；
//! - 上屏：每一帧怎么上屏（[`Step`]）、窗口（[`window_for`]）与包络（[`envelope`]）。
//!
//! 贴边隐藏（[`EdgeHide`](super::EdgeHide)）、[`pull_onto_screen`](super::pull_onto_screen)、
//! [`overlay_window`](super::overlay_window) 沿用。

mod anim;
mod input;
mod plan;
mod view;

#[cfg(test)]
mod test_rng;

pub use anim::{APPEAR_MS, ContentMotion, RectF, SLIDE_MS, ZOOM_MS, appear_ring, ease_out_cubic};
pub use input::{
    HOLD_MS, HOLD_SLOP, Hit, Monitor, PointerButton, PointerKind, ZOOM_CORNER, ZOOM_CORNER_SHARE,
    held_for_menu, hit, press_opens_menu, scale_at,
};
pub use plan::{Step, envelope, plan, uncover, window_for};
pub use view::{
    Drawing, SourceSize, VEILED_SOURCE_PX, ZoomAnchor, ZoomStart, corner_zoom_scale, drawing,
    source_rect, source_size, wheel_opacity, wheel_zoom_scale,
};
