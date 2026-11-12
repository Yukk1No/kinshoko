//! 取 `Mutex` 的写法，以及锁中毒（持锁线程 panic 过）后怎么办。
//!
//! 本层现有两种策略：
//!
//! - **中毒后照常继续**：用 [`lock`]。数据在 panic 之后仍然可用，或者丢一次更新比整个功能停摆更好的状态，
//!   现状是 `backup.rs`、`desktop/`、`library.rs`、`tagging.rs`、`updater.rs`、`subscription/`、`fidelity_gate/` 里各自的状态都用它。
//! - **中毒后把错误交给界面**：`ShellState` 的锁用 `.lock().map_err(CommandError::system)?`
//!   （`commands.rs` 起共 21 处）。为什么只有它用这一种：原因未查明
//!   （`git log -S"map_err(CommandError::system)" -- src-tauri/src/commands.rs` 只查到后来的改写提交，没有说明）。
//!
//! 另有两处只读一个值的 `.lock().map(..).unwrap_or(false)`（`subscription/mod.rs`），中毒时按“没有”处理，不走 [`lock`]。
//!
//! 要改某把锁的策略，在对应改动里单独写明理由，不要顺手换写法。

use std::sync::{Mutex, MutexGuard};

/// 取锁；持锁的线程 panic 过也照常继续（数据仍可用时用它）。
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
