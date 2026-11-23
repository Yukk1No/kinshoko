use tauri::AppHandle;

/// 界面线程退出前保存钉图，在线程局部变量与后台线程仍可用时释放原生窗口。
pub fn on_exit(app: &AppHandle) {
    super::edge::flush(app);
    #[cfg(windows)]
    super::pins::shutdown();
}
