//! 前端可调用的 Tauri 命令。每个命令只转发到 `kinshoko_core`，不放领域逻辑。

use kinshoko_core::AppInfo;

#[tauri::command]
pub fn app_info() -> AppInfo {
    kinshoko_core::app_info()
}
