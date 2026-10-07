//! Desktop 的领域部分：截图、截图历史、新钉图的摆放（#62），钉图状态恢复与贴边隐藏（#63），钉图菜单与动画（#64）。
//!
//! 抓屏、剪贴板、窗口与全局快捷键都在应用壳里；这里只放不依赖 Tauri、可单独测试的规则：
//! - [`Screenshot`]：截取到的像素，连同截取时显示器的配置文件；
//! - [`CaptureHistory`]：最近的截图，可删除，旧截图按规则丢弃，可收藏进资料库；
//! - [`place_new_pin`]：新钉图略微偏离原位置，并避开已有钉图；
//! - [`PinStore`]：钉图的位置、裁切、缩放、翻转与旋转，重新打开后恢复；
//! - [`SavedPin::reference`]：资料库中参考图的整图与局部钉图（#65）；
//! - [`EdgeHide`]：贴边隐藏收起的位置与碰细边滑出；
//! - [`stage`]：缩放与贴边动画时窗口的矩形（#64）。

mod edge;
mod history;
mod motion;
mod pin;
mod placement;
mod screenshot;
mod types;

pub use edge::{DeskPin, EdgeHide, PEEK_SLACK, PinMove, SLIVER, Toggle, Tuck};
pub use history::{CaptureEntry, CaptureHistory, CollectedCapture, HISTORY_LIMIT, HistoryError};
pub use motion::{Stage, stage};
pub use pin::{
    MAX_SCALE, MIN_OPACITY, MIN_SCALE, MIN_SIDE, PinContent, PinError, PinStore, Placement,
    RESTORE_KEEP, SavedPin, initial_scale, pull_onto_screen,
};
pub use placement::{ScreenRect, place_new_pin};
pub use screenshot::{Region, Screenshot};
pub use types::{CaptureAction, FrozenScreen, PinFrame, PinMotion, Turn};
