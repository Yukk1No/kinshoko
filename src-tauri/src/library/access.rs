//! 其他模块取资料库句柄、来源与安全模式的入口。

use super::*;

/// 运行日志里的资料库编号（#219）：它在本设备登记表里的位置。登记表还没加载、或正被别处
/// 持有（例如切换资料库的途中）时为空：只为记日志，不等锁。
pub fn library_no<R: Runtime>(app: &AppHandle<R>, library_id: &str) -> Option<LibraryNo> {
    let state = app.try_state::<LibraryState>()?;
    let libraries = state.libraries.try_lock().ok()?;
    libraries
        .as_ref()?
        .libraries()
        .iter()
        .position(|library| library.id == library_id)
        .map(LibraryNo::from_index)
}

/// 活动资料库；还没有时打开本设备上次打开的资料库并装配。会读文件，不要在主线程上调用。
pub(super) fn restore<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Arc<Library>>, String> {
    let state = app.state::<LibraryState>();
    let _transition = lock(&state.transition);
    let opened = with_visibility_commit(app, |_| {
        with_libraries(
            &state.device_dir,
            &state.libraries,
            DeviceLibraries::restore_last_opened,
        )
    })?;
    if let Some(library) = &opened {
        forward_events(app, &state, library.clone());
    }
    Ok(opened)
}

/// 当前资料库，还没打开时打开本设备上次打开的资料库。供其他模块（例如收藏截图）使用；
/// 会读文件，不要在主线程上调用。
pub fn current_or_last<R: Runtime>(app: &AppHandle<R>) -> Result<Arc<Library>, String> {
    restore(app)?.ok_or_else(|| "还没有资料库".to_owned())
}

/// 画师要整理的资料库（ADR-0008）：后端只为一个库持有可写句柄，整理哪个库就按需切过去并装配它
/// （安全模式、打标、事件转发），不改“上次打开”。该库或当前持有者有导入在收尾时，推送一次
/// `organize-waiting` 轻提示，等收尾结束后再取，请求不丢失、只执行一次；等到 [`ORGANIZE_LIMIT`]
/// 仍在收尾时报错给界面（这次整理没有执行）。会阻塞，只在阻塞任务里调用。
pub fn writable<R: Runtime>(app: &AppHandle<R>, library_id: &str) -> Result<Arc<Library>, String> {
    let state = app.state::<LibraryState>();
    wait_for_writer(
        || {
            let _transition = lock(&state.transition);
            let access = with_visibility_commit(app, |_| {
                with_libraries(&state.device_dir, &state.libraries, |libraries| {
                    libraries.organize(library_id)
                })
            })?;
            if let WriterAccess::Ready {
                library,
                switched: true,
            } = &access
            {
                let info = forward_events(app, &state, library.clone());
                let _ = app.emit(WRITABLE_LIBRARY_EVENT, info);
            }
            Ok::<_, String>(access)
        },
        |notice| {
            let _ = app.emit(ORGANIZE_WAITING_EVENT, notice);
        },
        ORGANIZE_RECHECK,
        ORGANIZE_LIMIT,
    )
    .map_err(|error| error.to_string())
}

/// 界面要读的资料库（浏览、详情、目录、标签……，ADR-0008）：按 id 取，不要求它持有可写句柄，
/// 也不切换；不是可写库时只读打开，按设置里的安全模式读。会读文件，只在阻塞任务里调用。
pub(super) fn readable<R: Runtime>(
    app: &AppHandle<R>,
    library_id: &str,
) -> Result<Arc<Library>, String> {
    let state = app.state::<LibraryState>();
    let safe = saved_safe_mode(app);
    with_libraries(&state.device_dir, &state.libraries, |libraries| {
        libraries.resolve(library_id, safe)
    })
}

/// Validate the exact visible workspace source before creating a desktop reference.
pub fn visible_source<R: Runtime>(
    app: &AppHandle<R>,
    library_id: &str,
    image_id: &str,
) -> Result<Arc<Library>, String> {
    workspace::read(app, library_id, image_id)
}

/// 图库在本设备上的位置（在资源管理器中打开，#114）：先取登记表的副本、放开锁，再检查那里
/// 仍是这个图库（与 `registered_libraries` 相同，网络盘的 I/O 不阻塞库操作）。会读文件。
pub fn library_folder<R: Runtime>(app: &AppHandle<R>, library_id: &str) -> Result<PathBuf, String> {
    let state = app.state::<LibraryState>();
    let registered = with_libraries(&state.device_dir, &state.libraries, |libraries| {
        Ok(libraries.libraries().to_vec())
    })?;
    DeviceLibraries::library_folder(&registered, library_id).map_err(|e| e.to_string())
}

/// 本设备上按“资料库＋参考图”取图的地方（参考组与桌面钉图用，#66）：活动资料库经它的参考视角
/// （现取），其他已登记的资料库只读打开，不切换活动库。会读文件，不要在主线程上调用。
pub fn with_references<R: Runtime, T>(
    app: &AppHandle<R>,
    f: impl FnOnce(&References<'_>) -> T,
) -> T {
    let state = app.state::<LibraryState>();
    let registry = lock(&state.libraries)
        .as_ref()
        .map(|libraries| libraries.libraries().to_vec())
        .or_else(|| {
            DeviceRegistry::open(&state.device_dir)
                .ok()
                .map(|device| device.libraries().to_vec())
        })
        .unwrap_or_default();
    let current = lock(&state.reference).clone();
    f(&References {
        current,
        registry: &registry,
        detached: &state.detached,
        safe_mode: saved_safe_mode(app),
    })
}

/// 本设备的数据目录：资料库登记表、参考组与备份计划都在这里（见 `crate::data_dirs`）。
pub fn data_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.state::<LibraryState>().device_dir.clone()
}

/// 本设备登记的资料库（备份范围用，#69）。在切换锁里读：不会读到切换进行到一半的登记表。
pub fn registered<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<kinshoko_core::RegisteredLibrary>, String> {
    let state = app.state::<LibraryState>();
    let _transition = lock(&state.transition);
    with_libraries(&state.device_dir, &state.libraries, |libraries| {
        Ok(libraries.libraries().to_vec())
    })
}

/// 把恢复出的资料库登记到本设备，不切换过去（#69）。
pub fn register_restored<R: Runtime>(app: &AppHandle<R>, roots: &[PathBuf]) -> Result<(), String> {
    let state = app.state::<LibraryState>();
    let _transition = lock(&state.transition);
    with_visibility_commit(app, |_| {
        with_libraries(&state.device_dir, &state.libraries, |libraries| {
            for root in roots {
                libraries.add_registration(root)?;
            }
            Ok(())
        })
    })?;
    state.detached.clear();
    Ok(())
}

/// Current authority generation for native capture actions.
pub fn capture_generation<R: Runtime>(app: &AppHandle<R>) -> u64 {
    workspace::generation(app)
}

/// Revoke receipt consent when its main window is destroyed.
pub fn revoke_import_preview_context<R: Runtime>(app: &AppHandle<R>) {
    // Never wait for the visibility permit on the window thread. Fence pending sends
    // immediately, then retire the session in the normal permit -> resources order.
    app.state::<LibraryState>()
        .import_preview_generation
        .fetch_add(1, Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_visibility_commit(&app, |_| import_preview::revoke(&app))
    });
}

/// Commit a final visibility-authorized side effect atomically with mode/settings,
/// provider/source edits and background rating publication.
/// Decode first, outside this closure. Revalidate the caller's capability against the supplied
/// generation, then perform the actual send/copy/pin before returning. This does not reject
/// safe mode itself: an explicit, scoped preview capability can be valid while safe mode is on.
///
/// Worker threads only; never await, re-enter, or acquire this while holding resource locks.
/// Lock order: transition (when needed), visibility_commit, then library/catalog/workspace/Shell
/// and desktop resources. Main-thread callbacks must not wait for this permit or ShellState;
/// registrations and native window creation may synchronously dispatch to that thread.
pub(crate) fn with_visibility_commit<R: Runtime, T>(
    app: &AppHandle<R>,
    commit: impl FnOnce(u64) -> T,
) -> T {
    let state = app.state::<LibraryState>();
    let _visibility = lock(&state.visibility_commit);
    commit(state.safe_mode_generation.load(Ordering::SeqCst))
}

/// The same pure Rust gate is injected into background result publication.
/// Lifecycle code must release it before stopping/joining a scheduler worker.
pub(crate) fn visibility_publication_gate<R: Runtime>(app: &AppHandle<R>) -> Arc<Mutex<()>> {
    app.state::<LibraryState>().visibility_commit.clone()
}

/// 安全模式是否开启（全局设置）；读不到设置时按开启处理。
pub fn safe_mode_on<R: Runtime>(app: &AppHandle<R>) -> bool {
    saved_safe_mode(app)
}

/// 安全模式范围（全局设置，#223）。
pub fn safe_mode_scope<R: Runtime>(app: &AppHandle<R>) -> SafeModeScope {
    saved_safe_mode_scope(app)
}
