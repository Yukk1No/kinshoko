//! 开始记下、结束复核（#526）：命令开始时取的 `Lens`，做完时经 `confirm` 复核。
//! 只经 `SafeModeState` 的对外接口，不启动应用。

use kinshoko_core::library::{Error, SafeMode, SafeModeScope};
use kinshoko_core::safe_mode::{LensStale, SafeModeState};

fn state(on: bool) -> SafeModeState {
    SafeModeState::new(SafeMode::new(on, SafeModeScope::Explicit))
}

#[test]
fn a_lens_holds_while_nothing_changes() {
    let state = state(true);
    let lens = state.lens();
    assert!(lens.on());
    assert_eq!(lens.confirm(&state), Ok(()));
    assert_eq!(lens.confirm(&state), Ok(()), "复核本身不让视角失效");
}

#[test]
fn any_commit_makes_a_lens_stale_even_to_the_same_value() {
    let state = state(true);
    let lens = state.lens();
    state.commit(|mode| mode.on = true);
    assert_eq!(lens.confirm(&state), Err(LensStale));

    let lens = state.lens();
    state.commit(|mode| mode.on = false);
    assert_eq!(lens.confirm(&state), Err(LensStale));
    assert!(!state.lens().on());
}

#[test]
fn revoking_makes_a_lens_stale() {
    let state = state(false);
    let lens = state.lens();
    state.revoke();
    assert_eq!(lens.confirm(&state), Err(LensStale));
    assert_eq!(state.lens().confirm(&state), Ok(()));
}

#[test]
fn expecting_a_different_switch_fails_at_once() {
    let state = state(true);
    assert_eq!(state.lens_expecting(false), Err(LensStale));
    let lens = state.lens_expecting(true).expect("开关一致");
    assert!(lens.on());
    assert_eq!(lens.confirm(&state), Ok(()));
}

#[test]
fn a_failed_save_still_makes_an_earlier_lens_stale() {
    let state = state(true);
    let lens = state.lens();
    let saved: Result<(), &str> = state.try_commit(
        |mode| mode.on = false,
        |_| {
            assert_eq!(lens.confirm(&state), Err(LensStale), "保存前没有作废视角");
            Err("磁盘满了")
        },
    );
    assert_eq!(saved, Err("磁盘满了"));
    assert!(state.current().on, "保存不成，设置不变");
    assert_eq!(lens.confirm(&state), Err(LensStale));
}

#[test]
fn a_stale_lens_reads_as_lens_changed() {
    assert!(matches!(Error::from(LensStale), Error::LensChanged));
}
