//! Formal IPC adapter for shared tag-name actions.

use super::*;
use kinshoko_core::CommandError;
use kinshoko_core::command_error::ErrorKind;
use kinshoko_core::tag_catalog::CatalogNameEdit;

pub(super) fn refresh_labels<R: Runtime>(
    app: &AppHandle<R>,
    state: &LibraryState,
) -> Result<(), CommandError> {
    state.search.invalidate();
    if let Ok(active) = state.active() {
        let _ = app.emit(
            EVENT,
            LibraryEvent::VocabularyChanged {
                library_id: active.info().id.clone(),
                revision: active.vocabulary_revision().map_err(CommandError::from)?,
            },
        );
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn edit_tag_name<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    catalog_id: String,
    edit: CatalogNameEdit,
) -> Result<TagCatalogWorkspace, CommandError> {
    let reader = app.clone();
    let generation = state.safe_mode.snapshot();
    let safe = saved_safe_mode(&app);
    // 经共享的工作区读可见目录（#337）：复用它的快照。
    let result = blocking(move || {
        workspace::with_resources(
            &reader.state::<LibraryState>(),
            |workspace, libraries, catalog| {
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
        )
    })
    .await?;
    refresh_labels(&app, &state)?;
    if !state.safe_mode.still(&generation) || saved_safe_mode(&app) != safe {
        return Err(CommandError::new(
            ErrorKind::SafeModeChangedNames,
            "安全模式已变化，请重新读取标签名称",
        ));
    }
    Ok(result)
}

pub(super) enum LocalAliasEdit {
    Add(TagAlias),
    Remove(String),
}

pub(super) async fn edit_local_alias<R: Runtime>(
    app: AppHandle<R>,
    state: &LibraryState,
    library_id: String,
    local_id: String,
    edit: LocalAliasEdit,
) -> Result<(), CommandError> {
    let catalog = state.search.clone();
    let reader = app.clone();
    blocking(move || {
        // 别名记在本设备的统一目录里，资料库只读核对：不必是可写库（ADR-0008）。
        let library = readable(&reader, &library_id)?;
        with_catalog(&catalog, |catalog| {
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
        })
    })
    .await?;
    refresh_labels(&app, state)
}
