//! 导入的提交：pending、发布原文件与写库事务，以及参考组包的原图。
use super::*;

/// pending 记录 → 发布原文件 → 提交参考图；任一步失败都撤回这一项。
pub(super) fn publish_and_commit(
    inner: &Inner,
    record: Record,
    pending: Pending,
) -> (ImportOutcome, bool) {
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
pub(super) fn skip_deleted(conn: &rusqlite::Connection, sha: &str) -> Result<bool, Error> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM eagle_deleted_content WHERE sha256 = ?1)
         AND NOT EXISTS (SELECT 1 FROM image WHERE sha256 = ?1)",
        [sha],
        |row| row.get(0),
    )?)
}

pub(super) fn already_stored(inner: &Inner, sha: &str) -> bool {
    let conn = inner.readers.get();
    conn.query_row("SELECT 1 FROM image WHERE sha256 = ?1", [sha], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

/// 同库暂存：写入 `.staging/<操作 id>` 并落盘，重新读出校验。
pub(super) fn stage(inner: &Inner, bytes: &[u8], record: &Record) -> Result<Pending, String> {
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
pub(super) fn publish(inner: &Inner, pending: &Pending) -> Result<(), String> {
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
pub(super) fn publish_no_replace(staging: &Path, target: &Path) -> std::io::Result<()> {
    match std::fs::hard_link(staging, target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists || target.exists() => {
            Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, e))
        }
        Err(_) => std::fs::rename(staging, target),
    }
}

/// 放弃一个未提交的导入项：撤回它发布的原文件与暂存，结束 pending。
pub(super) fn abandon(inner: &Inner, pending: Pending) {
    let root = inner.root.clone();
    let _ = inner
        .writer
        .run(move |conn| crate::library::recovery::undo(conn, &root, &pending));
}

/// 一个导入项的 pending 记录：发布原文件前写入，与参考图同一个事务结束。
#[derive(Clone)]
pub(in crate::library) struct Pending {
    pub(in crate::library) id: String,
    pub(in crate::library) sha: String,
    pub(in crate::library) size: i64,
    pub(in crate::library) staging_path: String,
    pub(in crate::library) rel_path: String,
    pub(in crate::library) target_existed: bool,
    pub(in crate::library) location: String,
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

pub(super) struct Record {
    pub(super) id: String,
    pub(super) sha: String,
    pub(super) size: i64,
    pub(super) format: &'static str,
    pub(super) rel_path: String,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) orientation: u8,
    pub(super) colour: ColourDescription,
    pub(super) original_name: String,
    pub(super) location: String,
    pub(super) eagle: Option<eagle::Item>,
    pub(super) package: Option<package::PackageFacts>,
    pub(super) options: ImportOptions,
    pub(super) destination: SaveDestination,
    pub(super) task_created_images: Arc<Mutex<HashSet<String>>>,
}

pub(super) fn commit_record(
    inner: &Inner,
    record: Record,
    pending: Option<String>,
) -> Result<(ImportOutcome, bool), Error> {
    commit_record_returning(inner, record, pending).0
}

/// 与 [`commit_record`] 相同，并把记录交回：合并时发现原图已被删除（[`Error::MergeTargetGone`]），
/// 调用方要用它重新暂存。
pub(super) fn commit_record_returning(
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
pub(super) fn commit(
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

/// 把参考组包里的一份原图连同快照导入（[`crate::library::Library::import_from_package`]）。
/// 返回进库的结果与浏览列表是否变了；列表过期事件由调用方推送。
pub(in crate::library) fn import_package_original(
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
            source: MergeSource::Bytes(bytes.to_vec()),
        },
        ImportOptions::default(),
        ImportContext {
            destination: destination.unwrap_or_else(|| SaveDestination {
                library_id: inner.info.id.clone(),
                folder_id: None,
            }),
            task_created_images: Arc::new(Mutex::new(HashSet::new())),
            cancel: None,
        },
    )
}
