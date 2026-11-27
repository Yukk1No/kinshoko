//! Formal IPC adapter for shared tag-name actions.

use super::*;
use crate::app_notice::VocabularyRevision;
use kinshoko_core::CommandError;
use kinshoko_core::tag_catalog::CatalogNameEdit;
use kinshoko_core::tag_catalog::CatalogTag;

#[tauri::command]
pub(super) async fn tag_name_conflict_tags<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    tag_id: String,
) -> Result<Vec<CatalogTag>, CommandError> {
    let workspace = super::tag_commands::inspect_tag_catalog(app).await?;
    Ok(workspace.catalog.name_conflict_tags(&library_id, &tag_id)?)
}

pub(super) fn refresh_labels<R: Runtime>(
    app: &AppHandle<R>,
    state: &LibraryState,
) -> Result<(), CommandError> {
    let revision = state
        .active()
        .ok()
        .map(|active| {
            active
                .vocabulary_revision()
                .map(|revision| VocabularyRevision {
                    library_id: active.info().id.clone(),
                    revision,
                })
        })
        .transpose();
    match revision {
        Ok(revision) => {
            publish(app, AppNotice::CatalogLabelsChanged(revision));
            Ok(())
        }
        Err(error) => {
            publish(app, AppNotice::CatalogLabelsChanged(None));
            Err(error.into())
        }
    }
}

pub(crate) fn refresh_search_on_notice<R: Runtime>(app: &AppHandle<R>, notice: &AppNotice) {
    if matches!(
        notice,
        AppNotice::CatalogLabelsChanged(_)
            | AppNotice::Library(
                LibraryEvent::VocabularyChanged { .. }
                    | LibraryEvent::ImagesChanged { .. }
                    | LibraryEvent::ListStale { .. }
                    | LibraryEvent::SafeModeChanged { .. }
            )
    ) {
        // Invalidate before the window adapter asks consumers to read again.
        app.state::<LibraryState>().search().invalidate();
    }
}

fn tag_names_safe_mode_changed() -> CommandError {
    CommandError::new(
        ErrorKind::TagNamesSafeModeChanged,
        "安全模式已变化，请重新读取标签名称",
    )
}

#[tauri::command]
pub(super) async fn edit_tag_name<R: Runtime>(
    app: AppHandle<R>,
    catalog_id: String,
    edit: CatalogNameEdit,
) -> Result<TagCatalogWorkspace, CommandError> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        let grant = state.session.grant();
        // 经共享的工作区读可见目录（#337）：复用它的快照。
        let result = state.session.with_current_lens(
            |_| tag_names_safe_mode_changed(),
            |workspace, libraries, catalog, safe| {
                let visible = workspace.inspect_catalog(libraries, catalog, safe)?;
                if !visible.catalog.tags.iter().any(|tag| tag.id == catalog_id) {
                    return Err(CatalogError::UnknownTag);
                }
                match edit {
                    CatalogNameEdit::Prefer { name } => {
                        catalog.set_name_preference(&catalog_id, &name)?;
                    }
                    CatalogNameEdit::Reset { lang } => {
                        catalog.reset_name_preference(&catalog_id, &lang)?;
                    }
                    CatalogNameEdit::AddAlias { alias } => {
                        catalog.add_alias(&catalog_id, &alias)?;
                    }
                    CatalogNameEdit::RemoveAlias { alias } => {
                        catalog.remove_alias(&catalog_id, &alias)?;
                    }
                }
                workspace.inspect_catalog(libraries, catalog, safe)
            },
        )?;
        refresh_labels(&app, &state)?;
        if !state.session.is_grant_current(&grant) {
            return Err(tag_names_safe_mode_changed());
        }
        Ok(result)
    })
    .await
}

pub(super) enum LocalAliasEdit {
    Add(TagAlias),
    Remove(String),
}

pub(super) async fn edit_local_alias<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    local_id: String,
    edit: LocalAliasEdit,
) -> Result<(), CommandError> {
    blocking(move || {
        // 别名记在本设备的统一目录里，资料库只读核对：不必是可写库（ADR-0008）。
        let library = readable(&app, &library_id)?;
        let state = app.state::<LibraryState>();
        state.session.with_catalog(|catalog| {
            let snapshot = catalog.synchronize(&library)?;
            let mapping = snapshot
                .mappings
                .iter()
                .find(|mapping| {
                    mapping.library_id == library_id && mapping.local_tag_id == local_id
                })
                .ok_or(CatalogError::UnknownMapping)?;
            if !library
                .vocabulary()?
                .tags
                .iter()
                .any(|tag| tag.id == local_id)
            {
                return Err(CatalogError::UnknownMapping);
            }
            match edit {
                LocalAliasEdit::Add(alias) => {
                    catalog.add_alias(&mapping.catalog_id, &alias)?;
                }
                LocalAliasEdit::Remove(name) => {
                    if let Some(tag) = snapshot
                        .tags
                        .iter()
                        .find(|tag| tag.id == mapping.catalog_id)
                    {
                        for alias in tag.aliases.iter().filter(|alias| alias.name == name) {
                            catalog.remove_alias(&mapping.catalog_id, alias)?;
                        }
                    }
                }
            }
            Ok(())
        })?;
        refresh_labels(&app, &state)
    })
    .await
}
