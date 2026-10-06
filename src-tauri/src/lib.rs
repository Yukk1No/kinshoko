//! Tauri 应用壳。领域逻辑在 `kinshoko-core`，这里的命令只做转发。
//!
//! 进程常驻托盘（ADR-0004）：关闭主窗口只销毁它的 WebView，进程、托盘与全局快捷键
//! 继续运行；从托盘重新打开时按配置重建主窗口。只有托盘菜单的“退出”结束进程。

mod commands;
mod desktop;
mod library;
mod shell;
mod tagging;

use tauri::RunEvent;

pub fn run() {
    let app = tauri::Builder::default()
        // 第二次启动（例如开机自启后又双击图标）只把已有进程的主窗口叫出来。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            shell::open_main_window(app);
        }))
        // 依赖插件在 Builder 登记；插件 setup 内再次登记会重复等待 Tauri 的插件锁。
        .plugin(tauri_plugin_dialog::init())
        .plugin(library::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg(shell::AUTOSTART_ARG)
                .build(),
        )
        .setup(|app| {
            let handle = app.handle();
            shell::start(handle)?;
            desktop::create_tray(handle)?;
            if !std::env::args().any(|arg| arg == shell::AUTOSTART_ARG) {
                shell::open_main_window(handle);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::shell_settings,
            commands::set_autostart,
            commands::rebind_shortcut,
            tagging::tagging_status,
            tagging::tagging_download,
            tagging::tagging_pause,
            tagging::tagging_resume,
        ])
        .build(tauri::generate_context!())
        .expect("启动 Kinshoko 失败");

    app.run(|_app, event| {
        // 最后一个窗口关闭时 code 为 None：留在托盘。`app.exit(code)` 带 code，照常退出。
        if let RunEvent::ExitRequested {
            code: None, api, ..
        } = event
        {
            api.prevent_exit();
        }
    });
}
