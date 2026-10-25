//! 本设备安全模式的权威状态（#272）：开关、安全模式范围与代次。
//!
//! 应用启动时按设置初始化，之后每次开关或调整范围都经 [`SafeModeState::commit`] 提交。两条
//! 规则只在这里实现：
//! - **取并集**（[`SafeModeState::effective`]）：界面当前的视角与设置里的开关取“或”，切换的
//!   这一刻不会按关着的视角露出范围内的内容；范围总按设置。
//! - **开始记下、结束复核**（[`SafeModeState::snapshot`] / [`SafeModeState::still`]）：只比较
//!   代次。其间发生过任何一次提交（包括重复设成同一值、设置没保存成）即失效，调用方丢弃结果。
//!
//! 提交与外壳的可见性锁、通知资料库和桌面的顺序由应用壳负责；这里保证换值与代次前进是一步，
//! 带保存的提交（[`SafeModeState::try_commit`]）保存成功才换值。

use std::sync::{Mutex, MutexGuard};

use crate::library::{SafeMode, SafeModeScope};

/// 本设备安全模式的权威状态，见模块说明。
pub struct SafeModeState {
    state: Mutex<State>,
}

struct State {
    mode: SafeMode,
    generation: u64,
}

/// [`SafeModeState::snapshot`] 取下的代次。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SafeModeSnapshot(u64);

impl Default for SafeModeState {
    /// 还没按设置初始化时：开启，默认范围。
    fn default() -> Self {
        Self::new(SafeMode::new(true, SafeModeScope::default()))
    }
}

impl SafeModeState {
    pub fn new(mode: SafeMode) -> Self {
        Self {
            state: Mutex::new(State {
                mode,
                generation: 0,
            }),
        }
    }

    /// 设置里的安全模式。
    pub fn current(&self) -> SafeMode {
        self.lock().mode
    }

    /// 界面视角 `view_on` 与设置取并集后的视角；范围取设置里的。
    pub fn effective(&self, view_on: bool) -> SafeMode {
        let mode = self.current();
        SafeMode::new(view_on || mode.on, mode.scope)
    }

    pub fn snapshot(&self) -> SafeModeSnapshot {
        SafeModeSnapshot(self.lock().generation)
    }

    /// 取快照以来没有过提交。
    pub fn still(&self, snapshot: &SafeModeSnapshot) -> bool {
        self.lock().generation == snapshot.0
    }

    /// 换上 `change` 改过的设置，代次加一；没改动也加一，进行中的工作都要重新核对。
    /// 返回提交后的设置。
    pub fn commit(&self, change: impl FnOnce(&mut SafeMode)) -> SafeMode {
        let mut state = self.lock();
        change(&mut state.mode);
        state.generation += 1;
        state.mode
    }

    /// 只让代次加一，设置不变：取过的快照都失效（例如整份设置即将被替换时）。
    pub fn revoke(&self) {
        self.commit(|_| {});
    }

    /// 带保存的提交：先 [`Self::revoke`]，再用 `change` 改过的设置调用 `save`；保存成功才换上
    /// 新设置（代次再加一），保存不成时设置不变、取过的快照仍失效。保存期间读到的仍是原值。
    /// `save` 不持本状态的锁，调用方负责让提交串行（应用壳的可见性锁）。
    pub fn try_commit<T, E>(
        &self,
        change: impl FnOnce(&mut SafeMode),
        save: impl FnOnce(SafeMode) -> Result<T, E>,
    ) -> Result<T, E> {
        self.revoke();
        let mut next = self.current();
        change(&mut next);
        let saved = save(next)?;
        self.commit(|mode| *mode = next);
        Ok(saved)
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(on: bool) -> SafeModeState {
        SafeModeState::new(SafeMode::new(on, SafeModeScope::Explicit))
    }

    #[test]
    fn an_uninitialized_state_is_on_with_the_default_scope() {
        assert_eq!(
            SafeModeState::default().current(),
            SafeMode::new(true, SafeModeScope::default())
        );
    }

    #[test]
    fn the_effective_lens_is_on_when_either_the_view_or_the_setting_is() {
        let scope = SafeModeScope::Explicit;
        assert_eq!(state(false).effective(true), SafeMode::new(true, scope));
        assert_eq!(state(true).effective(false), SafeMode::new(true, scope));
        assert_eq!(state(false).effective(false), SafeMode::new(false, scope));
    }

    #[test]
    fn a_snapshot_holds_until_a_commit() {
        let state = state(true);
        let snapshot = state.snapshot();
        assert!(state.still(&snapshot));
        assert!(!state.commit(|mode| mode.on = false).on);
        assert!(!state.still(&snapshot));
        assert!(state.still(&state.snapshot()));
    }

    #[test]
    fn committing_the_same_value_still_revokes_snapshots() {
        let state = state(true);
        let snapshot = state.snapshot();
        state.commit(|mode| mode.on = true);
        assert!(!state.still(&snapshot));
        let snapshot = state.snapshot();
        state.commit(|mode| mode.scope = SafeModeScope::Explicit);
        assert!(!state.still(&snapshot));
        assert_eq!(
            state.current(),
            SafeMode::new(true, SafeModeScope::Explicit)
        );
    }

    #[test]
    fn a_failed_save_restores_the_previous_setting_and_still_revokes() {
        let state = state(true);
        let snapshot = state.snapshot();
        let saved: Result<(), &str> = state.try_commit(
            |mode| mode.on = false,
            |next| {
                assert!(!next.on);
                assert!(state.current().on, "还没保存成就露出了新设置");
                assert!(!state.still(&snapshot), "保存前没有作废快照");
                Err("磁盘满了")
            },
        );
        assert_eq!(saved, Err("磁盘满了"));
        assert!(state.current().on);
        assert!(!state.still(&snapshot));
    }

    #[test]
    fn a_successful_save_keeps_the_new_setting() {
        let state = state(true);
        let saved: Result<u8, ()> = state.try_commit(|mode| mode.on = false, |_| Ok(7));
        assert_eq!(saved, Ok(7));
        assert!(!state.current().on);
    }
}
