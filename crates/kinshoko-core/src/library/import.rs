//! 普通文件导入：选择的文件与文件夹（含子文件夹）中的 JPEG、PNG、WebP。
//!
//! 每项的写入顺序：读取并识别格式 → 哈希 → 同库暂存并重新校验 → 发布原文件
//! （按 SHA-256 命名、拒绝覆盖）→ 写线程上一个短事务提交参考图与来源。
//! 文件 I/O 与哈希都在任务线程里，事务里只有 SQL。
//! 崩溃后的 pending 对账由 #46 补上。

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
use super::{Inner, ORIGINALS_DIR, STAGING_DIR, now_ms};

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
        collect(path, &mut files, &mut report.items);
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
        let outcome = import_one(inner, &path);
        stale |= matches!(outcome, ImportOutcome::Imported { .. });
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
fn collect(path: &Path, files: &mut Vec<PathBuf>, failed: &mut Vec<ImportItem>) {
    let fail = |failed: &mut Vec<ImportItem>, e: std::io::Error| {
        failed.push(ImportItem {
            path: path.to_path_buf(),
            outcome: ImportOutcome::ReadFailed {
                reason: e.to_string(),
            },
        })
    };
    match std::fs::metadata(path) {
        Err(e) => fail(failed, e),
        Ok(meta) if meta.is_dir() => match std::fs::read_dir(path) {
            Err(e) => fail(failed, e),
            Ok(entries) => {
                let mut children: Vec<PathBuf> =
                    entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
                children.sort();
                for child in children {
                    collect(&child, files, failed);
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

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn import_one(inner: &Inner, path: &Path) -> ImportOutcome {
    let failed = |reason: String| ImportOutcome::ReadFailed { reason };
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => return failed(e.to_string()),
    };
    let probed = match probe(&bytes) {
        Ok(Some(p)) => p,
        Ok(None) => return ImportOutcome::Unsupported,
        Err(reason) => return failed(format!("无法解码：{reason}")),
    };
    let sha = sha256_hex(&bytes);
    let rel_path = format!("{ORIGINALS_DIR}/{}/{sha}.{}", &sha[..2], ext(probed.format));
    if let Err(reason) = publish(inner, &bytes, &sha, &rel_path) {
        return failed(reason);
    }

    let record = Record {
        id: uuid::Uuid::now_v7().simple().to_string(),
        sha,
        size: bytes.len() as i64,
        format: ext(probed.format),
        rel_path,
        width: probed.width,
        height: probed.height,
        orientation: probed.orientation.to_exif(),
        original_name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        location: std::path::absolute(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .into_owned(),
    };
    match inner.writer.run(move |conn| commit(conn, record)) {
        Ok(outcome) => outcome,
        Err(e) => failed(format!("写入资料库失败：{e}")),
    }
}

/// 同库暂存、重新校验，再按哈希发布。目标已存在且内容相同则直接复用；从不覆盖。
fn publish(inner: &Inner, bytes: &[u8], sha: &str, rel_path: &str) -> Result<(), String> {
    let target = inner.root.join(rel_path);
    if target.is_file() {
        return match std::fs::read(&target) {
            Ok(existing) if sha256_hex(&existing) == sha => Ok(()),
            Ok(_) => Err("资料库中同名原文件内容不符".into()),
            Err(e) => Err(e.to_string()),
        };
    }
    let staging = inner
        .root
        .join(STAGING_DIR)
        .join(uuid::Uuid::new_v4().simple().to_string());
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create_new(&staging)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if sha256_hex(&std::fs::read(&staging)?) != sha {
            return Err(std::io::Error::other("暂存文件校验不一致"));
        }
        std::fs::create_dir_all(target.parent().expect("原文件路径有父目录"))?;
        if target.exists() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "原文件已存在",
            ));
        }
        std::fs::rename(&staging, &target)
    })();
    let _ = std::fs::remove_file(&staging);
    result.map_err(|e| e.to_string())
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
}

/// 一个短事务：同库字节相同的原图合并为一条记录，来源各自保留。
fn commit(conn: &mut rusqlite::Connection, r: Record) -> rusqlite::Result<ImportOutcome> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let now = now_ms();
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
                                    orientation, original_name, imported_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
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
                    now
                ],
            )?;
            ImportOutcome::Imported { image_id: r.id }
        }
    };
    let image_id = match &outcome {
        ImportOutcome::Imported { image_id } | ImportOutcome::Merged { image_id } => image_id,
        _ => unreachable!(),
    };
    tx.execute(
        "INSERT OR IGNORE INTO image_source (image_id, source, location, recorded_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![image_id, SOURCE_FILE, r.location, now],
    )?;
    tx.commit()?;
    Ok(outcome)
}
