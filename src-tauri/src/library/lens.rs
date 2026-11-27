//! 命令取资源锁、核对安全模式的入口（#526）：[`commit_safe_mode`] 是提交安全模式的一方。
//! 取锁顺序与复核规则在 [`kinshoko_core::WorkspaceSession`]（`kinshoko_core::session` 的模块说明）。
//! 主线程回调不能等可见性许可或 ShellState：登记与原生窗口创建可能同步派发到主线程。

use super::*;
use kinshoko_core::CommandError;
pub(super) use kinshoko_core::session::Hold;

/// 提交一次安全模式改动（开关或范围）：在可见性许可里经
/// [`kinshoko_core::VisibilityPermit::try_commit_safe_mode`] 先作废进行中的视角与导入预览，再调用
/// `save` 保存设置；保存成功才换上 `change` 改过的设置，
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
    let permit = state.session.visibility();
    #[cfg(debug_assertions)]
    let locked_at = started.elapsed();
    // 重复设成同一值、保存不成也作废：进行中的工作与导入预览都要重新核对。
    let saved = permit.try_commit_safe_mode(change, |_| save())?;
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
