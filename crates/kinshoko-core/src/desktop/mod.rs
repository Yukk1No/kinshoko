//! Desktop 的领域部分：截图、截图历史与新钉图的摆放（#62）。
//!
//! 抓屏、剪贴板、窗口与全局快捷键都在应用壳里；这里只放不依赖 Tauri、可单独测试的规则：
//! - [`Screenshot`]：截取到的像素，连同截取时显示器的配置文件；
//! - [`CaptureHistory`]：最近的截图，可删除，旧截图按规则丢弃，可收藏进资料库；
//! - [`place_new_pin`]：新钉图略微偏离原位置，并避开已有钉图。

mod history;
mod placement;
mod screenshot;
mod types;

pub use history::{CaptureEntry, CaptureHistory, CollectedCapture, HISTORY_LIMIT, HistoryError};
pub use placement::{ScreenRect, place_new_pin};
pub use screenshot::{Region, Screenshot};
pub use types::{CaptureAction, FrozenScreen, PinInfo};
