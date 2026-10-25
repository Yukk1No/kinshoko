//! 标签、标签目录、别名与标签组的命令。

use super::*;

/// 一张参考图的标签，名称按界面语言 `lang`。
#[tauri::command]
pub(super) async fn image_tags<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
    image_id: String,
    lang: String,
) -> Result<ImageTags, String> {
    let catalog = state.catalog.clone();
    blocking(move || {
        let library = readable(&app, &library_id)?;
        with_catalog(&catalog, |catalog| {
            Ok(catalog.image_tags(&library, &image_id, &lang)?.image)
        })
    })
    .await
}

#[tauri::command]
pub(super) async fn catalog_image_tags<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
    image_id: String,
    lang: String,
) -> Result<CatalogImageTags, String> {
    let catalog = state.catalog.clone();
    blocking(move || {
        let library = readable(&app, &library_id)?;
        with_catalog(&catalog, |catalog| {
            catalog.image_tags(&library, &image_id, &lang)
        })
    })
    .await
}

#[tauri::command]
pub(super) async fn inspect_tag_catalog<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
) -> Result<TagCatalogWorkspace, String> {
    let (reader, catalog) = (app.clone(), state.catalog.clone());
    let generation = state.safe_mode.snapshot();
    let safe = saved_safe_mode(&app);
    let result = blocking(move || {
        with_libraries(&reader.state::<LibraryState>(), |libraries| {
            Ok(with_catalog(&catalog, |catalog| {
                catalog.inspect_libraries(libraries, safe)
            }))
        })?
    })
    .await?;
    if !state.safe_mode.still(&generation) || saved_safe_mode(&app) != safe {
        return Err("安全模式已变化，请重新检查标签对应".into());
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
) -> Result<TagCatalogWorkspace, String> {
    let (reader, catalog) = (app.clone(), state.catalog.clone());
    let generation = state.safe_mode.snapshot();
    let safe = saved_safe_mode(&app);
    let publish_library_id = library_id.clone();
    let result = blocking(move || {
        with_libraries(&reader.state::<LibraryState>(), |libraries| {
            let library = libraries.read(&library_id)?;
            library.set_safe_mode(safe);
            Ok(with_catalog(&catalog, |catalog| {
                catalog.correct(&library, &local_tag_id, correction)?;
                catalog.inspect_libraries(libraries, safe)
            }))
        })?
    })
    .await?;
    let publish_app = app.clone();
    let publication =
        blocking(move || publish_definition_dependencies(&publish_app, &publish_library_id)).await;
    state.catalog.invalidate();
    // Compatibility event refreshes current candidates, conditions and selected image labels.
    if let Ok(active) = state.active() {
        let _ = app.emit(
            EVENT,
            LibraryEvent::VocabularyChanged {
                library_id: active.info().id.clone(),
                revision: active.vocabulary_revision().map_err(|e| e.to_string())?,
            },
        );
    }
    if !state.safe_mode.still(&generation) || saved_safe_mode(&app) != safe {
        return Err("安全模式已变化，请重新检查标签对应".into());
    }
    publication.map_err(|error| format!("标签对应已保存在程序中，但资料库定义尚未更新：{error}。请在统一标签目录中重试保存标签定义。"))?;
    Ok(result)
}

/// 对若干参考图批量添加、否决或清除标签决定。
#[tauri::command]
pub(super) async fn edit_tags<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    image_ids: Vec<String>,
    edits: Vec<TagEdit>,
) -> Result<(), String> {
    blocking(move || {
        let library = writable(&app, &library_id)?;
        library.edit_tags(&image_ids, &edits).map_err(|e| e.to_string())?;
        publish_definition_dependencies(&app, &library_id).map_err(|error| format!("标签整理已保存，但资料库定义尚未更新：{error}。请在统一标签目录中重试保存标签定义。"))
    })
    .await
}

#[tauri::command]
pub(super) async fn vocabulary<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
) -> Result<Vocabulary, String> {
    let catalog = state.catalog.clone();
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
) -> Result<Vec<TagGroupView>, String> {
    let catalog = state.catalog.clone();
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
) -> Result<(), String> {
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
) -> Result<(), String> {
    names::edit_local_alias(
        app,
        &state,
        library_id,
        tag_id,
        names::LocalAliasEdit::Remove(alias),
    )
    .await
}

/// 建立标签分组，返回分组 id；给出 `namespace` 时分组是该命名空间的全部标签。
#[tauri::command]
pub(super) async fn create_tag_group<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    name: String,
    namespace: Option<TagNamespace>,
) -> Result<String, String> {
    blocking(move || {
        let library = writable(&app, &library_id)?;
        library
            .create_tag_group(&name, namespace)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(super) async fn rename_tag_group<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    group_id: String,
    name: String,
) -> Result<(), String> {
    blocking(move || {
        let library = writable(&app, &library_id)?;
        library
            .rename_tag_group(&group_id, &name)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(super) async fn delete_tag_group<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    group_id: String,
) -> Result<(), String> {
    blocking(move || {
        let library = writable(&app, &library_id)?;
        library
            .delete_tag_group(&group_id)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(super) async fn add_to_tag_group<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    group_id: String,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    blocking(move || {
        let library = writable(&app, &library_id)?;
        library
            .add_to_tag_group(&group_id, &tag_ids)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(super) async fn remove_from_tag_group<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    group_id: String,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    blocking(move || {
        let library = writable(&app, &library_id)?;
        library
            .remove_from_tag_group(&group_id, &tag_ids)
            .map_err(|e| e.to_string())
    })
    .await
}
