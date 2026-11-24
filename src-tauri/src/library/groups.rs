//! Thin adapter for application groups. No active library is required or mutated.

use super::*;
use kinshoko_core::CommandError;
use kinshoko_core::tag_catalog::{CatalogGroupEdit, CatalogGroupView, DeletedCatalogGroup};

#[tauri::command]
pub(super) async fn shared_tag_groups<R: Runtime>(
    app: AppHandle<R>,
    lang: String,
    safe_mode: bool,
) -> Result<Vec<CatalogGroupView>, CommandError> {
    blocking(move || {
        with_lens(
            &app,
            safe_mode,
            Hold::Stable,
            |workspace, device, catalog| {
                workspace.shared_tag_groups(device, catalog, &lang, safe_mode)
            },
        )
    })
    .await
}

#[tauri::command]
pub(super) async fn create_shared_tag_group<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    namespace: Option<TagNamespace>,
) -> Result<String, CommandError> {
    blocking(move || {
        let safe = saved_safe_mode(&app);
        with_lens(&app, safe, Hold::Read, |workspace, device, catalog| {
            // Existing source groups enroll before a new group is appended.
            workspace.status(device, catalog, safe)?;
            catalog.create_group(&name, namespace)
        })
    })
    .await
}

#[tauri::command]
pub(super) async fn edit_shared_tag_group<R: Runtime>(
    app: AppHandle<R>,
    edit: CatalogGroupEdit,
    safe_mode: bool,
) -> Result<(), CommandError> {
    blocking(move || {
        let lens = app
            .state::<LibraryState>()
            .safe_mode
            .lens_expecting(safe_mode)?;
        with_lens(&app, safe_mode, Hold::Read, |workspace, device, catalog| {
            workspace.edit_group(device, catalog, &edit, safe_mode)
        })?;
        Ok(lens.confirm(&app.state::<LibraryState>().safe_mode)?)
    })
    .await
}

/// 删除分组（#479）：不先确认，返回删掉的内容，界面留着它给“撤销”用（[`restore_shared_tag_group`]）。
#[tauri::command]
pub(super) async fn delete_shared_tag_group<R: Runtime>(
    app: AppHandle<R>,
    group_id: String,
    safe_mode: bool,
) -> Result<DeletedCatalogGroup, CommandError> {
    blocking(move || {
        app.state::<LibraryState>()
            .safe_mode
            .lens_expecting(safe_mode)?;
        // 删除一提交就把快照交回界面：这之后即使安全模式变了也不再报错，否则撤销就丢了。
        with_lens(&app, safe_mode, Hold::Read, |_, _, catalog| {
            catalog.delete_group(&group_id)
        })
    })
    .await
}

/// 撤销删除分组：把 [`delete_shared_tag_group`] 返回的内容原样放回全局目录。
#[tauri::command]
pub(super) async fn restore_shared_tag_group<R: Runtime>(
    app: AppHandle<R>,
    deleted: DeletedCatalogGroup,
) -> Result<(), CommandError> {
    blocking(move || {
        // 撤销只放回配置，不看哪种显示范围；提示出现后安全模式变了也照样能撤销。
        let safe = saved_safe_mode(&app);
        with_lens(&app, safe, Hold::Read, |_, _, catalog| {
            catalog.restore_group(deleted)
        })
    })
    .await
}
