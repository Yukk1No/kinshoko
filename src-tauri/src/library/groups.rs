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
    verbs::lens(
        app,
        safe_mode,
        Hold::Stable,
        move |workspace, device, catalog| {
            workspace.shared_tag_groups(device, catalog, &lang, safe_mode)
        },
    )
    .await
}

#[tauri::command]
pub(super) async fn create_shared_tag_group<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    namespace: Option<TagNamespace>,
) -> Result<String, CommandError> {
    blocking(move || {
        let mut created = None;
        let outcome = app.state::<LibraryState>().session.with_current_lens(
            CommandError::from,
            |workspace, device, catalog, safe| {
                // Existing source groups enroll before a new group is appended.
                workspace.status(device, catalog, safe)?;
                let id = catalog.create_group(&name, namespace)?;
                created = Some(id.clone());
                Ok(id)
            },
        );
        let id = match outcome {
            Ok(id) => id,
            Err(error) if error.kind == ErrorKind::LensChanged => {
                let Some(id) = created else {
                    return Err(error);
                };
                id
            }
            Err(error) => return Err(error),
        };
        publish(&app, AppNotice::TagGroupsChanged);
        Ok(id)
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
        let mut committed = false;
        let outcome = app.state::<LibraryState>().session.with_lens(
            safe_mode,
            Hold::Confirmed,
            |workspace, device, catalog| {
                workspace.edit_group(device, catalog, &edit, safe_mode)?;
                committed = true;
                Ok(())
            },
        );
        if committed {
            publish(&app, AppNotice::TagGroupsChanged);
        }
        outcome?;
        Ok(())
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
        // 删除一提交就把快照交回界面：这之后即使安全模式变了也不再报错，否则撤销就丢了。
        let deleted = app.state::<LibraryState>().session.with_lens(
            safe_mode,
            Hold::Read,
            |_, _, catalog| catalog.delete_group(&group_id),
        )?;
        publish(&app, AppNotice::TagGroupsChanged);
        Ok(deleted)
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
        app.state::<LibraryState>()
            .session
            .with_catalog(|catalog| catalog.restore_group(deleted))?;
        publish(&app, AppNotice::TagGroupsChanged);
        Ok(())
    })
    .await
}
