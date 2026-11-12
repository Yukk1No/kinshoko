//! 登记、创建与切换资料库的命令。

use super::*;
use kinshoko_core::CommandError;

/// 启动时打开本设备上次打开的资料库并装配后端（可写句柄、缩略图协议、事件转发）。界面不用
/// 返回值判断任何事（ADR-0016），它留给 e2e 核对后端状态。
#[tauri::command]
pub(super) async fn current_library<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<LibraryInfo>, CommandError> {
    blocking(move || Ok(restore(&app)?.map(|library| library.info().clone()))).await
}

/// 在 `parent` 下新建名为 `name` 的资料库文件夹，登记到本设备并切换过去。
#[tauri::command]
pub(super) async fn create_library<R: Runtime>(
    app: AppHandle<R>,
    parent: PathBuf,
    name: String,
) -> Result<LibraryInfo, CommandError> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        let _transition = lock(&state.transition);
        let library = with_visibility_commit(&app, |_| {
            with_libraries(&state, |libraries| {
                libraries.create(&parent.join(name.trim()), &name)
            })
        })?;
        Ok(forward_events(&app, &state, library))
    })
    .await
}

/// 在 `parent` 下新建名为 `name` 的资料库文件夹并登记到本设备，但不切换过去（#370：订阅榜单时
/// 新建「pixiv 榜单」，画师还留在当前图库）。
#[tauri::command]
pub(super) async fn create_library_unopened<R: Runtime>(
    app: AppHandle<R>,
    parent: PathBuf,
    name: String,
) -> Result<kinshoko_core::RegisteredLibrary, CommandError> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        let root = parent.join(name.trim());
        Library::create(&root, &name).map_err(DeviceLibraryError::Library)?;
        let registered = with_visibility_commit(&app, |_| {
            with_libraries(&state, |libraries| libraries.add_registration(&root))
        })?;
        state.release_readers();
        Ok(registered)
    })
    .await
}

/// 保存入口各自记住的位置（ADR-0016）。
#[tauri::command]
pub(super) async fn save_memory<R: Runtime>(
    app: AppHandle<R>,
) -> Result<kinshoko_core::SaveMemory, CommandError> {
    blocking(move || {
        with_libraries(&app.state::<LibraryState>(), |libraries| {
            Ok(libraries.save_memory())
        })
    })
    .await
}

/// 导入对话框里亲手选定了保存目标。
#[tauri::command]
pub(super) async fn remember_import_destination<R: Runtime>(
    app: AppHandle<R>,
    destination: kinshoko_core::library::SaveDestination,
) -> Result<(), CommandError> {
    blocking(move || {
        with_libraries(&app.state::<LibraryState>(), |libraries| {
            libraries.remember_import_destination(&destination)
        })
    })
    .await
}

/// 亲手选定了新建资料库的位置。
#[tauri::command]
pub(super) async fn remember_new_library_parent<R: Runtime>(
    app: AppHandle<R>,
    parent: PathBuf,
) -> Result<(), CommandError> {
    blocking(move || {
        with_libraries(&app.state::<LibraryState>(), |libraries| {
            libraries.remember_new_library_parent(&parent)
        })
    })
    .await
}

/// 系统的「图片」文件夹，新建资料库时没有已有资料库可以挨着放才用它；不存在时为空。
#[tauri::command]
pub(super) async fn pictures_folder<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<PathBuf>, CommandError> {
    Ok(app.path().picture_dir().ok().filter(|dir| dir.is_dir()))
}

/// 本设备登记的资料库，以及这次检查时不可用的原因（例如移动盘没插）。
#[tauri::command]
pub(super) async fn registered_libraries<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<LibraryRegistration>, CommandError> {
    blocking(move || {
        let registered = with_libraries(&app.state::<LibraryState>(), |libraries| {
            Ok(libraries.libraries().to_vec())
        })?;
        Ok(DeviceLibraries::inspect_registrations(&registered))
    })
    .await
}

/// 登记所选文件夹里的资料库并切换过去；搬家后重新登记同一资料库时只更新位置。
#[tauri::command]
pub(super) async fn register_library<R: Runtime>(
    app: AppHandle<R>,
    root: PathBuf,
) -> Result<LibraryInfo, CommandError> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        let _transition = lock(&state.transition);
        let library = with_visibility_commit(&app, |_| {
            with_libraries(&state, |libraries| libraries.register(&root))
        })?;
        Ok(forward_events(&app, &state, library))
    })
    .await
}

/// 切换到已登记的资料库。旧库的导入在提交当前一项后结束，打标停止。
// 仅 e2e 使用：application-settings-backup、save-destination、save-destination-followup、sealed-import-preview、source-actions、tag-identity、workspace-delete、workspace
#[tauri::command]
pub(super) async fn switch_library<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
) -> Result<LibraryInfo, CommandError> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        let _transition = lock(&state.transition);
        let library = with_visibility_commit(&app, |_| {
            with_libraries(&state, |libraries| libraries.switch(&library_id))
        })?;
        Ok(forward_events(&app, &state, library))
    })
    .await
}

/// 取消本设备的登记；资料库文件夹与整理结果原样保留。取消的是活动库时一并关闭它。
#[tauri::command]
pub(super) async fn unregister_library<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
) -> Result<(), CommandError> {
    blocking(move || {
        let state = app.state::<LibraryState>();
        let _transition = lock(&state.transition);
        let closed = with_visibility_commit(&app, |_| {
            with_libraries(&state, |libraries| {
                let closed = libraries
                    .current()
                    .is_some_and(|library| library.info().id == library_id);
                libraries.unregister(&library_id)?;
                Ok(closed)
            })
        })?;
        if closed {
            *lock(&state.forwarded) = None;
            state.search.invalidate();
            *lock(&state.reference) = None;
        }
        state.release_readers();
        // 打标正在打这个库时中止那一批并等它放下句柄（#414）；发布闸门已放开。
        crate::tagging::release(&app, &library_id);
        Ok(())
    })
    .await
}
