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
use crate::fidelity::ColourDescription;
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
    cancel: &AtomicBool,
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
                            reason: format!("保存目标不可用：{error}"),
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
                                        reason: "处理这一项时出错".into(),
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
pub(super) fn contains_eagle(source: &ImportSource) -> bool {
    fn contains(path: &Path) -> bool {
        eagle::is_library(path)
            || eagle::is_item(path)
            || (path.is_dir()
                && std::fs::read_dir(path)
                    .is_ok_and(|entries| entries.flatten().any(|entry| contains(&entry.path()))))
    }
    source.paths.iter().any(|path| contains(path))
}

/// 展开文件夹（含子文件夹，按名称排序）。读不了的位置记为读取失败。
fn collect(inner: &Inner, path: &Path, files: &mut Vec<PathBuf>, report: &mut ImportReport) {
    let fail = |report: &mut ImportReport, e: std::io::Error| {
        report.items.push(ImportItem {
            path: path.to_path_buf(),
            outcome: ImportOutcome::ReadFailed {
                reason: e.to_string(),
            },
        })
    };
    if eagle::is_library(path) {
        match eagle::collect(inner, path) {
            Ok(collected) => {
                report.from_eagle = true;
                files.extend(collected.items);
                report.eagle_missing += collected.missing;
            }
            Err(eagle::CollectError::Relocation(proposal)) => {
                report.eagle_relocations.push(proposal);
            }
            Err(eagle::CollectError::Failed(reason)) => report.items.push(ImportItem {
                path: path.to_path_buf(),
                outcome: ImportOutcome::ReadFailed { reason },
            }),
        }
        return;
    }
    if eagle::is_item(path) {
        report.from_eagle = true;
        files.push(path.to_path_buf());
        return;
    }
    match std::fs::metadata(path) {
        Err(e) => fail(report, e),
        Ok(meta) if meta.is_dir() => match std::fs::read_dir(path) {
            Err(e) => fail(report, e),
            Ok(entries) => {
                let mut children: Vec<PathBuf> =
                    entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
                children.sort();
                for child in children {
                    collect(inner, &child, files, report);
                }
            }
        },
        Ok(_) => files.push(path.to_path_buf()),
    }
}

fn ext(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Png => "png",
        ImageFormat::Gif => "gif",
        _ => "webp",
    }
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// 准备一个文件：读取、识别并完整解码、哈希、同库暂存，并用同一次解码生成占位图。只做文件 I/O 与计算，
/// 不写资料库，可以在工作线程上并行；提交由 [`complete`] 按顺序完成。
fn prepare_file(
    inner: &Inner,
    path: &Path,
    options: ImportOptions,
    context: &ImportContext,
) -> Prepared {
    let failed = |reason: String| Prepared::Done(ImportOutcome::ReadFailed { reason }, false);
    if let Err(error) = save::validate(inner, &context.destination) {
        return failed(format!("保存目标不可用：{error}"));
    }
    let eagle = if eagle::is_item(path) {
        match eagle::load(inner, path) {
            Ok(item) => Some(item),
            Err(reason) => return failed(reason),
        }
    } else {
        None
    };
    let original = eagle.as_ref().map_or(path, |item| item.original.as_path());
    let bytes = match timed(|s| &mut s.read, || std::fs::read(original)) {
        Ok(b) => b,
        Err(e) => return failed(e.to_string()),
    };
    if let Some(item) = &eagle
        && item.metadata.size != bytes.len() as u64
    {
        return failed("Eagle 条目的 size 与原文件字节数不符".into());
    }
    let original_name = eagle
        .as_ref()
        .map(|item| item.metadata.name.clone())
        .unwrap_or_else(|| {
            path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
    let location = match &eagle {
        Some(item) => item.location.clone(),
        None => std::path::absolute(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .into_owned(),
    };
    prepare(
        inner,
        &bytes,
        original_name,
        location,
        Origin {
            eagle,
            package: None,
        },
        options,
        context,
    )
}

/// 原图从哪里来：普通文件（都为空）、Eagle 条目或参考组包。
struct Origin {
    eagle: Option<eagle::Item>,
    package: Option<package::PackageFacts>,
}

/// Fixed destination and task-local journal are carried together through ingestion.
struct ImportContext {
    destination: SaveDestination,
    task_created_images: Arc<Mutex<HashSet<String>>>,
}

/// 准备好、等待按顺序提交的一项。
enum Prepared {
    /// 不用写资料库就有结果：读取失败、不支持的格式、跳过已删除的内容。
    Done(ImportOutcome, bool),
    /// 同库已有字节相同的原图：不暂存，提交时只合并来源。保留字节：轮到提交前那份原图若被永久删除，
    /// 提交时用它重新暂存。
    Merge {
        record: Record,
        bytes: Vec<u8>,
        derivatives: Derivatives,
    },
    /// 已暂存：提交时写 pending、发布原文件并提交。
    Staged {
        record: Record,
        pending: Pending,
        derivatives: Derivatives,
    },
}

/// 导入时与校验像素同一次解码生成的派生图，进库后再保存进缓存。生成失败的那一份为空，
/// 浏览时按需重建（占位图由打开资料库时的后台补齐，网格缩略图由 `thumb` 协议现场生成）。
struct Derivatives {
    placeholder: Option<SdrDerivative>,
    /// 网格缩略图与它的档位（#123）。
    grid: Option<(u32, SdrDerivative)>,
}

impl Derivatives {
    fn store(&self, root: &Path, sha: &str) {
        if let Some(placeholder) = &self.placeholder {
            let _ = thumbnail::store_placeholder(root, sha, placeholder);
        }
        if let Some((px, grid)) = &self.grid {
            let _ = thumbnail::store_grid(root, sha, *px, grid);
        }
    }
}

impl Prepared {
    /// 不再提交（任务取消）：撤回暂存文件。还没有 pending 记录，不需要别的善后。
    fn discard(self, inner: &Inner) {
        if let Prepared::Staged { pending, .. } = self {
            let _ = std::fs::remove_file(inner.root.join(&pending.staging_path));
        }
    }
}

/// 已按顺序提交了几项；准备线程据此不跑到提交前面太远。
#[derive(Default)]
struct CommitGate {
    committed: Mutex<usize>,
    advanced: std::sync::Condvar,
}

impl CommitGate {
    fn advance(&self, committed: usize) {
        *self.committed.lock().unwrap_or_else(|e| e.into_inner()) = committed;
        self.advanced.notify_all();
    }

    /// 等到第 `index` 项落在提交窗口内；任务取消时返回 `false`。
    fn wait_for(&self, index: usize, window: usize, cancel: &AtomicBool) -> bool {
        let mut committed = self.committed.lock().unwrap_or_else(|e| e.into_inner());
        while index >= *committed + window {
            if cancel.load(Ordering::SeqCst) {
                return false;
            }
            // 取消不经过这把锁，定时醒来看一眼。
            committed = self
                .advanced
                .wait_timeout(committed, Duration::from_millis(50))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        true
    }
}

/// 同时在解码的原图像素上限（全进程）。管线按 RGBA f32 解码、转正与缩放，峰值约每像素 48 字节，
/// 32 MP 约 1.5 GB：常见参考图仍能几张并行；超过上限的一张单独解码（与串行时相同的峰值）。
const DECODE_BUDGET_PIXELS: u64 = 32_000_000;

static DECODE_BUDGET: DecodeBudget = DecodeBudget {
    in_use: Mutex::new(0),
    released: std::sync::Condvar::new(),
};

/// 并行准备时的解码内存预算：按原图像素数计，不按线程数。
struct DecodeBudget {
    in_use: Mutex<u64>,
    released: std::sync::Condvar,
}

impl DecodeBudget {
    /// 等到预算够用再占用；单张超过上限时，等其他解码都结束后独占。
    fn acquire(&'static self, pixels: u64) -> DecodePermit {
        let pixels = pixels.min(DECODE_BUDGET_PIXELS);
        let mut in_use = self.in_use.lock().unwrap_or_else(|e| e.into_inner());
        while *in_use + pixels > DECODE_BUDGET_PIXELS {
            in_use = self
                .released
                .wait(in_use)
                .unwrap_or_else(|e| e.into_inner());
        }
        *in_use += pixels;
        DecodePermit {
            budget: self,
            pixels,
        }
    }
}

struct DecodePermit {
    budget: &'static DecodeBudget,
    pixels: u64,
}

impl Drop for DecodePermit {
    fn drop(&mut self) {
        *self.budget.in_use.lock().unwrap_or_else(|e| e.into_inner()) -= self.pixels;
        self.budget.released.notify_all();
    }
}

/// 同时准备的线程数：留一个核给提交与界面，最多 8 个；文件很少时不多开。
fn prepare_workers(files: usize) -> usize {
    let cores = std::thread::available_parallelism().map_or(2, |n| n.get());
    cores.saturating_sub(1).clamp(1, 8).min(files.max(1))
}

/// 每个准备线程最多领先提交几项。
const IN_FLIGHT_PER_WORKER: usize = 4;

/// 让一份原图字节走完写入顺序（参考组包导入用），进库后保存占位图（#110）。
/// 占位图是可重建缓存：生成失败不影响导入结果，打开资料库时的后台补齐会再试。
fn ingest(
    inner: &Inner,
    bytes: &[u8],
    original_name: String,
    location: String,
    origin: Origin,
    options: ImportOptions,
    context: ImportContext,
) -> (ImportOutcome, bool) {
    if let Err(error) = save::validate(inner, &context.destination) {
        return (
            ImportOutcome::ReadFailed {
                reason: format!("保存目标不可用：{error}"),
            },
            false,
        );
    }
    let prepared = prepare(
        inner,
        bytes,
        original_name,
        location,
        origin,
        options,
        &context,
    );
    complete(inner, prepared)
}

/// 完整解码（同时生成占位图）→ 哈希 → 同库暂存校验。pending、发布与提交留给 [`complete`]。
fn prepare(
    inner: &Inner,
    bytes: &[u8],
    original_name: String,
    location: String,
    origin: Origin,
    options: ImportOptions,
    context: &ImportContext,
) -> Prepared {
    let failed = |reason: String| Prepared::Done(ImportOutcome::ReadFailed { reason }, false);
    let probed = match timed(|s| &mut s.decode, || inspect(bytes)) {
        Ok(Some(p)) => p,
        Ok(None) => return Prepared::Done(ImportOutcome::Unsupported, false),
        Err(reason) => return failed(format!("无法解码：{reason}")),
    };
    // 文件头有效不代表像素可读：发布前完整解码一遍，坏的作为可重试的读取失败。
    // 同一次解码顺带生成占位图（#120）与图片墙要用的网格缩略图（#123）：提交后不再重读原文件解码，
    // 浏览时也不必在滚动中现场生成。
    let placeholder_width = thumbnail::placeholder_width(probed.width, probed.height);
    let grid_px = thumbnail::grid_tier();
    let derivatives = match timed(
        |s| &mut s.decode,
        || {
            let _pixels = DECODE_BUDGET.acquire(u64::from(probed.width) * u64::from(probed.height));
            render_sdr_widths(
                bytes,
                &probed,
                &[placeholder_width, grid_px],
                DEFAULT_DOWNSCALE,
            )
        },
    ) {
        Ok(rendered) => {
            let mut rendered = rendered.into_iter().map(Result::ok);
            let placeholder = rendered.next().flatten();
            let grid = rendered.next().flatten().map(|grid| (grid_px, grid));
            Derivatives { placeholder, grid }
        }
        Err(reason) => return failed(format!("无法解码：{reason}")),
    };
    let sha = timed(|s| &mut s.hash, || sha256_hex(bytes));
    if let Some(facts) = &origin.package
        && facts.snapshot.sha256 != sha
    {
        return failed("与参考组包记录的 SHA-256 不符".into());
    }
    let rel_path = format!("{ORIGINALS_DIR}/{}/{sha}.{}", &sha[..2], ext(probed.format));
    let record = Record {
        id: uuid::Uuid::now_v7().simple().to_string(),
        sha,
        size: bytes.len() as i64,
        format: ext(probed.format),
        rel_path,
        width: probed.width,
        height: probed.height,
        orientation: probed.orientation.to_exif(),
        colour: probed.description,
        original_name,
        location,
        eagle: origin.eagle,
        package: origin.package,
        options,
        destination: context.destination.clone(),
        task_created_images: context.task_created_images.clone(),
    };

    // 在暂存前快速跳过；事务提交时再次核对，覆盖导入与永久删除并发的情况。
    if record.eagle.is_some()
        && record.options.eagle_deleted_content == EagleDeletedContentChoice::SkipDeleted
    {
        match skip_deleted(&inner.readers.get(), &record.sha) {
            Ok(true) => return Prepared::Done(ImportOutcome::SkippedDeleted, false),
            Ok(false) => {}
            Err(e) => return failed(format!("读取删除记忆失败：{e}")),
        }
    }

    // 同库已有字节相同的原图：不再暂存与发布，直接合并来源。
    if already_stored(inner, &record.sha)
        && !(record.eagle.is_some()
            && record.options.eagle_deleted_content == EagleDeletedContentChoice::AllowThisImport)
    {
        return Prepared::Merge {
            record,
            bytes: bytes.to_vec(),
            derivatives,
        };
    }

    match timed(|s| &mut s.stage, || stage(inner, bytes, &record)) {
        Ok(pending) => Prepared::Staged {
            record,
            pending,
            derivatives,
        },
        Err(reason) => failed(reason),
    }
}

/// 按顺序提交准备好的一项，进库后保存占位图与网格缩略图。提交前由 [`commit_record`] 再核对一次保存目标。
fn complete(inner: &Inner, prepared: Prepared) -> (ImportOutcome, bool) {
    let (result, derivatives, sha) = match prepared {
        Prepared::Done(outcome, list_changed) => return (outcome, list_changed),
        Prepared::Merge {
            record,
            bytes,
            derivatives,
        } => {
            let sha = record.sha.clone();
            let (committed, record) = timed(
                |s| &mut s.commit,
                || commit_record_returning(inner, record, None),
            );
            let result = match committed {
                Ok(outcome) => outcome,
                // 准备之后、提交之前同内容的原图被永久删除：按新图重新暂存并发布。
                Err(Error::MergeTargetGone) => match stage(inner, &bytes, &record) {
                    Ok(pending) => timed(
                        |s| &mut s.commit,
                        || publish_and_commit(inner, record, pending),
                    ),
                    Err(reason) => (ImportOutcome::ReadFailed { reason }, false),
                },
                Err(e) => (
                    ImportOutcome::ReadFailed {
                        reason: format!("写入资料库失败：{e}"),
                    },
                    false,
                ),
            };
            (result, derivatives, sha)
        }
        Prepared::Staged {
            record,
            pending,
            derivatives,
        } => {
            let sha = record.sha.clone();
            // 按提交顺序命中：这一项已暂存、还没有 pending 记录（后面的项可能也已暂存）。
            fault::hit(fault::IMPORT_AFTER_STAGING);
            let result = timed(
                |s| &mut s.commit,
                || publish_and_commit(inner, record, pending),
            );
            (result, derivatives, sha)
        }
    };
    if result.0.image_id().is_some() {
        timed(
            |s| &mut s.placeholder,
            || derivatives.store(&inner.root, &sha),
        );
    }
    result
}

/// pending 记录 → 发布原文件 → 提交参考图；任一步失败都撤回这一项。
fn publish_and_commit(inner: &Inner, record: Record, pending: Pending) -> (ImportOutcome, bool) {
    let failed = |reason: String| (ImportOutcome::ReadFailed { reason }, false);
    let row = pending.clone();
    if let Err(e) = inner.writer.run(move |conn| row.insert(conn)) {
        let _ = std::fs::remove_file(inner.root.join(&pending.staging_path));
        return failed(format!("写入资料库失败：{e}"));
    }
    fault::hit(fault::IMPORT_AFTER_PENDING);

    if let Err(reason) = publish(inner, &pending) {
        abandon(inner, pending);
        return failed(reason);
    }
    fault::hit(fault::IMPORT_AFTER_PUBLISH);

    match commit_record(inner, record, Some(pending.id.clone())) {
        Ok(outcome) => {
            if matches!(outcome.0, ImportOutcome::SkippedDeleted) {
                abandon(inner, pending);
            }
            outcome
        }
        Err(e) => {
            abandon(inner, pending);
            failed(format!("写入资料库失败：{e}"))
        }
    }
}

/// 记忆只挡住没有本库副本的内容；明确允许后，已有活图和回收站仍正常刷新来源信息。
fn skip_deleted(conn: &rusqlite::Connection, sha: &str) -> Result<bool, Error> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM eagle_deleted_content WHERE sha256 = ?1)
         AND NOT EXISTS (SELECT 1 FROM image WHERE sha256 = ?1)",
        [sha],
        |row| row.get(0),
    )?)
}

fn already_stored(inner: &Inner, sha: &str) -> bool {
    let conn = inner.readers.get();
    conn.query_row("SELECT 1 FROM image WHERE sha256 = ?1", [sha], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

/// 同库暂存：写入 `.staging/<操作 id>` 并落盘，重新读出校验。
fn stage(inner: &Inner, bytes: &[u8], record: &Record) -> Result<Pending, String> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let staging_path = format!("{STAGING_DIR}/{id}");
    let staging = inner.root.join(&staging_path);
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create_new(&staging)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if sha256_hex(&std::fs::read(&staging)?) != record.sha {
            return Err(std::io::Error::other("暂存文件校验不一致"));
        }
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&staging);
        return Err(e.to_string());
    }
    Ok(Pending {
        id,
        sha: record.sha.clone(),
        size: record.size,
        staging_path,
        target_existed: inner.root.join(&record.rel_path).exists(),
        rel_path: record.rel_path.clone(),
        location: record.location.clone(),
    })
}

/// 发布暂存文件到按哈希命名的位置，从不覆盖。目标已存在且内容相同则直接复用。
fn publish(inner: &Inner, pending: &Pending) -> Result<(), String> {
    let staging = inner.root.join(&pending.staging_path);
    let target = inner.root.join(&pending.rel_path);
    let result = (|| -> Result<(), String> {
        std::fs::create_dir_all(target.parent().expect("原文件路径有父目录"))
            .map_err(|e| e.to_string())?;
        match publish_no_replace(&staging, &target) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                match std::fs::read(&target) {
                    Ok(existing) if sha256_hex(&existing) == pending.sha => Ok(()),
                    Ok(_) => Err("资料库中同名原文件内容不符".into()),
                    Err(e) => Err(e.to_string()),
                }
            }
            Err(e) => Err(e.to_string()),
        }
    })();
    let _ = std::fs::remove_file(&staging);
    result
}

/// 把 `staging` 放到 `target`，目标已存在时返回 `AlreadyExists`。
/// 优先用硬链接（原子地拒绝覆盖）；文件系统不支持硬链接（如 exFAT）时退回先查后改名。
fn publish_no_replace(staging: &Path, target: &Path) -> std::io::Result<()> {
    match std::fs::hard_link(staging, target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists || target.exists() => {
            Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, e))
        }
        Err(_) => std::fs::rename(staging, target),
    }
}

/// 放弃一个未提交的导入项：撤回它发布的原文件与暂存，结束 pending。
fn abandon(inner: &Inner, pending: Pending) {
    let root = inner.root.clone();
    let _ = inner
        .writer
        .run(move |conn| super::recovery::undo(conn, &root, &pending));
}

/// 一个导入项的 pending 记录：发布原文件前写入，与参考图同一个事务结束。
#[derive(Clone)]
pub(super) struct Pending {
    pub(super) id: String,
    pub(super) sha: String,
    pub(super) size: i64,
    pub(super) staging_path: String,
    pub(super) rel_path: String,
    pub(super) target_existed: bool,
    pub(super) location: String,
}

impl Pending {
    fn insert(&self, conn: &mut rusqlite::Connection) -> rusqlite::Result<()> {
        conn.execute(
            "INSERT INTO import_pending (id, sha256, size, staging_path, rel_path,
                                         target_existed, location, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                self.id,
                self.sha,
                self.size,
                self.staging_path,
                self.rel_path,
                self.target_existed,
                self.location,
                now_ms()
            ],
        )?;
        Ok(())
    }
}

struct Record {
    id: String,
    sha: String,
    size: i64,
    format: &'static str,
    rel_path: String,
    width: u32,
    height: u32,
    orientation: u8,
    colour: ColourDescription,
    original_name: String,
    location: String,
    eagle: Option<eagle::Item>,
    package: Option<package::PackageFacts>,
    options: ImportOptions,
    destination: SaveDestination,
    task_created_images: Arc<Mutex<HashSet<String>>>,
}

fn commit_record(
    inner: &Inner,
    record: Record,
    pending: Option<String>,
) -> Result<(ImportOutcome, bool), Error> {
    commit_record_returning(inner, record, pending).0
}

/// 与 [`commit_record`] 相同，并把记录交回：合并时发现原图已被删除（[`Error::MergeTargetGone`]），
/// 调用方要用它重新暂存。
fn commit_record_returning(
    inner: &Inner,
    record: Record,
    pending: Option<String>,
) -> (Result<(ImportOutcome, bool), Error>, Record) {
    if let Err(error) = save::validate(inner, &record.destination) {
        return (Err(error), record);
    }
    let translations = inner.translations();
    let authority = inner.write_revoked.clone();
    let candidate_id = record.id.clone();
    let task_created_images = record.task_created_images.clone();
    // Package snapshots (including cross-library copy) can change an existing image's
    // effective rating. Acquire before queuing the writer job: acquiring inside that job
    // would invert the scheduler's gate -> writer order. Ordinary/Eagle tasks never write
    // rating facts and must not wait on this gate while unregister settles their workers.
    let gate = record.package.as_ref().and_then(|_| {
        inner
            .package_publication_gate
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    });
    let (committed, record) = {
        let _publication = gate
            .as_ref()
            .map(|gate| gate.lock().unwrap_or_else(|e| e.into_inner()));
        inner.writer.run(move |conn| {
            let committed = save::validate_authority(&authority)
                .and_then(|()| commit(conn, &record, pending.as_deref(), &translations));
            (committed, record)
        })
    };
    let (outcome, revision) = match committed {
        Ok(committed) => committed,
        Err(error) => return (Err(error), record),
    };
    if outcome.image_id() == Some(candidate_id.as_str()) {
        task_created_images
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(candidate_id);
    }
    let list_changed = revision.is_some()
        || matches!(
            outcome,
            ImportOutcome::Imported { .. } | ImportOutcome::NewVersion { .. }
        );
    if let Some(revision) = revision {
        let image_id = outcome
            .image_id()
            .expect("写入了来源事实的结果都有参考图")
            .to_owned();
        inner.hub.publish(LibraryEvent::ImagesChanged {
            library_id: inner.info.id.clone(),
            image_ids: vec![image_id],
        });
        inner.hub.publish(LibraryEvent::VocabularyChanged {
            library_id: inner.info.id.clone(),
            revision,
        });
    }
    (Ok((outcome, list_changed)), record)
}

/// 一个短事务：同库字节相同的原图合并为一条记录，来源各自保留；同时结束 pending。
fn commit(
    conn: &mut rusqlite::Connection,
    r: &Record,
    pending: Option<&str>,
    translations: &tags::TranslationIndex,
) -> Result<(ImportOutcome, Option<i64>), Error> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    save::validate_folder(&tx, &r.destination)?;
    let now = now_ms();
    if r.eagle.is_some()
        && r.options.eagle_deleted_content == EagleDeletedContentChoice::SkipDeleted
        && skip_deleted(&tx, &r.sha)?
    {
        // pending 留给调用方撤回；中断时由下次打开资料库的对账撤回。
        return Ok((ImportOutcome::SkippedDeleted, None));
    }
    // Eagle 条目已迁入过：内容相同只刷新来源层；内容变了，新内容作为新版本进库。
    let mut previous = None;
    if let Some(item) = &r.eagle {
        match eagle::existing(&tx, item, &r.sha)? {
            eagle::Existing::Bound {
                image_id,
                unchanged,
            } => {
                let revision = if unchanged {
                    None
                } else {
                    Some(eagle::commit(
                        &tx,
                        translations,
                        item,
                        &r.sha,
                        &image_id,
                        &r.location,
                        eagle::CommitContext {
                            now,
                            created_in_this_task: r
                                .task_created_images
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .contains(&image_id),
                        },
                    )?)
                };
                if let Some(op) = pending {
                    tx.execute("DELETE FROM import_pending WHERE id = ?1", [op])?;
                }
                let in_trash: bool = tx.query_row(
                    "SELECT deleted_at IS NOT NULL FROM image WHERE id = ?1",
                    [&image_id],
                    |row| row.get(0),
                )?;
                let outcome = if in_trash {
                    ImportOutcome::TrashDuplicate { image_id }
                } else {
                    ImportOutcome::Refreshed { image_id }
                };
                save::assign(
                    &tx,
                    &r.destination,
                    outcome.image_id().expect("import outcome"),
                )?;
                fault::hit(fault::IMPORT_BEFORE_COMMIT);
                tx.commit()?;
                return Ok((outcome, revision));
            }
            eagle::Existing::Changed { previous_image_id } => previous = Some(previous_image_id),
            eagle::Existing::New => {}
        }
    }
    let existing: Option<String> = tx
        .query_row("SELECT id FROM image WHERE sha256 = ?1", [&r.sha], |row| {
            row.get(0)
        })
        .optional()?;
    // 准备时判定为合并（没有暂存这份字节），到提交时那份原图却已被永久删除：不能插一条指向已删文件的
    // 记录，交回调用方用保留的字节重新暂存（#120）。
    if pending.is_none() && existing.is_none() {
        return Err(Error::MergeTargetGone);
    }
    let was_duplicate = existing.is_some();
    let outcome = match existing {
        Some(image_id) => match previous {
            Some(previous_image_id) => {
                tx.execute(
                    "UPDATE image SET previous_image_id = ?1
                     WHERE id = ?2 AND previous_image_id IS NULL",
                    params![previous_image_id, image_id],
                )?;
                ImportOutcome::NewVersion {
                    image_id,
                    previous_image_id,
                }
            }
            None => ImportOutcome::Merged { image_id },
        },
        None => {
            tx.execute(
                "INSERT INTO image (id, sha256, size, format, rel_path, width, height,
                                    orientation, original_name, imported_at, collected_at, deleted_at,
                                    eagle_initial_trash, previous_image_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    &r.id,
                    &r.sha,
                    r.size,
                    r.format,
                    &r.rel_path,
                    r.width,
                    r.height,
                    r.orientation,
                    &r.original_name,
                    now,
                    match (&r.eagle, &r.package) {
                        (Some(item), _) => item.collected_at(now),
                        (None, Some(facts)) => facts.snapshot.collected_at,
                        (None, None) => now,
                    },
                    r.eagle.as_ref().and_then(|item| item.deleted_at(now)),
                    r.eagle.as_ref().is_some_and(|item| item.deleted_at(now).is_some()),
                    previous
                ],
            )?;
            colour::record(&tx, &r.id, &r.colour)?;
            match previous {
                Some(previous_image_id) => ImportOutcome::NewVersion {
                    image_id: r.id.clone(),
                    previous_image_id,
                },
                None => ImportOutcome::Imported {
                    image_id: r.id.clone(),
                },
            }
        }
    };
    let image_id = outcome.image_id().expect("进库的结果都有参考图");
    let revision = if let Some(item) = &r.eagle {
        Some(eagle::commit(
            &tx,
            translations,
            item,
            &r.sha,
            image_id,
            &r.location,
            eagle::CommitContext {
                now,
                created_in_this_task: r
                    .task_created_images
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .contains(image_id),
            },
        )?)
    } else if let Some(facts) = &r.package {
        Some(package::commit(&tx, translations, facts, image_id, now)?)
    } else {
        tx.execute(
            "INSERT OR IGNORE INTO image_source (image_id, source, location, recorded_at)
         VALUES (?1, ?2, ?3, ?4)",
            params![image_id, SOURCE_FILE, r.location, now],
        )?;
        None
    };
    save::assign(&tx, &r.destination, image_id)?;
    let outcome = if was_duplicate
        && r.eagle.is_some()
        && tx.query_row(
            "SELECT deleted_at IS NOT NULL FROM image WHERE id = ?1",
            [image_id],
            |row| row.get::<_, bool>(0),
        )? {
        ImportOutcome::TrashDuplicate {
            image_id: image_id.to_owned(),
        }
    } else {
        outcome
    };
    if let Some(op) = pending {
        tx.execute("DELETE FROM import_pending WHERE id = ?1", [op])?;
    }
    fault::hit(fault::IMPORT_BEFORE_COMMIT);
    tx.commit()?;
    Ok((outcome, revision))
}

/// 把参考组包里的一份原图连同快照导入（[`super::Library::import_from_package`]）。
/// 返回进库的结果与浏览列表是否变了；列表过期事件由调用方推送。
pub(super) fn import_package_original(
    inner: &Inner,
    origin: package::PackageOrigin,
    bytes: &[u8],
    snapshot: package::ImageSnapshot,
    destination: Option<SaveDestination>,
) -> (ImportOutcome, bool) {
    let (original_name, location) = (snapshot.original_name.clone(), origin.location.clone());
    ingest(
        inner,
        bytes,
        original_name,
        location,
        Origin {
            eagle: None,
            package: Some(package::PackageFacts { origin, snapshot }),
        },
        ImportOptions::default(),
        ImportContext {
            destination: destination.unwrap_or_else(|| SaveDestination {
                library_id: inner.info.id.clone(),
                folder_id: None,
            }),
            task_created_images: Arc::new(Mutex::new(HashSet::new())),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoGroups;
    impl crate::reference_groups::ReferenceGroupUsage for NoGroups {
        fn groups_using(
            &self,
            _: &str,
            _: &[String],
        ) -> Result<Vec<crate::reference_groups::GroupUsage>, crate::reference_groups::GroupError>
        {
            Ok(Vec::new())
        }
    }

    #[test]
    fn a_merge_whose_original_is_deleted_before_its_turn_is_staged_again() {
        use super::super::{ImageEdit, Library};
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("a.png");
        image::RgbaImage::from_fn(16, 12, |x, y| image::Rgba([x as u8, y as u8, 90, 255]))
            .save(&png)
            .unwrap();
        let library = Library::create(&dir.path().join("lib"), "库").unwrap();
        let first = library
            .import(ImportSource {
                paths: vec![png.clone()],
            })
            .wait()
            .items[0]
            .outcome
            .image_id()
            .unwrap()
            .to_owned();
        let inner = &library.inner;
        let context = ImportContext {
            destination: SaveDestination {
                library_id: inner.info.id.clone(),
                folder_id: None,
            },
            task_created_images: Arc::default(),
        };
        // 准备时同库已有这份内容：判定为合并，不暂存。
        let prepared = prepare_file(inner, &png, ImportOptions::default(), &context);
        assert!(matches!(prepared, Prepared::Merge { .. }));

        // 轮到提交之前，那份原图被移进回收站并永久删除。
        library
            .edit(std::slice::from_ref(&first), &[ImageEdit::Delete])
            .unwrap();
        let preview = library
            .preview_permanent_delete(std::slice::from_ref(&first), &NoGroups)
            .unwrap();
        library
            .permanent_delete(&[first], &preview.token, &NoGroups)
            .unwrap();

        // 提交时重新暂存并发布：作为新图进库，记录指向的原文件确实存在。
        let (outcome, _) = complete(inner, prepared);
        let ImportOutcome::Imported { image_id } = outcome else {
            panic!("应作为新图重新进库：{outcome:?}");
        };
        assert!(library.original_path(&image_id).unwrap().is_file());
    }

    fn budget() -> &'static DecodeBudget {
        Box::leak(Box::new(DecodeBudget {
            in_use: Mutex::new(0),
            released: std::sync::Condvar::new(),
        }))
    }

    #[test]
    fn decodes_over_the_pixel_budget_wait_until_earlier_ones_finish() {
        let budget = budget();
        let first = budget.acquire(DECODE_BUDGET_PIXELS / 2);
        let second = budget.acquire(DECODE_BUDGET_PIXELS / 2);
        let (sender, entered) = std::sync::mpsc::channel();
        let third = std::thread::spawn(move || {
            let _permit = budget.acquire(1);
            sender.send(()).unwrap();
        });
        assert!(entered.recv_timeout(Duration::from_millis(100)).is_err());
        drop(first);
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        third.join().unwrap();
        drop(second);
    }

    #[test]
    fn an_image_larger_than_the_budget_still_decodes_alone() {
        let budget = budget();
        drop(budget.acquire(DECODE_BUDGET_PIXELS * 4));
        assert_eq!(*budget.in_use.lock().unwrap(), 0);
    }
}
