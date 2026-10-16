//! 活动资料库的 Search 缓存（#76 S1）。Search 本身是纯计算；这里读资料库的词表快照，
//! 按需建立 Search 并复用。
//!
//! 失效约定（与前端候选、#76 S2 的修订号共用）：一个 Search 只对建立它时的
//! **（资料库身份，词表修订号，安全模式）** 有效。
//! - 修订号在可见词表变化时前进（标签写入、删除恢复、分级跨过“含成人内容”）；安全模式
//!   不改修订号，单独作为键的一部分；资料库身份按句柄比较，不跨资料库复用。
//! - 每次查找先核对当前的键，键变了就重建；只读一个修订号，不阻塞长任务。
//! - 事件转发收到变更时调用 [`SearchCache::invalidate`]；构建期间发生过失效的旧构建不写回。
//! - 调用方说明它期望的安全模式；资料库的安全模式不同（界面先切换、后端还没切，或构建期间
//!   切换了）时得到 [`Error::LensChanged`]，不会把另一视角的候选交给界面。

use std::sync::{Arc, Mutex, MutexGuard, Weak};

use super::Search;
use crate::Library;
use crate::approx::BuiltinApproxTable;
use crate::library::{Error, Vocabulary};

/// 活动资料库的 Search 缓存，见模块说明。
#[derive(Default)]
pub struct SearchCache {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// 每次失效加一；构建开始与写回时不同，说明构建期间失效过。
    generation: u64,
    entry: Option<Entry>,
}

struct Entry {
    library: Weak<Library>,
    revision: i64,
    safe_mode: bool,
    search: Arc<Search>,
}

impl SearchCache {
    /// 清掉缓存，并让正在进行的构建不再写回。
    pub fn invalidate(&self) {
        let mut state = self.lock();
        state.generation += 1;
        state.entry = None;
    }

    /// `library` 当前词表上的 Search；`safe_mode` 是调用方期望的安全模式。
    pub fn search(
        &self,
        library: &Arc<Library>,
        builtin: &BuiltinApproxTable,
        safe_mode: bool,
    ) -> Result<Arc<Search>, Error> {
        self.search_with(library, safe_mode, |vocabulary| {
            Search::new(vocabulary, builtin)
        })
    }

    /// 同 [`Self::search`]，由 `build` 从词表快照建立 Search。`build` 在不持锁时调用。
    pub fn search_with(
        &self,
        library: &Arc<Library>,
        safe_mode: bool,
        build: impl FnOnce(&Vocabulary) -> Search,
    ) -> Result<Arc<Search>, Error> {
        if library.safe_mode() != safe_mode {
            return Err(Error::LensChanged);
        }
        let weak = Arc::downgrade(library);
        let revision = library.vocabulary_revision()?;
        let generation = {
            let state = self.lock();
            if let Some(entry) = &state.entry
                && Weak::ptr_eq(&entry.library, &weak)
                && entry.revision == revision
                && entry.safe_mode == safe_mode
            {
                return Ok(entry.search.clone());
            }
            state.generation
        };
        let vocabulary = library.vocabulary()?;
        let search = Arc::new(build(&vocabulary));
        // 构建期间切换了安全模式：快照可能混着两种视角，不交出也不写回。
        if library.safe_mode() != safe_mode {
            return Err(Error::LensChanged);
        }
        let mut state = self.lock();
        if state.generation == generation {
            state.entry = Some(Entry {
                library: weak,
                revision: vocabulary.revision,
                safe_mode,
                search: search.clone(),
            });
        }
        Ok(search)
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}
