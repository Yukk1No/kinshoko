//! 变更事件：只在事务提交后推送。

use std::sync::Mutex;
use std::sync::mpsc::{Receiver, Sender, channel};

use serde::Serialize;
use ts_rs::TS;

use super::types::{ImportProgress, ImportReport};

/// 资料库推送给界面的事件。
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum LibraryEvent {
    /// 有参考图加入或变化，已取得的浏览结果过期，需要重新浏览。
    #[serde(rename_all = "camelCase")]
    ListStale { library_id: String },
    /// 这些参考图的标签等整理结果变了，已取得的详情需要重新读取。
    #[serde(rename_all = "camelCase")]
    ImagesChanged {
        library_id: String,
        image_ids: Vec<String>,
    },
    /// 标签词表（标签、名称、别名、外部对应、分组或计数）变了，附新的修订号。
    #[serde(rename_all = "camelCase")]
    VocabularyChanged {
        library_id: String,
        #[ts(type = "number")]
        revision: i64,
    },
    /// 任务进度。
    #[serde(rename_all = "camelCase")]
    TaskProgress {
        library_id: String,
        task_id: String,
        progress: ImportProgress,
    },
    /// 任务结束（完成或取消），附逐项结果。
    #[serde(rename_all = "camelCase")]
    TaskFinished {
        library_id: String,
        task_id: String,
        report: ImportReport,
    },
}

/// 事件分发：每个订阅者一条通道，断开的订阅者自动移除。
#[derive(Default)]
pub(super) struct Hub {
    subscribers: Mutex<Vec<Sender<LibraryEvent>>>,
}

impl Hub {
    pub(super) fn subscribe(&self) -> Receiver<LibraryEvent> {
        let (tx, rx) = channel();
        self.lock().push(tx);
        rx
    }

    pub(super) fn publish(&self, event: LibraryEvent) {
        self.lock().retain(|tx| tx.send(event.clone()).is_ok());
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Sender<LibraryEvent>>> {
        self.subscribers.lock().unwrap_or_else(|e| e.into_inner())
    }
}
