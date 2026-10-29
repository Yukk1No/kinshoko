//! 登记、创建与切换资料库的命令。

use super::*;

/// 当前资料库；启动后第一次调用时打开本设备上次打开的资料库。
#[tauri::command]
pub(super) async fn current_library<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<LibraryInfo>, String> {
    blocking(move || Ok(restore(&app)?.map(|library| library.info().clone()))).await
}

/// 在 `parent` 下新建名为 `name` 的资料库文件夹，登记到本设备并切换过去。
#[tauri::command]
pub(super) async fn create_library<R: Runtime>(
    app: AppHandle<R>,
    parent: PathBuf,
    name: String,
) -> Result<LibraryInfo, String> {
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

/// 本设备登记的资料库，以及这次检查时不可用的原因（例如移动盘没插）。
#[tauri::command]
pub(super) async fn registered_libraries<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<LibraryRegistration>, String> {
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
) -> Result<LibraryInfo, String> {
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
#[tauri::command]
pub(super) async fn switch_library<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
) -> Result<LibraryInfo, String> {
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
) -> Result<(), String> {
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
            // Tagging::drop joins a worker that may be waiting for visibility_commit.
            // Registry revocation has committed and released that gate before this join.
            crate::tagging::detach(&app);
        }
        state.release_readers();
        Ok(())
    })
    .await
}
