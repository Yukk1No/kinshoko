//! Tauri 应用壳。领域逻辑在 `kinshoko-core`，这里的命令只做转发。
//!
//! 进程常驻托盘（ADR-0004）：关闭主窗口只销毁它的 WebView，进程、托盘与全局快捷键
//! 继续运行；从托盘重新打开时按配置重建主窗口。只有托盘菜单的“退出”结束进程。

#[macro_use]
mod command_registry;

macro_rules! command_handler {
    ($($commands:tt)*) => { tauri::generate_handler![$($commands)*] };
}

mod app_notice;
mod backup;
mod blocking;
mod commands;
mod data_dirs;
mod desktop;
mod diagnostics;
mod fidelity_gate;
#[cfg(windows)]
mod file_drop;
mod library;
mod run_log;
mod shell;
mod subscription;
mod sync;
mod tagging;
mod ui_text;
mod updater;
mod window_events;

use app_notice::{AppNotice, AppNotices, publish};
use tauri::{Manager as _, RunEvent};

pub fn run() {
    shell::start_interface_language();
    // 数据根目录在建应用之前定下来：各插件的 setup 与第一个窗口都要用（#145）。
    let data = match data_dirs::prepare() {
        Ok(data) => data,
        Err(message) => {
            eprintln!("{message}");
            #[cfg(windows)]
            desktop::win32::show_error(ui_text::text(ui_text::Text::StartupFailed), &message);
            std::process::exit(1);
        }
    };
    let app = tauri::Builder::default()
        // 第二次启动（例如开机自启后又双击图标）只把已有进程的主窗口叫出来。
        // 带 `--fidelity-gate` 时改为开始还原度门槛实验。
        .plugin(tauri_plugin_single_instance::init(
            |app, args, _cwd| match fidelity_gate::options(&args) {
                Some(options) => fidelity_gate::start(app, options),
                None => shell::open_main_window(app),
            },
        ))
        .manage(data)
        .manage(fidelity_gate::GateState::default())
        .manage(AppNotices::new(vec![
            library::refresh_search_on_notice,
            desktop::on_notice,
            tagging::on_notice,
            window_events::on_notice,
            library::wake_on_notice,
            subscription::on_notice,
            backup::on_notice,
        ]))
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
            library::start_background(handle);
            updater::manage(handle);
            backup::manage(handle);
            desktop::create_tray(handle)?;
            subscription::manage(handle);
            let args: Vec<String> = std::env::args().collect();
            if let Some(options) = fidelity_gate::options(&args) {
                fidelity_gate::start(handle, options);
            } else if !args.iter().any(|arg| arg == shell::AUTOSTART_ARG) {
                shell::open_main_window(handle);
            }
            Ok(())
        })
        // 应用内浏览的 pixiv 图片（#461）：`i.pximg.net` 要带 Referer，经后端转发并缓存。
        .register_asynchronous_uri_scheme_protocol("pximg", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_owned();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(subscription::browse::image_response(&app, &path));
            });
        })
        .invoke_handler(command_registry!(app, command_handler))
        .build(tauri::generate_context!())
        .expect("启动 Kinshoko 失败");

    app.run(|app, event| match event {
        // 最后一个窗口关闭时 code 为 None：留在托盘。`app.exit(code)` 带 code，照常退出。
        RunEvent::ExitRequested { code, api, .. } => {
            if code.is_none() {
                api.prevent_exit();
            } else {
                shell::observe_main_window(app, true);
            }
        }
        RunEvent::Exit => desktop::on_exit(app),
        RunEvent::WindowEvent {
            label,
            event:
                event @ (tauri::WindowEvent::Moved(_)
                | tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::ScaleFactorChanged { .. }),
            ..
        } => {
            if label == shell::MAIN_WINDOW && matches!(event, tauri::WindowEvent::Resized(_)) {
                shell::observe_main_window(app, false);
                if app
                    .get_webview_window(shell::MAIN_WINDOW)
                    .is_some_and(|window| {
                        window.is_visible().unwrap_or(false)
                            && !window.is_minimized().unwrap_or(false)
                    })
                {
                    publish(app, AppNotice::MainWindowActivated);
                }
            }
            desktop::capture_geometry_changed(app, &label);
        }
        RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Focused(true),
            ..
        } if label == shell::MAIN_WINDOW => publish(app, AppNotice::MainWindowActivated),
        RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        } if label == shell::MAIN_WINDOW => shell::observe_main_window(app, true),
        // 关闭主窗口是画师眼里的“退出”：今天第一次时在后台自动备份（#69）。
        RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } if label == shell::MAIN_WINDOW => {
            run_log::record(kinshoko_core::diagnostics::LogEvent::WindowClosed {
                window: kinshoko_core::diagnostics::WindowKind::Main,
            });
            desktop::clear_viewer_reference(app);
            commands::resume_shortcuts(app);
            library::revoke_import_preview_context(app);
            backup::on_main_window_closed(app);
        }
        _ => {}
    });
}
