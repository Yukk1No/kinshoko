//! 普通文件导入：选择的文件与文件夹（含子文件夹）中的 JPEG、PNG、WebP。
//!
//! 每项的写入顺序：读取并识别格式 → 哈希 → 同库暂存并完整校验 → 最小 pending 记录 →
//! 发布原文件（按 SHA-256 命名、拒绝覆盖）→ 写线程上一个短事务提交参考图与来源，并在
//! 同一事务里结束 pending。同库已有字节相同的原图时跳过暂存与发布，只合并来源。
//! 文件 I/O 与哈希都在任务线程里，事务里只有 SQL。任何一步中断，重开时由
//! [`super::recovery`] 按 pending 撤回，不留下半张图或幽灵记录。

use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use image::{ImageDecoder, ImageFormat, ImageReader, metadata::Orientation};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};

use super::events::LibraryEvent;
use super::types::{ImportItem, ImportOutcome, ImportProgress, ImportReport, ImportSource};
use super::{Error, Inner, ORIGINALS_DIR, STAGING_DIR, eagle, fault, now_ms, tags};

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
            items: Vec::new(),
            cancelled: true,
        })
    }
}

pub(super) fn start(inner: Arc<Inner>, source: ImportSource) -> ImportTask {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    let progress = Arc::new(Mutex::new(ImportProgress::default()));
    let thread = {
        let (id, cancel, progress) = (id.clone(), cancel.clone(), progress.clone());
        std::thread::Builder::new()
            .name("kinshoko-import".into())
            .spawn(move || run(&inner, &id, &source, &cancel, &progress))
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
    cancel: &AtomicBool,
    shared: &Mutex<ImportProgress>,
) -> ImportReport {
    let library_id = inner.info.id.clone();
    let mut report = ImportReport::default();
    let mut files = Vec::new();
    for path in &source.paths {
        collect(inner, path, &mut files, &mut report.items);
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
    for path in files {
        if cancel.load(Ordering::SeqCst) {
            report.cancelled = true;
            break;
        }
        let (outcome, list_changed) = import_one(inner, &path);
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

/// 展开文件夹（含子文件夹，按名称排序）。读不了的位置记为读取失败。
fn collect(inner: &Inner, path: &Path, files: &mut Vec<PathBuf>, failed: &mut Vec<ImportItem>) {
    let fail = |failed: &mut Vec<ImportItem>, e: std::io::Error| {
        failed.push(ImportItem {
            path: path.to_path_buf(),
            outcome: ImportOutcome::ReadFailed {
                reason: e.to_string(),
            },
        })
    };
    if eagle::is_library(path) {
        match eagle::collect(inner, path) {
            Ok(items) => files.extend(items),
            Err(reason) => failed.push(ImportItem {
                path: path.to_path_buf(),
                outcome: ImportOutcome::ReadFailed { reason },
            }),
        }
        return;
    }
    if eagle::is_item(path) {
        files.push(path.to_path_buf());
        return;
    }
    match std::fs::metadata(path) {
        Err(e) => fail(failed, e),
        Ok(meta) if meta.is_dir() => match std::fs::read_dir(path) {
            Err(e) => fail(failed, e),
            Ok(entries) => {
                let mut children: Vec<PathBuf> =
                    entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
                children.sort();
                for child in children {
                    collect(inner, &child, files, failed);
                }
            }
        },
        Ok(_) => files.push(path.to_path_buf()),
    }
}

/// 导入时从文件内容（而不是扩展名）识别出的格式与显示尺寸。
struct Probed {
    format: ImageFormat,
    width: u32,
    height: u32,
    orientation: Orientation,
}

fn probe(bytes: &[u8]) -> Result<Option<Probed>, String> {
    let format = match image::guess_format(bytes) {
        Ok(f @ (ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP)) => f,
        _ => return Ok(None),
    };
    let mut reader = ImageReader::new(Cursor::new(bytes));
    reader.set_format(format);
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let (w, h) = decoder.dimensions();
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let (width, height) = match orientation {
        Orientation::Rotate90
        | Orientation::Rotate270
        | Orientation::Rotate90FlipH
        | Orientation::Rotate270FlipH => (h, w),
        _ => (w, h),
    };
    Ok(Some(Probed {
        format,
        width,
        height,
        orientation,
    }))
}

fn ext(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Png => "png",
        _ => "webp",
    }
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn import_one(inner: &Inner, path: &Path) -> (ImportOutcome, bool) {
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
    let probed = match probe(&bytes) {
        Ok(Some(p)) => p,
        Ok(None) => return (ImportOutcome::Unsupported, false),
        Err(reason) => return failed(format!("无法解码：{reason}")),
    };
    let sha = sha256_hex(&bytes);
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
        original_name: eagle
            .as_ref()
            .map(|item| item.metadata.name.clone())
            .unwrap_or_else(|| {
                path.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            }),
        location: std::path::absolute(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .into_owned(),
        eagle,
    };

    // 同库已有字节相同的原图：不再暂存与发布，直接合并来源。
    if already_stored(inner, &record.sha) {
        return match commit_record(inner, record, None) {
            Ok(outcome) => outcome,
            Err(e) => failed(format!("写入资料库失败：{e}")),
        };
    }

    let pending = match stage(inner, &bytes, &record) {
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
        Ok(outcome) => outcome,
        Err(e) => {
            abandon(inner, pending);
            failed(format!("写入资料库失败：{e}"))
        }
    }
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
    original_name: String,
    location: String,
    eagle: Option<eagle::Item>,
}

fn commit_record(
    inner: &Inner,
    record: Record,
    pending: Option<String>,
) -> Result<(ImportOutcome, bool), Error> {
    let translations = inner.translations();
    let (outcome, revision) = inner
        .writer
        .run(move |conn| commit(conn, record, pending.as_deref(), &translations))?;
    let list_changed = revision.is_some() || matches!(outcome, ImportOutcome::Imported { .. });
    if let Some(revision) = revision {
        let image_id = match &outcome {
            ImportOutcome::Imported { image_id } | ImportOutcome::Merged { image_id } => {
                image_id.clone()
            }
            _ => unreachable!(),
        };
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
    if let Some(item) = &r.eagle {
        let binding: Option<(String, String)> = tx.query_row(
            "SELECT sha256, image_id FROM source_binding WHERE source_id = ?1 AND external_id = ?2",
            params![item.source_id, item.metadata.id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        if let Some((sha, image_id)) = binding {
            if sha != r.sha {
                return Err(Error::EagleReimportRequired);
            }
            if let Some(op) = pending {
                tx.execute("DELETE FROM import_pending WHERE id = ?1", [op])?;
            }
            tx.commit()?;
            return Ok((ImportOutcome::Merged { image_id }, None));
        }
    }
    let existing: Option<String> = tx
        .query_row("SELECT id FROM image WHERE sha256 = ?1", [&r.sha], |row| {
            row.get(0)
        })
        .optional()?;
    let outcome = match existing {
        Some(image_id) => ImportOutcome::Merged { image_id },
        None => {
            tx.execute(
                "INSERT INTO image (id, sha256, size, format, rel_path, width, height,
                                    orientation, original_name, imported_at, collected_at, deleted_at,
                                    eagle_initial_trash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
                    r.eagle.as_ref().map_or(now, |item| item.collected_at(now)),
                    r.eagle.as_ref().and_then(|item| item.deleted_at(now)),
                    r.eagle.as_ref().is_some_and(|item| item.deleted_at(now).is_some())
                ],
            )?;
            ImportOutcome::Imported { image_id: r.id }
        }
    };
    let image_id = match &outcome {
        ImportOutcome::Imported { image_id } | ImportOutcome::Merged { image_id } => image_id,
        _ => unreachable!(),
    };
    let revision = if let Some(item) = &r.eagle {
        Some(eagle::commit(
            &tx,
            translations,
            item,
            &r.sha,
            image_id,
            &r.location,
            now,
        )?)
    } else {
        tx.execute(
            "INSERT OR IGNORE INTO image_source (image_id, source, location, recorded_at)
         VALUES (?1, ?2, ?3, ?4)",
            params![image_id, SOURCE_FILE, r.location, now],
        )?;
        None
    };
    if let Some(op) = pending {
        tx.execute("DELETE FROM import_pending WHERE id = ?1", [op])?;
    }
    fault::hit(fault::IMPORT_BEFORE_COMMIT);
    tx.commit()?;
    Ok((outcome, revision))
}
