use std::sync::{Mutex, MutexGuard};

/// 取锁；持锁的线程 panic 过也照常继续（数据仍可用时用它）。
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
