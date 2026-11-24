// release 构建不弹出控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 打标子进程（ADR-0004）：同一个 exe 以子命令启动，不经过 Tauri 与单实例检查。
    if std::env::args().nth(1).as_deref() == Some(kinshoko_tagger::SUBCOMMAND) {
        std::process::exit(kinshoko_tagger::run_worker());
    }
    kinshoko_app::run();
}
