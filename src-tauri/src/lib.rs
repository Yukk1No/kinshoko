//! Tauri 应用壳。领域逻辑在 `kinshoko-core`，这里的命令只做转发。
//!
//! 进程常驻托盘（ADR-0004）：关闭主窗口只销毁它的 WebView，进程、托盘与全局快捷键
//! 继续运行；从托盘重新打开时按配置重建主窗口。只有托盘菜单的“退出”结束进程。

mod commands;
mod desktop;
mod fidelity_gate;
mod library;
mod shell;

use tauri::RunEvent;

pub fn run() {
    let app = tauri::Builder::default()
        // 第二次启动（例如开机自启后又双击图标）只把已有进程的主窗口叫出来。
        // 带 `--fidelity-gate` 时改为开始还原度门槛实验。
        .plugin(tauri_plugin_single_instance::init(
            |app, args, _cwd| match fidelity_gate::options(&args) {
                Some(options) => fidelity_gate::start(app, options),
                None => shell::open_main_window(app),
            },
        ))
        .manage(fidelity_gate::GateState::default())
        // 对话框插件必须在这里注册：在资料库插件的 setup 里 `app.plugin(...)` 会再次锁住
        // Tauri 正在初始化插件时持有的插件表，启动时死锁。
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
            let args: Vec<String> = std::env::args().collect();
            if let Some(options) = fidelity_gate::options(&args) {
                fidelity_gate::start(handle, options);
            } else if !args.iter().any(|arg| arg == shell::AUTOSTART_ARG) {
                shell::open_main_window(handle);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::shell_settings,
            commands::set_autostart,
            commands::rebind_shortcut,
            fidelity_gate::gate_plan,
            fidelity_gate::gate_image,
            fidelity_gate::gate_save,
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
