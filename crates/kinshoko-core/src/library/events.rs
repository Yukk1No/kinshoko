//! 变更事件：只在事务提交后推送。

use std::sync::Mutex;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::time::{Duration, Instant};

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
    /// 安全模式开关变了。浏览结果、计数、词表、候选与详情都要重新读取；
    /// 正在查看的图被封印时回到图片墙。
    #[serde(rename_all = "camelCase")]
    SafeModeChanged { library_id: String, on: bool },
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

/// 把一阵连续的变更事件合并后再转发，直到通道关闭（#142）。
///
/// 自动打标每写一张图都会发出图片与词表变化；界面每收到一次就要重读一遍，后端的阻塞任务越积越多。
/// 这里在 `window` 内只转发一次：一阵变化的第一个事件立即送出，其后的列表过期、图片变化与词表变化
/// 记下来，窗口结束时各送一个（图片取并集，词表取最新修订号）。其他事件先送出记下的变化再立即送出，
/// 保持先后顺序。
pub fn forward_coalesced(
    events: Receiver<LibraryEvent>,
    window: Duration,
    mut emit: impl FnMut(LibraryEvent),
) {
    let mut pending = Pending::default();
    // 当前合并窗口的结束时刻；没有窗口时下一个变化立即送出。
    let mut until: Option<Instant> = None;
    loop {
        let received = match until {
            None => events.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(deadline) => {
                events.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            }
        };
        match received {
            Ok(event) if Pending::merges(&event) => {
                if until.is_some() {
                    pending.add(event);
                } else {
                    emit(event);
                    until = Some(Instant::now() + window);
                }
            }
            Ok(event) => {
                pending.flush(&mut emit);
                emit(event);
            }
            Err(RecvTimeoutError::Timeout) => {
                // 窗口内还有变化：送出后再开一个窗口，持续的写入每个窗口最多推送一次。
                until = (!pending.is_empty()).then(|| Instant::now() + window);
                pending.flush(&mut emit);
            }
            Err(RecvTimeoutError::Disconnected) => {
                pending.flush(&mut emit);
                return;
            }
        }
    }
}

/// 合并窗口里记下、尚未送出的变化。
#[derive(Default)]
struct Pending {
    list_stale: Option<LibraryEvent>,
    images: Option<LibraryEvent>,
    vocabulary: Option<LibraryEvent>,
}

impl Pending {
    fn merges(event: &LibraryEvent) -> bool {
        matches!(
            event,
            LibraryEvent::ListStale { .. }
                | LibraryEvent::ImagesChanged { .. }
                | LibraryEvent::VocabularyChanged { .. }
        )
    }

    fn is_empty(&self) -> bool {
        self.list_stale.is_none() && self.images.is_none() && self.vocabulary.is_none()
    }

    fn add(&mut self, event: LibraryEvent) {
        match event {
            LibraryEvent::ListStale { .. } => self.list_stale = Some(event),
            LibraryEvent::ImagesChanged {
                library_id,
                image_ids,
            } => match &mut self.images {
                Some(LibraryEvent::ImagesChanged {
                    image_ids: merged, ..
                }) => {
                    for id in image_ids {
                        if !merged.contains(&id) {
                            merged.push(id);
                        }
                    }
                }
                _ => {
                    self.images = Some(LibraryEvent::ImagesChanged {
                        library_id,
                        image_ids,
                    })
                }
            },
            LibraryEvent::VocabularyChanged { .. } => self.vocabulary = Some(event),
            _ => unreachable!("只合并列表、图片与词表变化"),
        }
    }

    /// 按资料库写入时的先后送出：列表过期、图片变化、词表变化。
    fn flush(&mut self, emit: &mut impl FnMut(LibraryEvent)) {
        for event in [
            self.list_stale.take(),
            self.images.take(),
            self.vocabulary.take(),
        ]
        .into_iter()
        .flatten()
        {
            emit(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: Duration = Duration::from_millis(200);

    fn vocabulary(revision: i64) -> LibraryEvent {
        LibraryEvent::VocabularyChanged {
            library_id: "L".into(),
            revision,
        }
    }

    fn images(ids: &[&str]) -> LibraryEvent {
        LibraryEvent::ImagesChanged {
            library_id: "L".into(),
            image_ids: ids.iter().map(|id| id.to_string()).collect(),
        }
    }

    /// 在另一个线程里按给定节奏发出事件，转发结果连同到达时刻一起收集。
    fn run(script: Vec<(Duration, LibraryEvent)>) -> Vec<(Duration, LibraryEvent)> {
        let (tx, rx) = channel();
        let start = Instant::now();
        let sender = std::thread::spawn(move || {
            for (delay, event) in script {
                std::thread::sleep(delay);
                tx.send(event).unwrap();
            }
        });
        let mut out = Vec::new();
        forward_coalesced(rx, WINDOW, |event| out.push((start.elapsed(), event)));
        sender.join().unwrap();
        out
    }

    #[test]
    fn an_isolated_change_is_forwarded_at_once() {
        let out = run(vec![(Duration::ZERO, vocabulary(1))]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].1, vocabulary(1));
        assert!(
            out[0].0 < WINDOW / 2,
            "单次修改不应等合并窗口：{:?}",
            out[0].0
        );
    }

    #[test]
    fn a_tagging_burst_is_merged_into_a_few_events_that_carry_the_final_state() {
        // 自动打标每写一张图：标签（图片 + 词表）、分级（图片 + 词表），#142。
        let mut script = Vec::new();
        for n in 0..60 {
            let id = format!("img{n}");
            script.push((Duration::from_millis(3), images(&[&id])));
            script.push((Duration::ZERO, vocabulary(2 * n + 1)));
            script.push((Duration::ZERO, images(&[&id])));
            script.push((Duration::ZERO, vocabulary(2 * n + 2)));
        }
        let out = run(script);
        // 约 180 ms 的一阵写入：开头立即推一次，其余在窗口结束时合并成一批。
        assert!(out.len() <= 6, "推送次数没有合并：{}", out.len());
        assert_eq!(out.last().unwrap().1, vocabulary(120));
        let mut seen: Vec<String> = out
            .iter()
            .flat_map(|(_, event)| match event {
                LibraryEvent::ImagesChanged { image_ids, .. } => image_ids.clone(),
                _ => vec![],
            })
            .collect();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), 60, "合并后不能丢掉变化的图片");
    }

    #[test]
    fn other_events_keep_their_order_after_pending_changes() {
        let finished = LibraryEvent::SafeModeChanged {
            library_id: "L".into(),
            on: true,
        };
        let out = run(vec![
            (Duration::ZERO, vocabulary(1)),
            (Duration::from_millis(5), vocabulary(2)),
            (Duration::from_millis(5), finished.clone()),
        ]);
        let events: Vec<_> = out.into_iter().map(|(_, event)| event).collect();
        assert_eq!(events, vec![vocabulary(1), vocabulary(2), finished]);
    }
}
