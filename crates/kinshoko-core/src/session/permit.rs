//! 可见性许可（#749）：安全模式提交、来源与分级发布、最后的对外动作（发送、复制、钉图）在同一
//! 个门里串行。门是会话私有的；拿到 [`VisibilityPermit`] 就表示在门内。
//!
//! 封印图不外泄靠的是“锁外准备 → 进门复核 → 门内生效”：解码、读盘这类慢事在门外做，进门后
//! 复核开始时记下的授权（[`Grant`]：安全模式代次，以及需要时的导入预览代次与图的可见性）仍然
//! 有效，才在门内做那一下对外动作。[`VisibilityPermit::commit`] 与 [`VisibilityPermit::stream`]
//! 把这三步封在一起，调用方只写准备与生效。

use std::ops::ControlFlow;
use std::sync::atomic::Ordering;
use std::sync::{Arc, MutexGuard};

use super::{WorkspaceSession, lock, order};
use crate::library::SafeMode;
use crate::safe_mode::{Lens, LensStale, SafeModeSnapshot};
use crate::{CommandError, Library};

/// 一次操作开始时记下的授权：安全模式视角，需要时还有导入预览代次。进门后经
/// [`VisibilityPermit::confirm`] 复核；其间有过任何一次安全模式提交（包括重复设成同一值）或
/// 导入预览作废即失效。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Grant {
    lens: Lens,
    import_preview: Option<u64>,
}

impl Grant {
    pub(super) fn new(lens: Lens, import_preview: Option<u64>) -> Self {
        Self {
            lens,
            import_preview,
        }
    }

    /// 记下时设置里的安全模式开关。
    pub fn on(&self) -> bool {
        self.lens.on()
    }

    pub fn lens(&self) -> Lens {
        self.lens
    }
}

/// 在可见性许可的门内，见模块说明。经 [`WorkspaceSession::visibility`] 取得，放下即出门。
/// 门内可以取资源锁，不能再进门或等切换锁。
pub struct VisibilityPermit<'a> {
    session: &'a WorkspaceSession,
    _guard: MutexGuard<'a, ()>,
    _order: order::Held,
}

impl<'a> VisibilityPermit<'a> {
    pub(super) fn enter(session: &'a WorkspaceSession) -> Self {
        let order = order::Held::permit();
        Self {
            _guard: lock(&session.visibility),
            session,
            _order: order,
        }
    }

    /// 此刻的安全模式代次。
    pub fn generation(&self) -> SafeModeSnapshot {
        self.session.safe_mode.snapshot()
    }

    /// 复核 `grant` 仍然有效：安全模式没有提交过，需要时导入预览也没有作废过。
    pub fn confirm(&self, grant: &Grant) -> Result<(), LensStale> {
        grant.lens.confirm(&self.session.safe_mode)?;
        match grant.import_preview {
            Some(taken) if self.session.import_preview.load(Ordering::SeqCst) != taken => {
                Err(LensStale)
            }
            _ => Ok(()),
        }
    }

    /// 作废进行中的视角与导入预览，设置不变（例如整份设置即将被替换时）。
    pub fn revoke(&self) {
        self.session.safe_mode.revoke();
        self.revoke_import_preview();
    }

    /// 换上新的安全模式设置，代次前进。返回换上的设置。
    pub fn replace_safe_mode(&self, mode: SafeMode) -> SafeMode {
        self.session.safe_mode.commit(|current| *current = mode)
    }

    /// 带保存的安全模式提交：先作废进行中的视角与导入预览，再用 `change` 改过的设置调用 `save`；
    /// 保存成功才换上新设置，保存不成时设置不变、取过的授权仍失效。即使设成同一值也作废。
    pub fn try_commit_safe_mode<T, E>(
        &self,
        change: impl FnOnce(&mut SafeMode),
        save: impl FnOnce(SafeMode) -> Result<T, E>,
    ) -> Result<T, E> {
        self.session.safe_mode.try_commit(change, |next| {
            self.revoke_import_preview();
            save(next)
        })
    }

    /// 作废导入预览：代次前进，关掉打开着的预览。
    pub fn revoke_import_preview(&self) {
        self.session.fence_import_preview();
        if let Some(device) = self.session.lock_libraries().as_mut() {
            device.close_import_preview(None);
        }
    }

    /// 开始一次新的导入预览：之前的授权都作废。返回新的代次。
    pub fn begin_import_preview(&self) -> u64 {
        self.session.import_preview.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// 关掉导入预览 `session_id`（`None` 时不论哪个）。晚到的、关旧预览的请求不作废新的授权。
    pub fn close_import_preview(&self, session_id: Option<&str>) -> bool {
        let revoked = self
            .session
            .lock_libraries()
            .as_mut()
            .is_some_and(|device| device.close_import_preview(session_id));
        if revoked || session_id.is_none() {
            self.session.fence_import_preview();
        }
        revoked
    }

    /// 锁外准备、进门复核、门内生效：按设置里的开关记下授权，在门外调用 `prepare`，进门后复核
    /// 授权，仍有效才在门内调用 `apply`。复核不通过得到 [`LensStale`]，`apply` 不会被调用。
    pub fn commit<P, T, E: From<LensStale>>(
        session: &'a WorkspaceSession,
        prepare: impl FnOnce(&Grant) -> Result<P, E>,
        apply: impl FnOnce(&VisibilityPermit<'_>, P) -> Result<T, E>,
    ) -> Result<T, E> {
        let grant = session.grant();
        let prepared = prepare(&grant)?;
        Self::commit_prepared(session, &grant, prepared, apply)
    }

    /// 同 [`Self::commit`]，授权由调用方先取（例如要求界面的开关与设置一致、或绑定导入预览）。
    pub fn commit_with<P, T, E: From<LensStale>>(
        session: &'a WorkspaceSession,
        grant: Grant,
        prepare: impl FnOnce() -> Result<P, E>,
        apply: impl FnOnce(&VisibilityPermit<'_>, P) -> Result<T, E>,
    ) -> Result<T, E> {
        let prepared = prepare()?;
        Self::commit_prepared(session, &grant, prepared, apply)
    }

    fn commit_prepared<P, T, E: From<LensStale>>(
        session: &'a WorkspaceSession,
        grant: &Grant,
        prepared: P,
        apply: impl FnOnce(&VisibilityPermit<'_>, P) -> Result<T, E>,
    ) -> Result<T, E> {
        let permit = session.visibility();
        permit.confirm(grant)?;
        apply(&permit, prepared)
    }

    /// 对一张图做对外动作：门外经 [`WorkspaceSession::visible_source`] 取到它的资料库并调用
    /// `prepare`（解码等），进门后复核安全模式代次，并重新核对这张图仍然可见（分级可能已改进
    /// 安全模式范围），才在门内调用 `apply`。
    pub fn commit_image<P, T, E: From<CommandError>>(
        session: &'a WorkspaceSession,
        library_id: &str,
        image_id: &str,
        prepare: impl FnOnce(&Arc<Library>) -> Result<P, E>,
        apply: impl FnOnce(&VisibilityPermit<'_>, P) -> Result<T, E>,
    ) -> Result<T, E> {
        let grant = session.grant();
        let library = session.visible_source(library_id, image_id)?;
        let prepared = prepare(&library)?;
        let permit = session.visibility();
        permit.confirm(&grant).map_err(CommandError::from)?;
        session.visible_source(library_id, image_id)?;
        apply(&permit, prepared)
    }

    /// 分块的对外动作（例如逐块发送预览）：每一块都单独进门、复核 `grant`、调用一次 `step`，
    /// 块与块之间出门并让出线程，等着提交或作废的一方可以先进门；作废之后不会再有下一块。
    /// `step` 返回 [`ControlFlow::Break`] 时结束。
    pub fn stream<T, E: From<LensStale>>(
        session: &'a WorkspaceSession,
        grant: Grant,
        mut step: impl FnMut(&VisibilityPermit<'_>) -> Result<ControlFlow<T>, E>,
    ) -> Result<T, E> {
        loop {
            {
                let permit = session.visibility();
                permit.confirm(&grant)?;
                if let ControlFlow::Break(value) = step(&permit)? {
                    return Ok(value);
                }
            }
            std::thread::yield_now();
        }
    }
}
