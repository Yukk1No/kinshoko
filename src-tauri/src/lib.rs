//! Tauri 应用壳。领域逻辑在 `kinshoko-core`，这里的命令只做转发。

mod commands;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![commands::app_info])
        .run(tauri::generate_context!())
        .expect("启动 Kinshoko 失败");
}
