//! 导入的准备：收集文件、读取、解码、哈希与暂存，按顺序提交前的每一项。
use super::*;

pub(in crate::library) fn contains_eagle(source: &ImportSource) -> bool {
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
pub(super) fn collect(
    inner: &Inner,
    path: &Path,
    files: &mut Vec<PathBuf>,
    report: &mut ImportReport,
) {
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

pub(super) fn ext(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Png => "png",
        ImageFormat::Gif => "gif",
        _ => "webp",
    }
}

pub(in crate::library) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// 准备一个文件：读取、识别并完整解码、哈希、同库暂存，并用同一次解码生成占位图。只做文件 I/O 与计算，
/// 不写资料库，可以在工作线程上并行；提交由 [`complete`] 按顺序完成。
pub(super) fn prepare_file(
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
    let source = MergeSource::File(original.to_path_buf());
    // 读进来的字节一直留到这一项准备完，先按文件大小占用读取预算。
    let size = match std::fs::metadata(original) {
        Ok(meta) => meta.len(),
        Err(e) => return failed(e.to_string()),
    };
    let Some(_read) = READ_BUDGET.acquire(size, context.cancel.as_deref()) else {
        return failed("导入已取消".into());
    };
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
            subscription: None,
            source,
        },
        options,
        context,
    )
}

/// 原图从哪里来：普通文件（都为空）、Eagle 条目、参考组包或订阅。
pub(super) struct Origin {
    pub(super) eagle: Option<eagle::Item>,
    pub(super) package: Option<package::PackageFacts>,
    pub(super) subscription: Option<SubscriptionPage>,
    /// 合并项若要重新暂存，从哪里再取这份字节。
    pub(super) source: MergeSource,
}

/// Fixed destination and task-local journal are carried together through ingestion.
pub(super) struct ImportContext {
    pub(super) destination: SaveDestination,
    pub(super) task_created_images: Arc<Mutex<HashSet<String>>>,
    /// 任务的取消标记；等解码预算时据此放弃（参考组包导入逐张同步进行，没有）。
    pub(super) cancel: Option<Arc<AtomicBool>>,
}

/// 合并项提交时若要重新暂存，从哪里取字节。普通文件与 Eagle 条目重读原文件，不在等待提交时占着内存；
/// 参考组包的原图在包里，逐张同步导入，直接保留这一份。
pub(super) enum MergeSource {
    File(PathBuf),
    Bytes(Vec<u8>),
}

impl MergeSource {
    /// 重新取字节，并核对仍是准备时那份内容。重读原文件时与准备线程一样先占用读取预算，
    /// 调用方持有返回的占用直到暂存完。
    fn bytes(self, sha: &str) -> Result<(Vec<u8>, Option<BudgetPermit>), String> {
        let (bytes, permit) = match self {
            MergeSource::Bytes(bytes) => (bytes, None),
            MergeSource::File(path) => {
                let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
                let permit = READ_BUDGET.acquire(size, None);
                (std::fs::read(path).map_err(|e| e.to_string())?, permit)
            }
        };
        if sha256_hex(&bytes) != sha {
            return Err("原文件在导入过程中变了".into());
        }
        Ok((bytes, permit))
    }
}

/// 准备好、等待按顺序提交的一项。
pub(super) enum Prepared {
    /// 不用写资料库就有结果：读取失败、不支持的格式、跳过已删除的内容。
    Done(ImportOutcome, bool),
    /// 同库已有字节相同的原图：不暂存，提交时只合并来源。轮到提交前那份原图若被永久删除，
    /// 提交时从 `source` 重新取字节暂存。
    Merge {
        record: Record,
        source: MergeSource,
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
pub(super) struct Derivatives {
    placeholder: Option<SdrDerivative>,
    /// 网格缩略图与它的档位（#123）。
    grid: Option<(u32, SdrDerivative)>,
}

impl Derivatives {
    fn store(&self, inner: &Inner, sha: &str) {
        if let Some(placeholder) = &self.placeholder {
            let _ = thumbnail::store_placeholder(inner, sha, placeholder);
        }
        if let Some((px, grid)) = &self.grid {
            let _ = thumbnail::store_grid(&inner.root, sha, *px, grid);
        }
    }
}

impl Prepared {
    /// 不再提交（任务取消）：撤回暂存文件。还没有 pending 记录，不需要别的善后。
    pub(super) fn discard(self, inner: &Inner) {
        if let Prepared::Staged { pending, .. } = self {
            let _ = std::fs::remove_file(inner.root.join(&pending.staging_path));
        }
    }
}

/// 已按顺序提交了几项；准备线程据此不跑到提交前面太远。
#[derive(Default)]
pub(super) struct CommitGate {
    committed: Mutex<usize>,
    advanced: std::sync::Condvar,
}

impl CommitGate {
    pub(super) fn advance(&self, committed: usize) {
        *self.committed.lock().unwrap_or_else(|e| e.into_inner()) = committed;
        self.advanced.notify_all();
    }

    /// 等到第 `index` 项落在提交窗口内；任务取消时返回 `false`。
    pub(super) fn wait_for(&self, index: usize, window: usize, cancel: &AtomicBool) -> bool {
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

/// 同时读进内存、还在准备中的原文件字节上限（全进程）。读文件前先占用，准备完这一项才放开：
/// 几个准备线程不会同时攥着多份很大的原文件；超过上限的一份单独读（与串行时相同）。
pub(super) const READ_BUDGET_BYTES: u64 = 512 * 1024 * 1024;

pub(super) static READ_BUDGET: MemoryBudget = MemoryBudget::new(READ_BUDGET_BYTES);

/// 同时准备的线程数：留一个核给提交与界面，最多 8 个；文件很少时不多开。
pub(super) fn prepare_workers(files: usize) -> usize {
    let cores = std::thread::available_parallelism().map_or(2, |n| n.get());
    cores.saturating_sub(1).clamp(1, 8).min(files.max(1))
}

/// 每个准备线程最多领先提交几项。
pub(super) const IN_FLIGHT_PER_WORKER: usize = 4;

/// 让一份原图字节走完写入顺序（参考组包导入用），进库后保存占位图（#110）。
/// 占位图是可重建缓存：生成失败不影响导入结果，打开资料库时的后台补齐会再试。
pub(super) fn ingest(
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
pub(super) fn prepare(
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
    let Some(decode) = budget::reserve_decode(&probed, context.cancel.as_deref()) else {
        // 任务已取消：这一项不会提交，不再解码。
        return failed("导入已取消".into());
    };
    let derivatives = match timed(
        |s| &mut s.decode,
        || {
            render_sdr_widths(
                &decode,
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
    drop(decode);
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
        subscription: origin.subscription,
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
            source: origin.source,
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
pub(super) fn complete(inner: &Inner, prepared: Prepared) -> (ImportOutcome, bool) {
    let (result, derivatives, sha) = match prepared {
        Prepared::Done(outcome, list_changed) => return (outcome, list_changed),
        Prepared::Merge {
            record,
            source,
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
                Err(Error::MergeTargetGone) => match source
                    .bytes(&record.sha)
                    .and_then(|(bytes, _read)| stage(inner, &bytes, &record))
                {
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
        timed(|s| &mut s.placeholder, || derivatives.store(inner, &sha));
    }
    result
}
