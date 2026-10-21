//! 对账结果、导入与 Eagle 资料库定位的命令。

use super::*;

/// 当前资料库这次打开时的对账结果。
#[tauri::command]
pub(super) async fn recovery(
    state: State<'_, LibraryState>,
    library_id: String,
) -> Result<RecoveryReport, String> {
    with_libraries(&state.device_dir, &state.libraries, |device| {
        Ok(device.write(&library_id)?.recovery().clone())
    })
}

/// 开始导入，立即返回任务 id；进度与结果经 `library-event` 推送。
#[tauri::command]
pub(super) async fn start_import<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    source: ImportSource,
    options: Option<ImportOptions>,
    destination: Option<kinshoko_core::library::SaveDestination>,
) -> Result<String, String> {
    let paths = source.paths.len().min(u32::MAX as usize) as u32;
    let destination = destination.unwrap_or(kinshoko_core::library::SaveDestination {
        library_id: library_id.clone(),
        folder_id: None,
    });
    if destination.library_id != library_id {
        return Err("保存目标资料库与任务归属不一致".into());
    }
    let worker = app.clone();
    let id = blocking(move || {
        save_destination::begin(&worker, destination, source, options.unwrap_or_default())
    })
    .await?;
    crate::run_log::record(LogEvent::ImportStarted {
        library: library_no(&app, &library_id),
        paths,
    });
    Ok(id)
}

/// 来源预检只读取文件夹，所有入口在开始 Eagle 任务前使用同一个选择步骤。
#[tauri::command]
pub(super) async fn import_contains_eagle(source: ImportSource) -> Result<bool, String> {
    blocking(move || Ok(source.contains_eagle())).await
}

#[tauri::command]
pub(super) async fn cancel_import(
    state: State<'_, LibraryState>,
    library_id: String,
    task_id: String,
) -> Result<(), String> {
    let (device_dir, libraries) = (state.device_dir.clone(), state.libraries.clone());
    blocking(move || {
        with_libraries(&device_dir, &libraries, |libraries| {
            libraries.cancel_import(&library_id, &task_id)
        })
    })
    .await
}

#[tauri::command]
pub(super) async fn pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<Option<PathBuf>, String> {
    blocking(move || {
        Ok(app
            .dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok()))
    })
    .await
}

#[tauri::command]
pub(super) async fn pick_files<R: Runtime>(app: AppHandle<R>) -> Result<Vec<PathBuf>, String> {
    blocking(move || {
        Ok(app
            .dialog()
            .file()
            .add_filter("图片", &["jpg", "jpeg", "png", "webp", "gif"])
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .collect())
    })
    .await
}

/// 查找本机 Eagle 资料库；文件读取与磁盘扫描放在阻塞任务里。
#[tauri::command]
pub(super) async fn discover_eagle_libraries() -> Result<Vec<EagleLibraryCandidate>, String> {
    blocking(|| Ok(discover_eagle(&EagleDiscoveryOptions::default()))).await
}

/// 画师确认导入报告里疑似搬家的 Eagle 位置；确认后前端再导入这个位置。
#[tauri::command]
pub(super) async fn confirm_eagle_location<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    path: PathBuf,
    choice: kinshoko_core::library::EagleLocationChoice,
) -> Result<(), String> {
    let library = save_destination::fixed_library(
        &app,
        &kinshoko_core::library::SaveDestination {
            library_id,
            folder_id: None,
        },
    )?;
    blocking(move || {
        library
            .confirm_eagle_location(&path, choice)
            .map_err(|e| e.to_string())
    })
    .await
}
