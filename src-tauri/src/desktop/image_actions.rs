//! 复制图片、在资源管理器中显示、从剪贴板导入（#102 T3，#105）。规则与失败情况在
//! `kinshoko_core::library`（`Library::clipboard_pixels`、`Library::reveal_original`、
//! `stage_clipboard_image`）；这里只接系统剪贴板与资源管理器。都在别的线程上做。

use image::RgbaImage;
use tauri::AppHandle;

use crate::library;

/// 暂存剪贴板图片的目录（应用数据目录下）。导入从这里读，进库的是复制。
pub(super) const CLIPBOARD_IMPORT_DIR: &str = "clipboard-import";

/// 复制图片：把参考图的原图像素放进剪贴板（PNG + DIBV5），可直接粘贴到绘画软件。
/// 经浏览视角：没有这张图、被封印、原文件不在时报错，剪贴板保持原样。
#[tauri::command]
pub async fn copy_reference_image(
    app: AppHandle,
    library_id: String,
    image_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pixels = library::visible_source(&app, &library_id, &image_id)?
            .clipboard_pixels(&image_id)
            .map_err(|e| e.to_string())?;
        let prepared = super::clipboard::PreparedImage::prepare(&pixels)?;
        // 解码期间安全模式或分级可能变了：在可见性提交里重新核对后才写剪贴板。
        library::with_visibility_commit(&app, |_| {
            library::visible_source(&app, &library_id, &image_id)?;
            prepared.commit(&app)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 在资源管理器中显示：打开原文件所在的文件夹并选中它。文件不在时报错（界面提示），不打开窗口。
#[tauri::command]
pub async fn reveal_reference_image(
    app: AppHandle,
    library_id: String,
    image_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = library::visible_source(&app, &library_id, &image_id)?
            .reveal_original(&image_id)
            .map_err(|e| e.to_string())?;
        select_in_explorer(&path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 在资源管理器中打开图库（#114）：打开图库在本设备上的文件夹。移动盘拔出、搬家等不在原处时报
/// 原因（界面提示），不打开窗口。
#[tauri::command]
pub async fn reveal_library(app: AppHandle, library_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = library::library_folder(&app, &library_id)?;
        open_in_explorer(&folder)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn open_in_explorer(folder: &std::path::Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // 与 `/select,` 相同：路径加引号原样交给 explorer，成功时也可能返回非零退出码，只看能否启动。
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("\"{}\"", folder.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法打开资源管理器：{e}"))
}

#[cfg(not(windows))]
fn open_in_explorer(folder: &std::path::Path) -> Result<(), String> {
    Err(format!("请在文件管理器中打开：{}", folder.display()))
}

#[cfg(windows)]
fn select_in_explorer(path: &std::path::Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // explorer 只认 `/select,"路径"` 这种写法；Windows 路径里不会有引号。
    // explorer.exe 成功时也返回非零退出码，只看能否启动。
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{}\"", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法打开资源管理器：{e}"))
}

#[cfg(not(windows))]
fn select_in_explorer(path: &std::path::Path) -> Result<(), String> {
    Err(format!("请在文件管理器中打开：{}", path.display()))
}

/// 剪贴板里有没有图片（空白处菜单的“从剪贴板导入”据此禁用）。只看格式，不读出图片。
#[tauri::command]
pub async fn clipboard_has_image() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(has_image)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn has_image() -> bool {
    use clipboard_win::formats::{CF_BITMAP, CF_DIB, CF_DIBV5};
    [CF_DIB, CF_DIBV5, CF_BITMAP]
        .into_iter()
        .chain(clipboard_win::register_format("PNG").map(|f| f.get()))
        .any(clipboard_win::is_format_avail)
}

#[cfg(not(windows))]
fn has_image() -> bool {
    arboard::Clipboard::new()
        .and_then(|mut c| c.get_image())
        .is_ok()
}

/// 从剪贴板导入：把剪贴板里的图片写成一个暂存的 PNG，返回它的路径，由界面交给普通导入
/// （保存位置照常选择）。剪贴板没有图片时报错。
#[tauri::command]
pub async fn stage_clipboard_import(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let image = arboard::Clipboard::new()
            .and_then(|mut c| c.get_image())
            .map_err(|_| "剪贴板里没有图片".to_owned())?;
        let image = RgbaImage::from_raw(
            image.width as u32,
            image.height as u32,
            image.bytes.into_owned(),
        )
        .ok_or("剪贴板里的图片无法识别")?;
        let dir = library::data_dir(&app).join(CLIPBOARD_IMPORT_DIR);
        kinshoko_core::library::stage_clipboard_image(&dir, &image)
            .map(|path| path.to_string_lossy().into_owned())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
