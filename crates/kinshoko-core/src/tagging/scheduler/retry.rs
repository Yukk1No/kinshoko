//! 打不上标的图重新待打标（#475）：启动时重试反复崩溃的图，画师要求时两类都重试。
use super::*;

impl Worker {
    /// 让打不上标的图重新待打标（#475）：画师要求过重试（[`Tagging::retry_failed`]）时，各库两类都重试，
    /// 打不开或没清掉的库记着，下次再试；否则每个库在本次运行第一次轮到时，只重试反复崩溃的图一次。
    pub(super) fn retry_failed(&mut self, source: &FactSource) {
        let src = source.as_str().to_owned();
        if std::mem::take(&mut self.shared.control().retry_failed) {
            // 这一轮的崩溃次数从头算。
            self.crashes.clear();
            let ids = self.libraries.library_ids();
            self.retry_asked
                .extend(ids.into_iter().map(|id| (id, src.clone())));
        }
        for id in self.libraries.library_ids() {
            let key = (id, src.clone());
            let asked = self.retry_asked.contains(&key);
            if !asked && self.crash_retried.contains(&key) {
                continue;
            }
            let Ok(library) = self.libraries.writer(&key.0) else {
                continue;
            };
            let which = if asked {
                RetryTagging::AllFailed
            } else {
                RetryTagging::CrashedOnly
            };
            if library.retry_failed_tagging(source, which).is_ok() {
                self.retry_asked.remove(&key);
                self.crash_retried.insert(key);
            }
        }
    }
}
