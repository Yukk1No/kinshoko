//! 浏览、编辑、永久删除与文件夹的命令。

use super::*;

#[tauri::command]
pub(super) async fn browse<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    query: BrowseQuery,
) -> Result<BrowsePage, String> {
    blocking(move || {
        readable(&app, &library_id)?
            .browse(&query)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(super) async fn image<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    image_id: String,
) -> Result<ImageDetail, String> {
    blocking(move || {
        readable(&app, &library_id)?
            .image(&image_id)
            .map_err(|e| e.to_string())
    })
    .await
}

/// 一次批量整理若干张图，返回重新计算后的详情。
#[tauri::command]
pub(super) async fn edit<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    ids: Vec<String>,
    edits: Vec<ImageEdit>,
) -> Result<Vec<ImageDetail>, String> {
    blocking(move || {
        let library = writable(&app, &library_id)?;
        with_visibility_commit(&app, |_| {
            library.edit(&ids, &edits).map_err(|e| e.to_string())
        })
    })
    .await
}

/// 永久删除的预览（#67）：回收站里这些图会影响哪些参考组，以及执行时要交回的令牌。
/// 参考组读不懂时报错，不当作没用到。
#[tauri::command]
pub(super) async fn preview_permanent_delete<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    ids: Vec<String>,
) -> Result<PermanentDeletePreview, String> {
    blocking(move || {
        let library = writable(&app, &library_id)?;
        crate::desktop::with_groups(&app, |groups| {
            library.preview_permanent_delete(&ids, groups)
        })
        .ok_or_else(|| "参考组还没有准备好".to_owned())?
        .map_err(|e| e.to_string())
    })
    .await
}

/// 清空回收站的预览（#114）：这个图库回收站里看得见的全部图、受影响的参考组与令牌；
/// 确认后走 `permanent_delete`。
#[tauri::command]
pub(super) async fn preview_empty_trash<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
) -> Result<PermanentDeletePreview, String> {
    blocking(move || {
        let library = writable(&app, &library_id)?;
        crate::desktop::with_groups(&app, |groups| library.preview_empty_trash(groups))
            .ok_or_else(|| "参考组还没有准备好".to_owned())?
            .map_err(|e| e.to_string())
    })
    .await
}

/// 按预览的令牌永久删除回收站里的图。预览之后回收站、参考组或安全模式变了时被拒绝，
/// 界面重新预览。整个执行在参考组的锁里，期间参考组不会被改。
#[tauri::command]
pub(super) async fn permanent_delete<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    ids: Vec<String>,
    token: String,
) -> Result<(), String> {
    blocking(move || {
        let library = writable(&app, &library_id)?;
        with_visibility_commit(&app, |_| {
            crate::desktop::with_groups(&app, |groups| {
                library.permanent_delete(&ids, &token, groups)
            })
            .ok_or_else(|| "参考组还没有准备好".to_owned())?
            .map_err(|e| e.to_string())
        })?;
        crate::desktop::reference_groups_changed(&app);
        Ok(())
    })
    .await
}

/// 跨图库的永久删除预览（#112）：按图库分组，逐组按需切换可写句柄再预览；某个图库核对不了
/// （断连等）时只在它那一组带上原因，其他组照常返回。
#[tauri::command]
pub(super) async fn preview_permanent_delete_batch<R: Runtime>(
    app: AppHandle<R>,
    targets: Vec<LibraryTarget>,
) -> Result<Vec<LibraryDeletePreview>, String> {
    blocking(move || {
        let previews = each_library(group_by_library(&targets), |batch| {
            let library = writable(&app, &batch.library_id)?;
            crate::desktop::with_groups(&app, |groups| {
                library.preview_permanent_delete(&batch.image_ids, groups)
            })
            .ok_or_else(|| "参考组还没有准备好".to_owned())?
            .map_err(|e| e.to_string())
        });
        Ok(previews
            .into_iter()
            .map(|(batch, result)| match result {
                Ok(preview) => LibraryDeletePreview {
                    library_id: batch.library_id,
                    preview: Some(preview),
                    error: None,
                },
                Err(error) => LibraryDeletePreview {
                    library_id: batch.library_id,
                    preview: None,
                    error: Some(error),
                },
            })
            .collect())
    })
    .await
}

/// 按各图库的预览令牌逐组永久删除（#112）：每组按需切换可写句柄（等导入收尾），一组失败不影响
/// 其他组；返回没有完成的图库与原因，全部完成时为空。
#[tauri::command]
pub(super) async fn permanent_delete_batch<R: Runtime>(
    app: AppHandle<R>,
    groups: Vec<LibraryDeleteToken>,
) -> Result<Vec<LibraryBatchFailure>, String> {
    blocking(move || {
        let results = each_library(groups, |group| {
            let library = writable(&app, &group.library_id)?;
            with_visibility_commit(&app, |_| {
                crate::desktop::with_groups(&app, |usage| {
                    library.permanent_delete(&group.image_ids, &group.token, usage)
                })
                .ok_or_else(|| "参考组还没有准备好".to_owned())?
                .map_err(|e| e.to_string())
            })
        });
        if results.iter().any(|(_, result)| result.is_ok()) {
            crate::desktop::reference_groups_changed(&app);
        }
        Ok(results
            .into_iter()
            .filter_map(|(group, result)| {
                result.err().map(|error| LibraryBatchFailure {
                    library_id: group.library_id,
                    error,
                })
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub(super) async fn sidebar<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
) -> Result<Sidebar, String> {
    blocking(move || {
        readable(&app, &library_id)?
            .sidebar()
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(super) async fn create_folder<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    name: String,
    parent: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        writable(&app, &library_id)?
            .create_folder(&name, parent.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(super) async fn rename_folder<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    folder_id: String,
    name: String,
) -> Result<(), String> {
    blocking(move || {
        writable(&app, &library_id)?
            .rename_folder(&folder_id, &name)
            .map_err(|e| e.to_string())
    })
    .await
}

/// 删除文件夹及其子文件夹（#114）：图片不删，没有其他文件夹的回到未归类。
#[tauri::command]
pub(super) async fn delete_folder<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    folder_id: String,
) -> Result<(), String> {
    blocking(move || {
        writable(&app, &library_id)?
            .delete_folder(&folder_id)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(super) async fn move_folder<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    folder_id: String,
    parent: Option<String>,
    position: u32,
) -> Result<(), String> {
    blocking(move || {
        writable(&app, &library_id)?
            .move_folder(&folder_id, parent.as_deref(), position)
            .map_err(|e| e.to_string())
    })
    .await
}
