//! 参考组包（#68）的导出与导入。

use crate::blocking::blocking;
use crate::ui_text::{Text, text};
use kinshoko_core::CommandError;
use kinshoko_core::command_error::ErrorKind;
use kinshoko_core::reference_groups::{PACKAGE_EXTENSION, ReferenceGroup};
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt as _;

use super::super::{lock, state};
use super::changed;

/// 把参考组导出成参考组包（#68）：带上所用原图与标签、备注、来源、分级的快照。`path` 为空时弹出
/// 保存对话框；取消时返回 `null`，成功时返回包的位置。有成员取不到原图时不导出并说明。
#[tauri::command]
pub async fn export_reference_group_package(
    app: AppHandle,
    group_id: String,
    path: Option<PathBuf>,
) -> Result<Option<PathBuf>, CommandError> {
    blocking(move || {
        let groups = lock(&state(&app).groups).clone();
        let group = groups.get(&group_id).map_err(CommandError::from)?;
        let Some(path) = path.or_else(|| {
            app.dialog()
                .file()
                .set_file_name(format!("{}.{PACKAGE_EXTENSION}", group.name))
                .add_filter(text(Text::FilterReferencePackage), &[PACKAGE_EXTENSION])
                .blocking_save_file()
                .and_then(|p| p.into_path().ok())
        }) else {
            return Ok(None);
        };
        crate::library::export_reference_package(&app, &groups, &group_id, &path)?;
        Ok(Some(path))
    })
    .await
}

/// 导入参考组包（#68）到明确选择的资料库和文件夹，另存为新的参考组。`path` 为空时
/// 弹出选择对话框；取消时返回 `null`。包有损坏时什么都不写。
#[tauri::command]
pub async fn import_reference_group_package(
    app: AppHandle,
    library_id: String,
    destination: Option<kinshoko_core::library::SaveDestination>,
    path: Option<PathBuf>,
) -> Result<Option<ReferenceGroup>, CommandError> {
    blocking(move || {
        let destination = destination.unwrap_or(kinshoko_core::library::SaveDestination {
            library_id: library_id.clone(),
            folder_id: None,
        });
        if destination.library_id != library_id {
            return Err(CommandError::new(
                ErrorKind::SaveTargetMismatch,
                "保存目标资料库与任务归属不一致",
            ));
        }
        let Some(path) = path.or_else(|| {
            app.dialog()
                .file()
                .add_filter(text(Text::FilterReferencePackage), &[PACKAGE_EXTENSION])
                .blocking_pick_file()
                .and_then(|p| p.into_path().ok())
        }) else {
            return Ok(None);
        };
        let groups = lock(&state(&app).groups).clone();
        let group = crate::library::with_destination(&app, &destination, |library| {
            crate::library::import_reference_package(&app, &groups, &path, library)
        })?;
        changed(&app);
        Ok(Some(group))
    })
    .await
}
