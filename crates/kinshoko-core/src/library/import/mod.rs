//! 普通文件导入：选择的文件与文件夹（含子文件夹）中的 JPEG、PNG、WebP、GIF。
//! 导入时记录色彩描述（#45）。
//!
//! 每项的写入顺序：读取并识别格式 → 完整解码像素 → 哈希 → 同库暂存并完整校验 → 最小 pending 记录 →
//! 发布原文件（按 SHA-256 命名、拒绝覆盖）→ 写线程上一个短事务提交参考图与来源，并在
//! 同一事务里结束 pending。同库已有字节相同的原图时跳过暂存与发布，只合并来源。
//! 文件 I/O、解码与哈希在任务的准备线程里并行做（完整解码顺带生成占位图，#120）；pending、发布与
//! 提交由任务线程按文件顺序逐项进行，事务里只有 SQL。任何一步中断，重开时由
//! [`super::recovery`] 按 pending 撤回、清掉暂存，不留下半张图或幽灵记录。

use std::cell::RefCell;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use image::ImageFormat;
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};

use super::events::LibraryEvent;
use super::types::{
    EagleDeletedContentChoice, ImportItem, ImportOptions, ImportOutcome, ImportProgress,
    ImportReport, ImportSource,
};
use super::{
    Error, Inner, ORIGINALS_DIR, STAGING_DIR, SaveDestination, eagle, fault, now_ms, package, save,
    tags,
};
use super::{colour, thumbnail};
use crate::CommandError;
use crate::command_error::ErrorKind;
use crate::fidelity::ColourDescription;
use crate::fidelity::budget::{self, BudgetPermit, MemoryBudget};
use crate::fidelity::inspect::inspect;
use crate::fidelity::render::render_sdr_widths;
use crate::fidelity::{DEFAULT_DOWNSCALE, SdrDerivative};

/// 来源标记：普通文件导入。
const SOURCE_FILE: &str = "file";
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
const STALE_EVERY: Duration = Duration::from_millis(500);

/// 一次导入任务各阶段累计的耗时（#120）。供性能检查（`examples/import_stages.rs`）读取，
/// 不进回执、不推送给界面。`scan`、`commit`、`placeholder`、`finish` 是任务线程的墙钟时间；
/// `read`、`decode`、`hash`、`stage` 在准备线程上并行，是各线程耗时之和，可以超过 `total`。
#[derive(Debug, Clone, Copy, Default)]
pub struct ImportStages {
    /// 展开文件夹、列出待导入文件。
    pub scan: Duration,
    /// 读取来源文件字节。
    pub read: Duration,
    /// 识别格式、色彩描述与发布前的完整解码校验。
    pub decode: Duration,
    /// 来源字节的 SHA-256。
    pub hash: Duration,
    /// 同库暂存：写入、落盘、读回校验。
    pub stage: Duration,
    /// pending 记录、发布原文件与提交参考图的事务。
    pub commit: Duration,
    /// 进库后保存占位图与网格缩略图（它们在准备阶段与解码一起生成，计入 `decode`）。
    pub placeholder: Duration,
    /// 处理完全部文件后的最后一次进度、列表过期与结束事件。
    pub finish: Duration,
    /// 整个任务线程的墙钟时间。
    pub total: Duration,
}

impl ImportStages {
    fn add(&mut self, other: &ImportStages) {
        self.scan += other.scan;
        self.read += other.read;
        self.decode += other.decode;
        self.hash += other.hash;
        self.stage += other.stage;
        self.commit += other.commit;
        self.placeholder += other.placeholder;
        self.finish += other.finish;
    }
}

thread_local! {
    static STAGES: RefCell<ImportStages> = RefCell::new(ImportStages::default());
}

/// 计时一段工作并累计到当前线程的阶段表。
fn timed<T>(stage: fn(&mut ImportStages) -> &mut Duration, work: impl FnOnce() -> T) -> T {
    let start = Instant::now();
    let value = work();
    let elapsed = start.elapsed();
    STAGES.with(|stages| *stage(&mut stages.borrow_mut()) += elapsed);
    value
}

/// 进行中的导入任务。进度与结束也通过 [`super::Library::events`] 推送。
pub struct ImportTask {
    id: String,
    cancel: Arc<AtomicBool>,
    progress: Arc<Mutex<ImportProgress>>,
    thread: JoinHandle<(ImportReport, ImportStages)>,
}

impl ImportTask {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// 请求取消。正在处理的一项做完后停止，已成功的项保留。
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn progress(&self) -> ImportProgress {
        *self.progress.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_finished(&self) -> bool {
        self.thread.is_finished()
    }

    /// 等待任务结束，取得逐项结果。
    pub fn wait(self) -> ImportReport {
        self.wait_with_stages().0
    }

    /// 等待任务结束，同时取得各阶段耗时（#120 的分阶段测量）。
    pub fn wait_with_stages(self) -> (ImportReport, ImportStages) {
        self.thread.join().unwrap_or_else(|_| {
            let report = ImportReport {
                cancelled: true,
                ..Default::default()
            };
            (report, ImportStages::default())
        })
    }
}

pub(super) fn start(inner: Arc<Inner>, source: ImportSource, options: ImportOptions) -> ImportTask {
    let destination = SaveDestination {
        library_id: inner.info.id.clone(),
        folder_id: None,
    };
    start_to(inner, source, options, destination)
}

pub(super) fn start_to(
    inner: Arc<Inner>,
    source: ImportSource,
    options: ImportOptions,
    destination: SaveDestination,
) -> ImportTask {
    // 任务开始前登记保存文件夹，结束（含中途出错）时撤下：期间删除这个文件夹会被拒绝。
    let receiving = ReceivingFolder::enter(&inner, destination.folder_id.clone());
    spawn(inner, source, options, destination, receiving)
}

/// 先核对保存位置再开始：核对与登记在删除文件夹用的同一把锁里一起做（见 `folders::delete`），
/// 核对通过的文件夹在导入结束前不会被删掉；文件夹已被删掉时不开始任务，直接报错。
pub(super) fn start_validated(
    inner: Arc<Inner>,
    source: ImportSource,
    options: ImportOptions,
    destination: SaveDestination,
) -> Result<ImportTask, Error> {
    let receiving = ReceivingFolder::enter_validated(&inner, &destination)?;
    Ok(spawn(inner, source, options, destination, receiving))
}

fn spawn(
    inner: Arc<Inner>,
    source: ImportSource,
    options: ImportOptions,
    destination: SaveDestination,
    receiving: ReceivingFolder,
) -> ImportTask {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    let progress = Arc::new(Mutex::new(ImportProgress::default()));
    let thread = {
        let (id, cancel, progress) = (id.clone(), cancel.clone(), progress.clone());
        std::thread::Builder::new()
            .name("kinshoko-import".into())
            .spawn(move || {
                let _receiving = receiving;
                let start = Instant::now();
                STAGES.with(|stages| *stages.borrow_mut() = ImportStages::default());
                let report = run(
                    &inner,
                    &id,
                    &source,
                    options,
                    &destination,
                    &cancel,
                    &progress,
                );
                let mut stages = STAGES.with(|stages| *stages.borrow());
                stages.total = start.elapsed();
                (report, stages)
            })
            .expect("无法启动导入线程")
    };
    ImportTask {
        id,
        cancel,
        progress,
        thread,
    }
}

/// 一个导入任务对保存文件夹的登记；撤下时只去掉自己那一项（同一文件夹可能有几个任务）。
struct ReceivingFolder {
    inner: Arc<Inner>,
    folder: Option<String>,
}

impl ReceivingFolder {
    fn enter(inner: &Arc<Inner>, folder: Option<String>) -> Self {
        if let Some(folder) = &folder {
            inner.receiving_folders().push(folder.clone());
        }
        Self {
            inner: inner.clone(),
            folder,
        }
    }

    /// 在登记表的锁里核对保存位置并登记：与删除文件夹（核对到提交都持有这把锁）不会交错。
    fn enter_validated(inner: &Arc<Inner>, destination: &SaveDestination) -> Result<Self, Error> {
        let mut folders = inner.receiving_folders();
        save::validate(inner, destination)?;
        if let Some(folder) = &destination.folder_id {
            folders.push(folder.clone());
        }
        drop(folders);
        Ok(Self {
            inner: inner.clone(),
            folder: destination.folder_id.clone(),
        })
    }
}

impl Drop for ReceivingFolder {
    fn drop(&mut self) {
        if let Some(folder) = &self.folder {
            let mut folders = self.inner.receiving_folders();
            if let Some(at) = folders.iter().position(|f| f == folder) {
                folders.swap_remove(at);
            }
        }
    }
}

fn run(
    inner: &Inner,
    task_id: &str,
    source: &ImportSource,
    options: ImportOptions,
    destination: &SaveDestination,
    cancel: &Arc<AtomicBool>,
    shared: &Mutex<ImportProgress>,
) -> ImportReport {
    let library_id = inner.info.id.clone();
    let mut report = ImportReport::default();
    let mut files = Vec::new();
    timed(
        |s| &mut s.scan,
        || {
            for path in &source.paths {
                if let Err(error) = save::validate(inner, destination) {
                    report.items.push(ImportItem {
                        path: path.clone(),
                        outcome: ImportOutcome::ReadFailed {
                            reason: destination_unavailable(error),
                        },
                    });
                } else {
                    collect(inner, path, &mut files, &mut report);
                }
            }
        },
    );

    let mut progress = ImportProgress {
        done: report.items.len() as u32,
        total: (report.items.len() + files.len()) as u32,
    };
    let publish_progress = |progress: ImportProgress| {
        *shared.lock().unwrap_or_else(|e| e.into_inner()) = progress;
        inner.hub.publish(LibraryEvent::TaskProgress {
            library_id: library_id.clone(),
            task_id: task_id.to_owned(),
            progress,
        });
    };
    publish_progress(progress);

    let (mut last_progress, mut last_stale) = (Instant::now(), Instant::now());
    let mut stale = false;
    let context = ImportContext {
        destination: destination.clone(),
        task_created_images: Arc::new(Mutex::new(HashSet::new())),
        cancel: Some(cancel.clone()),
    };
    // 读取、解码校验、哈希、暂存与生成占位图互不依赖，由几个工作线程并行做（#120）；
    // pending、发布与提交仍在本线程按文件顺序逐项进行，浏览顺序与逐项结果和串行时相同。
    let mut worker_stages = ImportStages::default();
    let next = AtomicUsize::new(0);
    let progress_gate = CommitGate::default();
    std::thread::scope(|scope| {
        let workers = prepare_workers(files.len());
        // 已准备好、还没轮到提交的项有上限：序号超过“已提交 + 窗口”的项先等提交跟上再准备。
        // 前面某一项特别慢时，后面的项也不会全部提前暂存（内存与取消时要撤回的暂存都有上限）。
        let window = workers * IN_FLIGHT_PER_WORKER;
        let (sender, results) = std::sync::mpsc::sync_channel(window);
        let (files, next, context, progress_gate) = (&files, &next, &context, &progress_gate);
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                let sender = sender.clone();
                scope.spawn(move || {
                    while !cancel.load(Ordering::SeqCst) {
                        let index = next.fetch_add(1, Ordering::SeqCst);
                        let Some(path) = files.get(index) else {
                            break;
                        };
                        if !progress_gate.wait_for(index, window, cancel) {
                            break;
                        }
                        // 某一项让解码器之类的代码 panic 时只算这一项读取失败：否则这一项永远交不出来，
                        // 提交停在它前面，其他准备线程等在提交窗口外，整个任务卡住。
                        let prepared =
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                prepare_file(inner, path, options, context)
                            }))
                            .unwrap_or_else(|_| {
                                Prepared::Done(
                                    ImportOutcome::ReadFailed {
                                        reason: CommandError::new(
                                            ErrorKind::ImportItemFailed,
                                            "处理这一项时出错",
                                        ),
                                    },
                                    false,
                                )
                            });
                        if sender.send((index, prepared)).is_err() {
                            break;
                        }
                    }
                    STAGES.with(|stages| *stages.borrow())
                })
            })
            .collect();
        drop(sender);

        let mut waiting = std::collections::BTreeMap::new();
        let mut committed = 0;
        'items: for (index, prepared) in results.iter() {
            waiting.insert(index, prepared);
            while let Some(prepared) = waiting.remove(&committed) {
                if cancel.load(Ordering::SeqCst) {
                    waiting.insert(committed, prepared);
                    break 'items;
                }
                let (outcome, list_changed) = complete(inner, prepared);
                stale |= list_changed;
                report.items.push(ImportItem {
                    path: files[committed].clone(),
                    outcome,
                });
                committed += 1;
                progress_gate.advance(committed);
                progress.done += 1;

                if last_progress.elapsed() >= PROGRESS_EVERY {
                    publish_progress(progress);
                    last_progress = Instant::now();
                }
                if stale && last_stale.elapsed() >= STALE_EVERY {
                    inner.hub.publish(LibraryEvent::ListStale {
                        library_id: library_id.clone(),
                    });
                    stale = false;
                    last_stale = Instant::now();
                }
            }
        }
        // 取消：工作线程做完手上那一项就停；没轮到提交的项撤回暂存，不进库。
        if committed < files.len() {
            report.cancelled = true;
        }
        for (_, prepared) in waiting.into_iter().chain(results.iter()) {
            prepared.discard(inner);
        }
        for handle in handles {
            worker_stages.add(&handle.join().unwrap_or_default());
        }
    });
    // 准备阶段各项是工作线程耗时之和（并行时可以超过墙钟时间）。
    STAGES.with(|stages| stages.borrow_mut().add(&worker_stages));

    timed(
        |s| &mut s.finish,
        || {
            publish_progress(progress);
            if stale {
                inner.hub.publish(LibraryEvent::ListStale {
                    library_id: library_id.clone(),
                });
            }
            inner.hub.publish(LibraryEvent::TaskFinished {
                library_id: library_id.clone(),
                task_id: task_id.to_owned(),
                report: report.clone(),
            });
        },
    );
    report
}

/// 与 collect 相同的 Eagle 识别边界，预检只读取目录，不提前登记或刷新来源。
mod commit;
mod prepare;
use commit::*;
pub(super) use commit::{Pending, import_package_original};
use prepare::*;
pub(super) use prepare::{contains_eagle, sha256_hex};

#[cfg(test)]
mod tests;

/// 这一项的保存目标此刻不可用。
fn destination_unavailable(error: impl Into<CommandError>) -> CommandError {
    error.into().wrapping(
        |cause| ErrorKind::ImportDestinationUnavailable { cause },
        |text| format!("保存目标不可用：{text}"),
    )
}

/// 这一项没能写进资料库。
fn write_failed(error: impl Into<CommandError>) -> CommandError {
    error.into().wrapping(
        |cause| ErrorKind::ImportWriteFailed { cause },
        |text| format!("写入资料库失败：{text}"),
    )
}
