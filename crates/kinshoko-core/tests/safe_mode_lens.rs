//! 开始记下、结束复核（#526）：命令开始时取的 `Lens`，做完时经 `confirm` 复核。
//! 只经工作区会话的对外接口：读 `SafeModeState`，改动经可见性许可。不启动应用。

use kinshoko_core::WorkspaceSession;
use kinshoko_core::approx::BuiltinApproxTable;
use kinshoko_core::library::{Error, SafeMode, SafeModeScope, TagTranslations};
use kinshoko_core::safe_mode::{LensStale, SafeModeState};
use kinshoko_core::search::CatalogSearch;

/// 只用到安全模式；登记表与目录不会打开，目录路径不必存在。
struct Session(WorkspaceSession);

impl Session {
    fn commit(&self, change: impl FnOnce(&mut SafeMode)) {
        self.0
            .visibility()
            .try_commit_safe_mode(change, |_| Ok::<_, ()>(()))
            .unwrap();
    }

    fn revoke(&self) {
        self.0.visibility().revoke();
    }

    fn try_commit<T, E>(
        &self,
        change: impl FnOnce(&mut SafeMode),
        save: impl FnOnce(SafeMode) -> Result<T, E>,
    ) -> Result<T, E> {
        self.0.visibility().try_commit_safe_mode(change, save)
    }
}

impl std::ops::Deref for Session {
    type Target = SafeModeState;
    fn deref(&self) -> &SafeModeState {
        self.0.safe_mode()
    }
}

fn state(on: bool) -> Session {
    let dir = std::env::temp_dir().join("kinshoko-safe-mode-lens-unused");
    let search = CatalogSearch::new(
        dir.clone(),
        TagTranslations::default(),
        BuiltinApproxTable::bundled(),
    );
    Session(WorkspaceSession::new(
        dir,
        SafeMode::new(on, SafeModeScope::Explicit),
        search,
    ))
}

#[test]
fn a_lens_holds_while_nothing_changes() {
    let state = state(true);
    let lens = state.lens();
    assert!(lens.on());
    assert_eq!(lens.confirm(state.0.safe_mode()), Ok(()));
    assert_eq!(
        lens.confirm(state.0.safe_mode()),
        Ok(()),
        "复核本身不让视角失效"
    );
}

#[test]
fn any_commit_makes_a_lens_stale_even_to_the_same_value() {
    let state = state(true);
    let lens = state.lens();
    state.commit(|mode| mode.on = true);
    assert_eq!(lens.confirm(state.0.safe_mode()), Err(LensStale));

    let lens = state.lens();
    state.commit(|mode| mode.on = false);
    assert_eq!(lens.confirm(state.0.safe_mode()), Err(LensStale));
    assert!(!state.lens().on());
}

#[test]
fn revoking_makes_a_lens_stale() {
    let state = state(false);
    let lens = state.lens();
    state.revoke();
    assert_eq!(lens.confirm(state.0.safe_mode()), Err(LensStale));
    assert_eq!(state.lens().confirm(state.0.safe_mode()), Ok(()));
}

#[test]
fn expecting_a_different_switch_fails_at_once() {
    let state = state(true);
    assert_eq!(state.lens_expecting(false), Err(LensStale));
    let lens = state.lens_expecting(true).expect("开关一致");
    assert!(lens.on());
    assert_eq!(lens.confirm(state.0.safe_mode()), Ok(()));
}

#[test]
fn a_failed_save_still_makes_an_earlier_lens_stale() {
    let state = state(true);
    let lens = state.lens();
    let saved: Result<(), &str> = state.try_commit(
        |mode| mode.on = false,
        |_| {
            assert_eq!(
                lens.confirm(state.0.safe_mode()),
                Err(LensStale),
                "保存前没有作废视角"
            );
            Err("磁盘满了")
        },
    );
    assert_eq!(saved, Err("磁盘满了"));
    assert!(state.current().on, "保存不成，设置不变");
    assert_eq!(lens.confirm(state.0.safe_mode()), Err(LensStale));
}

#[test]
fn a_stale_lens_reads_as_lens_changed() {
    assert!(matches!(Error::from(LensStale), Error::LensChanged));
}
