//! 普通文件导入：选择的文件与文件夹（含子文件夹）中的 JPEG、PNG、WebP、GIF。
//! 导入时记录色彩描述（#45）。
//!
//! 每项的写入顺序：读取并识别格式 → 完整解码像素 → 哈希 → 同库暂存并完整校验 → 最小 pending 记录 →
//! 发布原文件（按 SHA-256 命名、拒绝覆盖）→ 写线程上一个短事务提交参考图与来源，并在
//! 同一事务里结束 pending。同库已有字节相同的原图时跳过暂存与发布，只合并来源。
//! 文件 I/O 与哈希都在任务线程里，事务里只有 SQL。任何一步中断，重开时由
//! [`super::recovery`] 按 pending 撤回，不留下半张图或幽灵记录。

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use image::ImageFormat;
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};

use super::colour;
use super::events::LibraryEvent;
use super::types::{
    EagleDeletedContentChoice, ImportItem, ImportOptions, ImportOutcome, ImportProgress,
    ImportReport, ImportSource,
};
use super::{Error, Inner, ORIGINALS_DIR, STAGING_DIR, eagle, fault, now_ms, package, tags};
use crate::fidelity::ColourDescription;
use crate::fidelity::inspect::inspect;
use crate::fidelity::render::verify_pixels;

/// 来源标记：普通文件导入。
const SOURCE_FILE: &str = "file";
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
const STALE_EVERY: Duration = Duration::from_millis(500);

/// 进行中的导入任务。进度与结束也通过 [`super::Library::events`] 推送。
pub struct ImportTask {
    id: String,
    cancel: Arc<AtomicBool>,
    progress: Arc<Mutex<ImportProgress>>,
    thread: JoinHandle<ImportReport>,
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
        self.thread.join().unwrap_or_else(|_| ImportReport {
            cancelled: true,
            ..Default::default()
        })
    }
}

pub(super) fn start(inner: Arc<Inner>, source: ImportSource, options: ImportOptions) -> ImportTask {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    let progress = Arc::new(Mutex::new(ImportProgress::default()));
    let thread = {
        let (id, cancel, progress) = (id.clone(), cancel.clone(), progress.clone());
        std::thread::Builder::new()
            .name("kinshoko-import".into())
            .spawn(move || run(&inner, &id, &source, options, &cancel, &progress))
            .expect("无法启动导入线程")
    };
    ImportTask {
        id,
        cancel,
        progress,
        thread,
    }
}

fn run(
    inner: &Inner,
    task_id: &str,
    source: &ImportSource,
    options: ImportOptions,
    cancel: &AtomicBool,
    shared: &Mutex<ImportProgress>,
) -> ImportReport {
    let library_id = inner.info.id.clone();
    let mut report = ImportReport::default();
    let mut files = Vec::new();
    for path in &source.paths {
        collect(inner, path, &mut files, &mut report);
    }

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
    let task_created_images = Arc::new(Mutex::new(HashSet::new()));
    for path in files {
        if cancel.load(Ordering::SeqCst) {
            report.cancelled = true;
            break;
        }
        let (outcome, list_changed) = import_one(inner, &path, options, &task_created_images);
        stale |= list_changed;
        report.items.push(ImportItem { path, outcome });
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

    publish_progress(progress);
    if stale {
        inner.hub.publish(LibraryEvent::ListStale {
            library_id: library_id.clone(),
        });
    }
    inner.hub.publish(LibraryEvent::TaskFinished {
        library_id,
        task_id: task_id.to_owned(),
        report: report.clone(),
    });
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

fn import_one(
    inner: &Inner,
    path: &Path,
    options: ImportOptions,
    task_created_images: &Arc<Mutex<HashSet<String>>>,
) -> (ImportOutcome, bool) {
    let failed = |reason: String| (ImportOutcome::ReadFailed { reason }, false);
    let eagle = if eagle::is_item(path) {
        match eagle::load(inner, path) {
            Ok(item) => Some(item),
            Err(reason) => return failed(reason),
        }
    } else {
        None
    };
    let original = eagle.as_ref().map_or(path, |item| item.original.as_path());
    let bytes = match std::fs::read(original) {
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
    ingest(
        inner,
        &bytes,
        original_name,
        location,
        Origin {
            eagle,
            package: None,
        },
        options,
        task_created_images.clone(),
    )
}

/// 原图从哪里来：普通文件（都为空）、Eagle 条目或参考组包。
struct Origin {
    eagle: Option<eagle::Item>,
    package: Option<package::PackageFacts>,
}

/// 让一份原图字节走完写入顺序：完整解码 → 哈希 → 同库暂存校验 → pending → 发布 → 提交。
fn ingest(
    inner: &Inner,
    bytes: &[u8],
    original_name: String,
    location: String,
    origin: Origin,
    options: ImportOptions,
    task_created_images: Arc<Mutex<HashSet<String>>>,
) -> (ImportOutcome, bool) {
    let failed = |reason: String| (ImportOutcome::ReadFailed { reason }, false);
    let probed = match inspect(bytes) {
        Ok(Some(p)) => p,
        Ok(None) => return (ImportOutcome::Unsupported, false),
        Err(reason) => return failed(format!("无法解码：{reason}")),
    };
    // 文件头有效不代表像素可读：发布前完整解码一遍，坏的作为可重试的读取失败。
    if let Err(reason) = verify_pixels(bytes, &probed) {
        return failed(format!("无法解码：{reason}"));
    }
    let sha = sha256_hex(bytes);
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
        task_created_images,
    };

    // 在暂存前快速跳过；事务提交时再次核对，覆盖导入与永久删除并发的情况。
    if record.eagle.is_some()
        && record.options.eagle_deleted_content == EagleDeletedContentChoice::SkipDeleted
    {
        match skip_deleted(&inner.readers.get(), &record.sha) {
            Ok(true) => return (ImportOutcome::SkippedDeleted, false),
            Ok(false) => {}
            Err(e) => return failed(format!("读取删除记忆失败：{e}")),
        }
    }

    // 同库已有字节相同的原图：不再暂存与发布，直接合并来源。
    if already_stored(inner, &record.sha)
        && !(record.eagle.is_some()
            && record.options.eagle_deleted_content == EagleDeletedContentChoice::AllowThisImport)
    {
        return match commit_record(inner, record, None) {
            Ok(outcome) => outcome,
            Err(e) => failed(format!("写入资料库失败：{e}")),
        };
    }

    let pending = match stage(inner, bytes, &record) {
        Ok(p) => p,
        Err(reason) => return failed(reason),
    };
    fault::hit(fault::IMPORT_AFTER_STAGING);

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
    task_created_images: Arc<Mutex<HashSet<String>>>,
}

fn commit_record(
    inner: &Inner,
    record: Record,
    pending: Option<String>,
) -> Result<(ImportOutcome, bool), Error> {
    let translations = inner.translations();
    let candidate_id = record.id.clone();
    let task_created_images = record.task_created_images.clone();
    let (outcome, revision) = inner
        .writer
        .run(move |conn| commit(conn, record, pending.as_deref(), &translations))?;
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
    Ok((outcome, list_changed))
}

/// 一个短事务：同库字节相同的原图合并为一条记录，来源各自保留；同时结束 pending。
fn commit(
    conn: &mut rusqlite::Connection,
    r: Record,
    pending: Option<&str>,
    translations: &tags::TranslationIndex,
) -> Result<(ImportOutcome, Option<i64>), Error> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
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
                    r.id,
                    r.sha,
                    r.size,
                    r.format,
                    r.rel_path,
                    r.width,
                    r.height,
                    r.orientation,
                    r.original_name,
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
                    image_id: r.id,
                    previous_image_id,
                },
                None => ImportOutcome::Imported { image_id: r.id },
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
        Arc::new(Mutex::new(HashSet::new())),
    )
}
