//! Desktop 的领域部分：截图、截图历史、新钉图的摆放（#62），钉图状态恢复与贴边隐藏（#63），钉图菜单与动画（#64）。
//!
//! 抓屏、剪贴板、窗口与全局快捷键都在应用壳里；这里只放不依赖 Tauri、可单独测试的规则：
//! - [`Screenshot`]：截取到的像素，连同截取时显示器的配置文件；
//! - [`CaptureHistory`]：最近的截图，可删除，旧截图按规则丢弃，可收藏进资料库；
//! - [`place_new_pin`]：新钉图略微偏离原位置，并避开已有钉图；
//! - [`PinStore`]：钉图的位置、裁切、缩放、翻转与旋转，重新打开后恢复；
//! - [`SavedPin::reference`]：资料库中参考图的整图与局部钉图（#65）；
//! - [`EdgeHide`]：贴边隐藏收起的位置与碰细边滑出；
//! - [`layers_for`]、[`layer_window`]、[`widen`]、[`layer_region`]：钉图层与窗口区域的矩形（#64、#193）；
//! - [`menu_surface`]、[`PinMenu`]：钉图菜单窗口的位置与菜单状态（#106）。

mod capture;
mod edge;
mod history;
mod menu;
mod motion;
mod pin;
mod placement;
mod screenshot;
mod types;
mod veil;

pub use capture::{CaptureDraft, CaptureError, CaptureOutcome, CaptureSelection, CaptureSurface};
pub use edge::{DeskPin, EdgeHide, PEEK_SLACK, PinMove, SLIVER, Toggle};
pub use history::{
    CaptureChoice, CaptureCollection, CaptureEntry, CaptureHistory, CollectedCapture,
    CollectedCaptureDraft, HISTORY_LIMIT, HistoryError, PreparedCapture,
};
pub use menu::{MenuSurface, OpenInKinshoko, PinMenu, PinMenuOpen, menu_surface};
pub use motion::{layer_region, layer_window, layers_for, widen};
pub use pin::{
    GroupMemberRef, MAX_SCALE, MIN_OPACITY, MIN_SCALE, MIN_SIDE, PinContent, PinError, PinStore,
    Placement, RESTORE_KEEP, SavedPin, initial_scale, pull_onto_screen,
};
pub use placement::{ScreenRect, place_new_pin};
pub use screenshot::{Region, Screenshot};
pub use types::{
    CaptureAction, CaptureReference, CaptureReferenceFrame, FrozenScreen, MotionBegan, OriginalPixels,
    PinFrame, PinMotion, Turn,
};
pub use veil::PinVeils;
