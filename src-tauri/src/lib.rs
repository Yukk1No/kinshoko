//! Tauri 应用壳。领域逻辑在 `kinshoko-core`，这里的命令只做转发。
//!
//! 进程常驻托盘（ADR-0004）：关闭主窗口只销毁它的 WebView，进程、托盘与全局快捷键
//! 继续运行；从托盘重新打开时按配置重建主窗口。只有托盘菜单的“退出”结束进程。

mod backup;
mod commands;
mod desktop;
mod diagnostics;
mod fidelity_gate;
mod library;
mod shell;
mod tagging;
mod updater;

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
        // 对话框插件要注册在这里：插件的 setup 运行时 Tauri 持有插件表的锁，
        // 在 setup 里再调用 `app.plugin` 会死锁，应用卡在启动阶段。
        .plugin(tauri_plugin_dialog::init())
        .plugin(updater::plugin())
        .plugin(library::init())
        .plugin(desktop::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg(shell::AUTOSTART_ARG)
                .build(),
        )
        .setup(|app| {
            let handle = app.handle();
            shell::start(handle)?;
            updater::manage(handle);
            backup::manage(handle);
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
            commands::set_show_approx_source,
            commands::set_force_srgb,
            commands::set_usage_log,
            commands::set_viewer_background,
            commands::migrate_viewer_background,
            diagnostics::diagnostics_report,
            diagnostics::runtime_status,
            diagnostics::open_runtime_update,
            diagnostics::export_diagnostics,
            diagnostics::export_usage_log,
            diagnostics::clear_usage_log,
            updater::update_status,
            updater::check_update,
            updater::install_update,
            backup::backup_status,
            backup::set_backup_target,
            backup::set_backup_selection,
            backup::backup_preview,
            backup::start_backup,
            backup::backup_snapshots,
            backup::restore_backup,
            tagging::tagging_status,
            tagging::tagging_download,
            tagging::tagging_pause,
            tagging::tagging_resume,
            tagging::tagging_models,
            tagging::tagging_set_model,
            tagging::tagging_pick_package,
            tagging::tagging_import_package,
            fidelity_gate::gate_plan,
            fidelity_gate::gate_image,
            fidelity_gate::gate_save,
        ])
        .build(tauri::generate_context!())
        .expect("启动 Kinshoko 失败");

    app.run(|app, event| match event {
        // 最后一个窗口关闭时 code 为 None：留在托盘。`app.exit(code)` 带 code，照常退出。
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        RunEvent::Exit => desktop::on_exit(app),
        RunEvent::WindowEvent {
            label,
            event:
                tauri::WindowEvent::Moved(_)
                | tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::ScaleFactorChanged { .. },
            ..
        } => desktop::capture_geometry_changed(app, &label),
        // 关闭主窗口是画师眼里的“退出”：今天第一次时在后台自动备份（#69）。
        RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } if label == shell::MAIN_WINDOW => {
            desktop::clear_viewer_reference(app);
            library::revoke_import_preview_context(app);
            backup::on_main_window_closed(app);
        }
        _ => {}
    });
}
