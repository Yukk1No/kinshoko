//! 标签、标签目录、别名与标签组的命令。

use super::*;
use kinshoko_core::CommandError;

#[tauri::command]
pub(super) async fn inspect_tag_catalog<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
) -> Result<TagCatalogWorkspace, CommandError> {
    let reader = app.clone();
    let generation = state.safe_mode.snapshot();
    let safe = saved_safe_mode(&app);
    // 经共享的工作区读（#337）：复用它的快照。
    let result = blocking(move || {
        workspace::with_resources(
            &reader.state::<LibraryState>(),
            |workspace, libraries, catalog| workspace.inspect_catalog(libraries, catalog, safe),
        )
    })
    .await?;
    if !state.safe_mode.still(&generation) || saved_safe_mode(&app) != safe {
        return Err(mapping_safe_mode_changed());
    }
    Ok(result)
}

#[tauri::command]
pub(super) async fn correct_tag_mapping<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
    local_tag_id: String,
    correction: CatalogCorrection,
) -> Result<TagCatalogWorkspace, CommandError> {
    let reader = app.clone();
    let generation = state.safe_mode.snapshot();
    let safe = saved_safe_mode(&app);
    let publish_library_id = library_id.clone();
    let result = blocking(move || {
        workspace::with_resources(
            &reader.state::<LibraryState>(),
            |workspace, libraries, catalog| {
                let library = libraries
                    .read(&library_id)
                    .map_err(|e| CatalogError::Command(Box::new(e.into())))?;
                library.set_safe_mode(safe);
                catalog.correct(&library, &local_tag_id, correction)?;
                workspace.inspect_catalog(libraries, catalog, safe)
            },
        )
    })
    .await?;
    let publish_app = app.clone();
    let publication =
        blocking(move || publish_definition_dependencies(&publish_app, &publish_library_id)).await;
    state.search.invalidate();
    // Compatibility event refreshes current candidates, conditions and selected image labels.
    if let Ok(active) = state.active() {
        let _ = app.emit(
            EVENT,
            LibraryEvent::VocabularyChanged {
                library_id: active.info().id.clone(),
                revision: active.vocabulary_revision().map_err(CommandError::from)?,
            },
        );
    }
    if !state.safe_mode.still(&generation) || saved_safe_mode(&app) != safe {
        return Err(mapping_safe_mode_changed());
    }
    publication.map_err(|error| {
        CommandError::caused_by(
            error,
            |cause| ErrorKind::MappingDefinitionsNotSaved { cause },
            |error| format!("标签对应已保存在程序中，但资料库定义尚未更新：{error}。请在统一标签目录中重试保存标签定义。"),
        )
    })?;
    Ok(result)
}

/// 对若干参考图批量添加、否决或清除标签决定。
#[tauri::command]
pub(super) async fn edit_tags<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    image_ids: Vec<String>,
    edits: Vec<TagEdit>,
) -> Result<(), CommandError> {
    blocking(move || {
        organize_commands::write_visible(&app, &library_id, &image_ids, |library| {
            library.edit_tags(&image_ids, &edits)
        })?;
        publish_definition_dependencies(&app, &library_id).map_err(|error| {
            CommandError::caused_by(
                error,
                |cause| ErrorKind::TagEditDefinitionsNotSaved { cause },
                |error| format!("标签整理已保存，但资料库定义尚未更新：{error}。请在统一标签目录中重试保存标签定义。"),
            )
        })
    })
    .await
}

#[tauri::command]
pub(super) async fn vocabulary<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
) -> Result<Vocabulary, CommandError> {
    let catalog = state.search.clone();
    blocking(move || {
        let library = readable(&app, &library_id)?;
        with_catalog(&catalog, |catalog| catalog.search_vocabulary(&library))
    })
    .await
}

/// 侧栏的标签分组及计数，名称按界面语言 `lang`。
#[tauri::command]
pub(super) async fn tag_groups<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
    lang: String,
) -> Result<Vec<TagGroupView>, CommandError> {
    let catalog = state.search.clone();
    blocking(move || {
        let library = readable(&app, &library_id)?;
        with_catalog(&catalog, |catalog| catalog.tag_groups(&library, &lang))
    })
    .await
}

/// 给标签加一个别名；之后按这个叫法能查到、能添加这个标签。
#[tauri::command]
pub(super) async fn add_tag_alias<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
    tag_id: String,
    alias: TagAlias,
) -> Result<(), CommandError> {
    names::edit_local_alias(
        app,
        &state,
        library_id,
        tag_id,
        names::LocalAliasEdit::Add(alias),
    )
    .await
}

#[tauri::command]
pub(super) async fn remove_tag_alias<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
    tag_id: String,
    alias: String,
) -> Result<(), CommandError> {
    names::edit_local_alias(
        app,
        &state,
        library_id,
        tag_id,
        names::LocalAliasEdit::Remove(alias),
    )
    .await
}
