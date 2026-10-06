//! Kinshoko 的领域核心。
//!
//! 领域逻辑都放在这里，不依赖 Tauri；`src-tauri` 的命令层只做转发、类型转换和事件推送。
//! 跨越前后端边界的类型带 `#[ts(export)]`，由 ts-rs 在 `cargo test` 时生成到 `src/bindings/`。

mod app_shell;
mod device;
mod device_libraries;
pub mod library;
mod settings;
mod shortcuts;

pub use app_shell::{AppInfo, app_info};
pub use device::{DeviceRegistry, RegisteredLibrary};
pub use device_libraries::{DeviceLibraries, DeviceLibraryError, LibraryRegistration};
pub use library::Library;
pub use settings::{AppSettings, SettingsError, ShortcutAction};
pub use shortcuts::{
    GlobalShortcuts, HotkeyRegistrar, ShellSettingsView, ShortcutBinding, ShortcutError,
};
