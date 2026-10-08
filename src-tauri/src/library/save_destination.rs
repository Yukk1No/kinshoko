//! Save actions resolve one identity-checked provider under a short registry lock.
//! The returned Arc stays with the work; browsing never selects its destination.
use super::*;
use kinshoko_core::{ImportTaskSnapshot, library::SaveDestination};

pub(super) fn fixed_library<R: Runtime>(
    app: &AppHandle<R>,
    destination: &SaveDestination,
) -> Result<Arc<Library>, String> {
    let state = app.state::<LibraryState>();
    let _transition = lock(&state.transition);
    let library = with_libraries(&state.device_dir, &state.libraries, |device| {
        device.write(&destination.library_id)
    })?;
    library
        .validate_destination(destination)
        .map_err(|e| e.to_string())?;
    state.install_translations(&library);
    library.set_safe_mode(saved_safe_mode(app));
    Ok(library)
}

/// A fixed owner is retained through content writes and optional definition publication.
fn save<R: Runtime, T>(
    app: &AppHandle<R>,
    destination: &SaveDestination,
    publish: bool,
    f: impl FnOnce(&Library) -> Result<T, String>,
) -> Result<T, String> {
    let library = fixed_library(app, destination)?;
    let bound = library
        .for_destination(destination)
        .map_err(|e| e.to_string())?;
    let value = f(&bound)?;
    if publish {
        publish_saved(app, &library)?;
    }
    Ok(value)
}
pub fn with_destination<R: Runtime, T>(
    app: &AppHandle<R>,
    destination: &SaveDestination,
    f: impl FnOnce(&Library) -> Result<T, String>,
) -> Result<T, String> {
    save(app, destination, false, f)
}
pub fn with_destination_published<R: Runtime, T>(
    app: &AppHandle<R>,
    destination: &SaveDestination,
    f: impl FnOnce(&Library) -> Result<T, String>,
) -> Result<T, String> {
    save(app, destination, true, f)
}
fn publish_saved<R: Runtime>(app: &AppHandle<R>, library: &Library) -> Result<(), String> {
    let state = app.state::<LibraryState>();
    with_catalog(&state.device_dir, &state.catalog, |catalog| {
        catalog.synchronize(library).map(|_| ())
    })
    .map_err(|e| format!("内容已保存，资料库标签定义未更新：{e}。可在统一标签目录重试保存定义。"))
}
fn complete<R: Runtime>(app: &AppHandle<R>, owner: &str, id: &str, warning: Option<String>) {
    let state = app.state::<LibraryState>();
    if let Err(error) = with_libraries(&state.device_dir, &state.libraries, |device| {
        device.complete_import_publication(owner, id, warning)
    }) {
        eprintln!("无法记录原导入任务的收尾结果：{error}");
    }
}
pub(super) fn begin<R: Runtime>(
    app: &AppHandle<R>,
    destination: SaveDestination,
    source: ImportSource,
    options: ImportOptions,
) -> Result<String, String> {
    let library = fixed_library(app, &destination)?;
    let events = library.events();
    let state = app.state::<LibraryState>();
    let id = with_libraries(&state.device_dir, &state.libraries, |device| {
        let id = device.start_import_to(destination.clone(), source, options)?;
        device.defer_import_completion(&id)?;
        Ok(id)
    })?;
    // Subscribe before starting, so even a one-item task cannot finish before observation.
    let (worker, task_id) = (app.clone(), id.clone());
    if let Err(error) = std::thread::Builder::new()
        .name("kinshoko-import-owner".into())
        .spawn(move || {
            for event in events {
                if let LibraryEvent::TaskFinished { task_id: id, .. } = event
                    && id == task_id
                {
                    let warning = publish_saved(&worker, &library).err();
                    complete(&worker, &library.info().id, &task_id, warning);
                    break;
                }
            }
        })
    {
        // Content work has already started. Return its real ID and record the unavailable follow-up.
        complete(
            app,
            &destination.library_id,
            &id,
            Some(format!(
                "导入任务已启动，标签定义发布未启动：{error}。内容处理完毕后，可在统一标签目录重试保存定义。"
            )),
        );
    }
    Ok(id)
}

#[tauri::command]
pub(super) async fn import_tasks(
    state: State<'_, LibraryState>,
) -> Result<Vec<ImportTaskSnapshot>, String> {
    let (dir, libraries) = (state.device_dir.clone(), state.libraries.clone());
    blocking(move || with_libraries(&dir, &libraries, |device| Ok(device.import_tasks()))).await
}
#[tauri::command]
pub(super) async fn dismiss_import(
    state: State<'_, LibraryState>,
    library_id: String,
    task_id: String,
) -> Result<(), String> {
    let (dir, libraries) = (state.device_dir.clone(), state.libraries.clone());
    blocking(move || {
        with_libraries(&dir, &libraries, |device| {
            device.dismiss_import(&library_id, &task_id)
        })
    })
    .await
}

#[tauri::command]
pub(super) async fn workspace_copy_source<R: Runtime>(
    app: AppHandle<R>,
    target: kinshoko_core::workspace::WorkspaceSourceTarget,
    destination: SaveDestination,
    safe_mode: bool,
) -> Result<String, String> {
    blocking(move || {
        let source = source_actions::action(
            &app,
            &target,
            safe_mode,
            |workspace, device, catalog, target| {
                workspace.read_source(device, catalog, target, safe_mode)
            },
        )?;
        with_destination_published(&app, &destination, |library| {
            library
                .copy_from(&source, &target.image_id)
                .map_err(|e| e.to_string())
        })
    })
    .await
}
