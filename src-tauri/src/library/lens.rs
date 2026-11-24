//! 命令取资源锁、核对安全模式的入口（#526）：[`with_lens`] 按 [`Hold`] 取锁并复核，
//! [`commit_safe_mode`] 是提交安全模式的一方。
//!
//! 取锁顺序：transition（需要时）→ visibility_commit → 资料库、目录、工作区、Shell 与桌面资源。
//! 只能在工作线程上调用；持锁期间不能 await、不能重入，持资源锁时不能再等 visibility_commit。
//! 主线程回调不能等 visibility_commit 或 ShellState：登记与原生窗口创建可能同步派发到主线程。

use super::*;
use kinshoko_core::CommandError;
use kinshoko_core::workspace::Workspace;

/// 取资源时要哪一级保证。
pub(super) enum Hold {
    /// 只核对开关：界面的开关与设置不一致时不取资源。
    Read,
    /// 做完再复核代次：其间安全模式变过就丢弃结果。
    Confirmed,
    /// 再加上前后修订号不变，变了得到游标过期。
    Stable,
    /// 先取 transition 与 visibility_commit，再做 Confirmed 的事：与安全模式提交、后台分级发布互斥。
    Commit,
}

/// 按 `hold` 取资源锁并核对安全模式，在锁里调用 `f`。开关 `safe` 与设置不一致、或按 `hold`
/// 复核时安全模式变过，得到 [`kinshoko_core::library::Error::LensChanged`]。
#[track_caller]
pub(super) fn with_lens<R: Runtime, T>(
    app: &AppHandle<R>,
    safe: bool,
    hold: Hold,
    f: impl FnOnce(&mut Workspace, &mut DeviceLibraries, &mut TagCatalog) -> Result<T, CatalogError>,
) -> Result<T, CommandError> {
    let state = app.state::<LibraryState>();
    match hold {
        Hold::Read => {
            state.safe_mode.lens_expecting(safe)?;
            workspace::with_resources(&state, f)
        }
        Hold::Confirmed => confirmed(&state, safe, f),
        Hold::Stable => confirmed(&state, safe, |workspace, device, catalog| {
            let before = workspace.status(device, catalog, safe)?;
            let value = f(workspace, device, catalog)?;
            let after = workspace.status(device, catalog, safe)?;
            if before.revision != after.revision {
                return Err(kinshoko_core::library::Error::CursorExpired.into());
            }
            Ok(value)
        }),
        Hold::Commit => {
            let _transition = lock(&state.transition);
            // 包括来源编辑器的分级与永久删除来源。
            let _visibility = lock(&state.visibility_commit);
            confirmed(&state, safe, f)
        }
    }
}

#[track_caller]
fn confirmed<T>(
    state: &LibraryState,
    safe: bool,
    f: impl FnOnce(&mut Workspace, &mut DeviceLibraries, &mut TagCatalog) -> Result<T, CatalogError>,
) -> Result<T, CommandError> {
    let lens = state.safe_mode.lens_expecting(safe)?;
    let value = workspace::with_resources(state, f)?;
    lens.confirm(&state.safe_mode)?;
    Ok(value)
}

/// 提交一次安全模式改动（开关或范围）：持 visibility_commit，经 [`SafeModeState::try_commit`]
/// 先作废进行中的视角与导入预览，再调用 `save` 保存设置；保存成功才换上 `change` 改过的设置，
/// 然后仍在锁里调用 `publish` 把新设置交给资料库与桌面。保存不成时设置不变、不调用 `publish`。
/// 开发构建在控制台输出等锁、保存与 `publish` 各用了多久，以 `label` 开头。
pub(super) fn commit_safe_mode<R: Runtime, T>(
    app: &AppHandle<R>,
    label: impl std::fmt::Display,
    change: impl FnOnce(&mut SafeMode),
    save: impl FnOnce() -> Result<T, CommandError>,
    publish: impl FnOnce(&LibraryState),
) -> Result<T, CommandError> {
    // 分段耗时（#183）。
    #[cfg(debug_assertions)]
    let started = std::time::Instant::now();
    #[cfg(not(debug_assertions))]
    let _ = label;
    let state = app.state::<LibraryState>();
    let _visibility = lock(&state.visibility_commit);
    #[cfg(debug_assertions)]
    let locked_at = started.elapsed();
    // 重复设成同一值、保存不成也作废：进行中的工作都要重新核对。
    let saved = state.safe_mode.try_commit(change, |_| {
        import_preview::revoke(app);
        save()
    })?;
    #[cfg(debug_assertions)]
    let saved_at = started.elapsed();
    publish(&state);
    #[cfg(debug_assertions)]
    eprintln!(
        "{label} lock_ms={:.1} save_ms={:.1} switch_ms={:.1}",
        locked_at.as_secs_f64() * 1e3,
        (saved_at - locked_at).as_secs_f64() * 1e3,
        (started.elapsed() - saved_at).as_secs_f64() * 1e3
    );
    Ok(saved)
}
